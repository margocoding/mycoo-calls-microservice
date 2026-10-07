# MyCOO calls

Private NestJS gateway for self-hosted LiveKit with cloud Yandex SpeechKit or SaluteSpeech recognition. Meeting records, permissions, invitations, the processing queue and approved tasks live in `mycoo-crm-api`. The browser receives only a short room token, never service credentials.

## Run

Node.js 22+, FFmpeg/ffprobe, a LiveKit server, and (for recording) LiveKit Egress with a private S3-compatible bucket are required.

```sh
npm ci
cp .env.example .env
npm run build
NODE_EXTRA_CA_CERTS=./certs/russian_trusted_root_ca_pem.crt npm start
```

Configure `CALLS_SERVICE_SECRET` with the same random value of at least 32 characters in this service and the main API. The main API also needs `CALLS_SERVICE_URL` pointing to this service. Apply its `20261004190000_meetings_livekit` migration before starting the updated API. Existing main API Redis and GigaChat settings are reused.

Set `LIVEKIT_URL` to the server API endpoint and `LIVEKIT_PUBLIC_URL` to the browser-reachable WebSocket endpoint (`wss://` in production). Use the same LiveKit API key/secret for this gateway and Egress. Configure LiveKit's signed webhook destination as `https://<calls-host>/webhooks/livekit`; `MYCOO_EVENTS_URL` must point to the main API's private `/api/meetings/events` endpoint. The root certificate in `certs/` is the public CA copied from the main API; TLS verification stays enabled. Node must receive `NODE_EXTRA_CA_CERTS` before startup.

Expose `/health` and `/webhooks/livekit` through the calls proxy. Keep `/rooms/*` private to the main API. Do not enable remote unmute in LiveKit. This gateway issues 60-second join tokens without room-admin grants; a signed join webhook rechecks membership, admission and meeting status and removes unauthorized reconnects. Self-hosted LiveKit does not revoke previously issued JWTs: keep the webhook reachable and monitor delivery failures. A very short reconnect window can exist before this check completes.

For recording set all `RECORDINGS_S3_*` settings and configure an Egress worker separately. The bucket must remain private; playback links expire after 5 minutes. Its endpoint must be reachable by Egress, this service, and browsers opening signed playback links. Room composite recording produces MP4. FFmpeg extracts mono audio: OGG/Opus at 16 kbit/s for Yandex, 16 kHz FLAC for SaluteSpeech. Temporary media is removed after upload completes; source downloads are limited to 2 GB. Allow 18 minutes on the private transcription API connection. Multiple long meetings require appropriate worker/disk capacity. Storage configuration is independent of the speech provider.

## Speech provider

Set `SPEECH_PROVIDER=yandex` to use asynchronous SpeechKit API v3. This is a paid cloud service; no local speech model or GPU is required.

1. Activate a Yandex Cloud billing account (`ACTIVE` or `TRIAL_ACTIVE`) and link the service account's cloud to it. Create a service account with the `ai.speechkit-stt.user` role in its folder.
2. Create an API key with the `yc.ai.speechkitStt.execute` scope. Store its secret value (not the key ID) in `YANDEX_SPEECHKIT_API_KEY` in this service's private `.env` or deployment secrets. Do not put it in the frontend, the main API, Git or a `VITE_*` variable.
3. Restart the calls service. Without the key, the service can start but recognition fails before downloading a recording.

If SpeechKit returns `403 PermissionDenied` for a folder, check that the key's service account has `ai.speechkit-stt.user` on the folder where that account was created. The API key scope must also permit speech recognition; a key by itself does not grant resource access.

Also verify that the cloud is linked to an active billing account; creating a billing account alone does not establish this link. After activation, a request may still fail while the changes propagate. If a recognition operation has already been accepted, keep its ID and retry polling instead of submitting the same audio again.

The adapter sends audio directly as base64 to `POST /stt/v3/recognizeFileAsync`, persists the operation ID through the main API, checks `operation.api.cloud.yandex.net`, and reads the transcript from `GET /stt/v3/getRecognition`. No public recording URL or Yandex-specific Object Storage bucket is required for speech recognition; the existing private recording storage is still needed for recording/playback. Service-account authentication uses `Authorization: Api-Key ...`; no folder ID or manually refreshed IAM token is needed. Allow outbound HTTPS to `stt.api.cloud.yandex.net` and `operation.api.cloud.yandex.net`; TLS verification remains enabled.

Recordings must be at most 4 hours. The gateway checks duration with ffprobe and limits converted audio to 44 MB so the base64 request stays below the API's 60 MB limit. Longer/larger recordings fail without silent truncation. SpeechKit retains results for 3 days; keep the main API worker running so completed results are saved in the database. Partial hypotheses are ignored and normalized segments replace their raw versions. Empty recognition, malformed responses and network errors use the existing bounded retry flow; protocols still require human review before tasks are created.

For an existing SaluteSpeech account set `SPEECH_PROVIDER=salute`, `SALUTE_SPEECH_CREDENTIALS` to its authorization key and `SALUTE_SPEECH_SCOPE` to its project scope. This is separate from GigaChat credentials. SaluteSpeech uses FLAC (up to 1 GB). If `SPEECH_PROVIDER` is omitted, existing deployments with SaluteSpeech credentials retain that provider; otherwise Yandex is selected. Set it explicitly to avoid ambiguity. There is no automatic fallback to another provider.

`SpeechService` isolates provider authentication, submission and result handling. Switching between the implemented providers only requires their corresponding settings; meeting permissions, review and task creation stay the same. REST contract tests use simulated Yandex responses. Before production use, check the deployed recording pipeline end to end: record a short Russian meeting, stop the recording, verify the saved transcript and review the resulting protocol. A successful direct audio recognition test does not validate LiveKit Egress or recording storage.

## API

All `/rooms/:room` routes require `Authorization: Bearer <CALLS_SERVICE_SECRET>`. A room name starts with `meeting_`.

| Method/path | Purpose |
| --- | --- |
| `POST /rooms/:room/token` | `{identity,name,screenShare}` → limited token + WebSocket URL |
| `GET /rooms/:room/participants` | Connected participants and tracks |
| `POST /rooms/:room/participant` | `{identity,action,screenShare}`; remove, mute, permissions |
| `DELETE /rooms/:room` | End the room, idempotently |
| `GET/POST /rooms/:room/recordings` | List / start recording |
| `POST /rooms/:room/recordings/stop` | Stop active recordings |
| `POST /rooms/:room/recordings/url` | `{key}` → temporary private playback URL |
| `POST /rooms/:room/recordings/transcribe` | `{key,uploadId?,taskId?}` → next durable STT step |

Yandex returns `{taskId}` on submission, then `{taskId}` while pending and `{taskId,text}` when done. SaluteSpeech returns an upload ID first, then a task ID, then the transcript. The main API persists cloud IDs and resumes polling after restarts. Yandex IDs have a `yandex_` prefix; SaluteSpeech IDs have a `salute_` prefix and legacy unprefixed IDs remain supported. Existing jobs keep using their original provider after changing the setting for new recordings (keep its credentials until these jobs finish). Failed jobs retain the recording and expose an explicit retry. A connection failure after the provider accepts a request but before its ID is persisted can cause resubmission; this integration does not guarantee exactly-once billing. The application never creates tasks until a manager confirms a reviewed protocol; publication is transactional and idempotent.

## Checks and deployment

```sh
npm run lint
npm run build
npm test
npm audit --audit-level=high
docker build -t mycoo-calls .
```

`Calls CI` runs on every branch push and PR to main: lint, build, tests, secret/dependency scans, Docker build, container health check, and Trivy. Dockerfile and workflows follow the main API's pattern; this service has no Prisma migrations of its own. The runtime includes FFmpeg and runs as the `node` user.

`Calls CD` is **manual**, restricted to `main`, and uses the `production` environment. Configure `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` and server-side compose/environment before running it. It publishes `ghcr.io/<owner>/<repo>:latest` and the commit tag, then runs `docker compose pull` / `up -d` in the configured directory. Configure an approval rule for the production environment if needed. Neither this repository nor CI contains production credentials. LiveKit, Redis for LiveKit/Egress, TURN/TLS, S3 and server networking are configured separately.

References: [LiveKit server SDK](https://docs.livekit.io/reference/server-sdk-js/), [self-hosted Egress](https://docs.livekit.io/transport/self-hosting/egress/), [SaluteSpeech authentication](https://developers.sber.ru/docs/ru/salutespeech/api/authentication), [async recognition](https://developers.sber.ru/docs/ru/salutespeech/rest/post-async-speech-recognition).

SpeechKit references: [API v3 request](https://aistudio.yandex.ru/ru/docs/speechkit/stt-v3/api-ref/AsyncRecognizer/recognizeFile), [asynchronous results](https://aistudio.yandex.ru/ru/docs/speechkit/stt/api/transcribation-api-v3), [authentication](https://aistudio.yandex.ru/ru/docs/speechkit/concepts/auth), [limits](https://aistudio.yandex.ru/ru/docs/speechkit/concepts/limits), [pricing](https://aistudio.yandex.ru/ru/docs/speechkit/pricing).
