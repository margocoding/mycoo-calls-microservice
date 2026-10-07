import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  YandexSpeechService,
  yandexTranscript,
} from "./yandex-speech.service.js";

const { stat, readFile, execFile } = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ stat, readFile }));
vi.mock("node:child_process", () => ({ execFile }));
const json = (value: unknown) => new Response(JSON.stringify(value));
const event = (value: unknown) => JSON.stringify({ result: value });
const final = (index: number, text: string) =>
  event({
    audioCursors: { finalIndex: String(index) },
    final: { alternatives: [{ text }, { text: "другая гипотеза" }] },
  });
const refined = (index: number, text: string) =>
  event({
    finalRefinement: {
      finalIndex: String(index),
      normalizedText: { alternatives: [{ text }] },
    },
  });

beforeEach(() => {
  vi.stubEnv("YANDEX_SPEECHKIT_API_KEY", "test-only-not-a-real-key");
  stat.mockResolvedValue({ size: 1000 });
  readFile.mockResolvedValue(Buffer.from("synthetic-audio"));
  execFile.mockImplementation((_cmd, _args, _options, callback) =>
    callback(null, '{"format":{"duration":"30"}}'),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("Yandex SpeechKit v3 REST contract", () => {
  it("submits inline OGG audio using service-account API-key auth and saves the operation ID", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ id: "operation1", done: false }));
    vi.stubGlobal("fetch", fetch);
    expect(
      await new YandexSpeechService().transcribe("recording.ogg", 2000),
    ).toBe("operation1");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Api-Key test-only-not-a-real-key");
    expect(init.headers["x-folder-id"]).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(init.body);
    expect(Buffer.from(payload.content, "base64").toString()).toBe(
      "synthetic-audio",
    );
    expect(payload.uri).toBeUndefined();
    expect(payload.recognitionModel).toEqual({
      model: "general",
      audioFormat: { containerAudio: { containerAudioType: "OGG_OPUS" } },
      textNormalization: { textNormalization: "TEXT_NORMALIZATION_ENABLED" },
      languageRestriction: {
        restrictionType: "WHITELIST",
        languageCode: ["ru-RU"],
      },
    });
  });
  it("does not open media or contact the provider without a key", async () => {
    vi.stubEnv("YANDEX_SPEECHKIT_API_KEY", " ");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      new YandexSpeechService().transcribe("recording.ogg", 1000),
    ).rejects.toThrow("not configured");
    expect(stat).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([0, 44_000_001])(
    "rejects invalid audio size %s before reading or uploading it",
    async (size) => {
      stat.mockResolvedValue({ size });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        new YandexSpeechService().transcribe("recording.ogg", 1000),
      ).rejects.toThrow("size limits");
      expect(readFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([0, 14401, "invalid"])(
    "rejects invalid duration %s without sending audio",
    async (duration) => {
      execFile.mockImplementation((_cmd, _args, _options, callback) =>
        callback(null, JSON.stringify({ format: { duration } })),
      );
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        new YandexSpeechService().transcribe("recording.ogg", 1000),
      ).rejects.toThrow("4 hours");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("fails safely if ffprobe is unavailable", async () => {
    execFile.mockImplementation((_cmd, _args, _options, callback) =>
      callback(new Error("ENOENT"), ""),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      new YandexSpeechService().transcribe("recording.ogg", 1000),
    ).rejects.toThrow("Cannot inspect");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("polls a saved ID without resubmission, then downloads the normalized transcript", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "operation1", done: false }))
      .mockResolvedValueOnce(json({ id: "operation1", done: true }))
      .mockResolvedValueOnce(
        new Response(final(0, "первое") + "\n" + refined(0, "Первое.")),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await new YandexSpeechService().result("operation1")).toEqual({});
    expect(await new YandexSpeechService().result("operation1")).toEqual({
      text: "Первое.",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://operation.api.cloud.yandex.net/operations/operation1",
      "https://operation.api.cloud.yandex.net/operations/operation1",
      "https://stt.api.cloud.yandex.net/stt/v3/getRecognition?operation_id=operation1",
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });
  it("reports terminal operation failure without exposing provider details", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({
          id: "operation1",
          done: true,
          error: { message: "private text" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await new YandexSpeechService().result("operation1")).toEqual({
      failed: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 500])(
    "keeps HTTP %s retryable without exposing the response or credentials",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response("private key and transcript", { status }),
          ),
      );
      await expect(
        new YandexSpeechService().result("operation1"),
      ).rejects.toThrow(/^Yandex SpeechKit request failed$/);
    },
  );
  it("rejects network errors, bad operation IDs and malformed responses", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("private network details"))
      .mockResolvedValueOnce(new Response("invalid JSON"))
      .mockResolvedValueOnce(json({ id: "another-operation", done: true }));
    vi.stubGlobal("fetch", fetch);
    const speech = new YandexSpeechService();
    await expect(speech.result("operation1")).rejects.toThrow(
      /^Yandex SpeechKit request failed$/,
    );
    await expect(speech.result("operation1")).rejects.toThrow(
      "Invalid SpeechKit response",
    );
    await expect(speech.result("operation1")).rejects.toThrow(
      "Invalid SpeechKit operation response",
    );
    await expect(speech.result("../other?secret=value")).rejects.toThrow(
      "operation ID",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("SpeechKit transcript assembly", () => {
  it("replaces raw finals with refinements, preserves repeated phrases and ignores partial/control messages", () => {
    expect(
      yandexTranscript(
        [
          event({ partial: { alternatives: [{ text: "Не сохранять" }] } }),
          final(0, "первая фраза"),
          final(1, "повтор"),
          refined(0, "Первая фраза."),
          refined(2, "Повтор."),
          final(2, "поздняя сырая версия"),
          refined(1, "Повтор."),
          event({ statusCode: { codeType: "WORKING" } }),
        ].join("\r\n"),
      ),
    ).toBe("Первая фраза.\nПовтор.\nПовтор.");
  });
  it("returns empty text for silence instead of inventing a transcript", () => {
    expect(
      yandexTranscript(event({ statusCode: { codeType: "WORKING" } })),
    ).toBe("");
    expect(yandexTranscript(final(0, ""))).toBe("");
  });
  it.each([
    "invalid",
    '{"error":{"message":"private"}}',
    final(-1, "bad"),
    final(0, "x".repeat(250001)),
  ])("rejects malformed or excessive recognition text", (body) => {
    expect(() => yandexTranscript(body)).toThrow();
  });
});
