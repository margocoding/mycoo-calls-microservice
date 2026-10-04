# MyCOO calls

Private NestJS gateway for self-hosted LiveKit and SaluteSpeech. Meeting records, permissions, invitations, the processing queue and approved tasks live in `mycoo-crm-api`. The browser receives only a short room token, never service credentials.

## Run

Node.js 22+, FFmpeg, a LiveKit server, and (for recording) LiveKit Egress with a private S3-compatible bucket are required.

```sh
npm ci
cp .env.example .env
npm run build
NODE_EXTRA_CA_CERTS=./certs/russian_trusted_root_ca_pem.crt npm start
```

Configure `CALLS_SERVICE_SECRET` with the same random value of at least 32 characters in this service and the main API. The main API also needs `CALLS_SERVICE_URL` pointing to this service. Apply its `20261004190000_meetings_livekit` migration before starting the updated API. Existing main API Redis and GigaChat settings are reused.

Set `LIVEKIT_URL` to the server API endpoint and `LIVEKIT_PUBLIC_URL` to the browser-reachable WebSocket endpoint (`wss://` in production). Use the same LiveKit API key/secret for this gateway and Egress. Configure LiveKit's signed webhook destination as `https://<calls-host>/webhooks/livekit`; `MYCOO_EVENTS_URL` must point to the main API's private `/api/meetings/events` endpoint. The root certificate in `certs/` is the public CA copied from the main API; TLS verification stays enabled. Node must receive `NODE_EXTRA_CA_CERTS` before startup.

Expose `/health` and `/webhooks/livekit` through the calls proxy. Keep `/rooms/*` private to the main API. Do not enable remote unmute in LiveKit. This gateway issues 60-second join tokens without room-admin grants; a signed join webhook rechecks membership, admission and meeting status and removes unauthorized reconnects. Self-hosted LiveKit does not revoke previously issued JWTs: keep the webhook reachable and monitor delivery failures. A very short reconnect window can exist before this check completes.

For recording set all `RECORDINGS_S3_*` settings and configure an Egress worker separately. The bucket must remain private; playback links expire after 5 minutes. Its endpoint must be reachable by Egress, this service, and browsers opening signed playback links. Room composite recording produces MP4. FFmpeg extracts mono 16 kHz FLAC for SaluteSpeech. Temporary media is removed after each attempt; downloads are limited to 2 GB and recognition audio to 1 GB. A conversion/upload request may take up to 18 minutes; allow this on the private API connection. Multiple long meetings require appropriate worker/disk capacity.

Set `SALUTE_SPEECH_CREDENTIALS` to the SaluteSpeech authorization key and `SALUTE_SPEECH_SCOPE` to the project's scope (`SALUTE_SPEECH_PERS`, `SALUTE_SPEECH_CORP` or `SALUTE_SPEECH_B2B`). This is separate from GigaChat credentials. New SaluteSpeech connections are restricted by the provider; verify availability for the existing project before rollout.

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

Recognition returns an upload ID first, then a task ID, then the transcript when done. The main API persists each ID and resumes polling after restarts. Failed jobs retain the recording and expose an explicit retry. There is no provider idempotency key for an async start; a connection failure after the provider accepts it but before its ID is persisted can cause a repeated recognition request. The application never creates tasks until a manager confirms a reviewed protocol; publication is transactional and idempotent.

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
