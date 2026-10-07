import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessToken, TrackSource, TokenVerifier } from "livekit-server-sdk";
import { LivekitService } from "./livekit.service.js";
import { ServiceGuard } from "./service.guard.js";
import { RecordingsService } from "./recordings.service.js";
import type { SpeechService } from "./speech.service.js";
import {
  SaluteSpeechService,
  transcriptText,
} from "./salute-speech.service.js";
import type { ExecutionContext } from "@nestjs/common";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Internal calls API", () => {
  it("rejects missing, short and incorrect service credentials", () => {
    const guard = new ServiceGuard();
    const ctx = (authorization?: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization } }),
        }),
      }) as ExecutionContext;
    vi.stubEnv("CALLS_SERVICE_SECRET", "a".repeat(40));
    expect(() => guard.canActivate(ctx())).toThrow();
    expect(() => guard.canActivate(ctx("Bearer " + "b".repeat(40)))).toThrow();
    expect(guard.canActivate(ctx("Bearer " + "a".repeat(40)))).toBe(true);
    vi.stubEnv("CALLS_SERVICE_SECRET", "short");
    expect(() => guard.canActivate(ctx("Bearer short"))).toThrow();
  });
  it("issues a short room-scoped token without room administration or screen share", async () => {
    vi.stubEnv("LIVEKIT_URL", "http://127.0.0.1:7880");
    vi.stubEnv("LIVEKIT_API_KEY", "local-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "local-secret-for-tests");
    const service = new LivekitService();
    vi.spyOn(service as any, "rooms").mockReturnValue({
      createRoom: vi.fn().mockResolvedValue({}),
    });
    const { token } = await service.token("meeting_one", {
      identity: "user1",
      name: "Иван",
      screenShare: false,
    });
    const claims = await new TokenVerifier(
      "local-key",
      "local-secret-for-tests",
    ).verify(token);
    expect(claims.sub).toBe("user1");
    expect(claims.video?.room).toBe("meeting_one");
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.video?.canPublishSources).not.toContain("screen_share");
    expect(claims.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(
      59,
    );
    expect(claims.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
  });
  it("only mutes microphones and never remotely unmutes", async () => {
    const service = new LivekitService(),
      mute = vi.fn();
    vi.spyOn(service as any, "rooms").mockReturnValue({
      mutePublishedTrack: mute,
    });
    vi.spyOn(service, "participants").mockResolvedValue([
      {
        identity: "user1",
        name: "Иван",
        tracks: [
          { sid: "audio", source: TrackSource.MICROPHONE, muted: false },
          { sid: "video", source: TrackSource.CAMERA, muted: false },
        ],
      },
    ]);
    await service.participant("meeting_one", {
      identity: "user1",
      action: "mute",
      screenShare: false,
    });
    expect(mute).toHaveBeenCalledExactlyOnceWith(
      "meeting_one",
      "user1",
      "audio",
      true,
    );
  });
  it("does not forward unverified webhooks", async () => {
    vi.stubEnv("LIVEKIT_URL", "http://localhost");
    vi.stubEnv("LIVEKIT_API_KEY", "local-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "local-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(new LivekitService().event("{}", "invalid")).rejects.toThrow(
      "Invalid LiveKit signature",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the webhook payload hash as well as the JWT", async () => {
    vi.stubEnv("LIVEKIT_URL", "http://localhost");
    vi.stubEnv("LIVEKIT_API_KEY", "key");
    vi.stubEnv("LIVEKIT_API_SECRET", "secret");
    const token = new AccessToken("key", "secret");
    token.sha256 = "incorrect";
    await expect(
      new LivekitService().event("{}", await token.toJwt()),
    ).rejects.toThrow("Invalid LiveKit signature");
  });
});
describe("Private recordings and durable recognition", () => {
  const speech = { result: vi.fn(), start: vi.fn(), upload: vi.fn() };
  it("rejects another meeting recording and path traversal before accessing storage", async () => {
    const store = new RecordingsService(speech as unknown as SpeechService);
    for (const key of [
      "meetings/meeting_other/a.mp4",
      "meetings/meeting_one/../a.mp4",
      "https://example.com/a.mp4",
    ])
      await expect(store.transcribe("meeting_one", { key })).rejects.toThrow(
        "Invalid recording key",
      );
  });
  it("resumes an existing recognition task without uploading or starting another", async () => {
    speech.result.mockResolvedValue({ taskId: "task1", text: "Готово" });
    await new RecordingsService(speech as unknown as SpeechService).transcribe(
      "meeting_one",
      { key: "meetings/meeting_one/a.mp4", taskId: "task1" },
    );
    expect(speech.result).toHaveBeenCalledWith("task1");
    expect(speech.upload).not.toHaveBeenCalled();
    expect(speech.start).not.toHaveBeenCalled();
  });
  it("parses each segment once using only its best hypothesis", () => {
    expect(
      transcriptText([
        {
          results: [
            { text: "первый", normalized_text: "Первый." },
            { text: "другая версия" },
          ],
        },
        { results: [] },
        { results: [{ text: "Второй." }] },
      ]),
    ).toBe("Первый.\nВторой.");
    expect(() => transcriptText({ text: "unexpected format" })).toThrow();
  });
});
describe("SaluteSpeech REST contract", () => {
  const response = (result: unknown) =>
    new Response(JSON.stringify({ status: 200, result }), { status: 200 });
  it("refreshes an expired access token once and uses the returned task ID", async () => {
    vi.stubEnv("SALUTE_SPEECH_CREDENTIALS", "local-test-credential");
    const auth = () =>
      new Response(
        JSON.stringify({
          access_token: "local-access",
          expires_at: Date.now() + 1800000,
        }),
      );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(response({ id: "task1" }));
    vi.stubGlobal("fetch", fetch);
    expect(await new SaluteSpeechService().start("upload1")).toBe("task1");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({
      request_file_id: "upload1",
      options: { audio_encoding: "FLAC", language: "ru-RU", model: "general" },
    });
  });
  it("downloads a completed task and does not expose provider credentials in errors", async () => {
    const speech = new SaluteSpeechService();
    const request = vi
      .spyOn(speech, "request")
      .mockResolvedValueOnce({ status: "DONE", response_file_id: "result1" })
      .mockResolvedValueOnce([{ results: [{ text: "Протокол" }] }]);
    expect(await speech.result("task1")).toEqual({
      taskId: "task1",
      text: "Протокол",
    });
    expect(request).toHaveBeenLastCalledWith(
      "/data:download?response_file_id=result1",
    );
  });
  it.each(["NEW", "RUNNING", "ERROR", "CANCELED"])(
    "handles task state %s",
    async (status) => {
      const speech = new SaluteSpeechService();
      vi.spyOn(speech, "request").mockResolvedValue({ status });
      const result = await speech.result("task1");
      expect(result.failed).toBe(
        ["ERROR", "CANCELED"].includes(status) ? true : undefined,
      );
    },
  );
});
