import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechService } from "./speech.service.js";
import type { SaluteSpeechService } from "./salute-speech.service.js";
import type { YandexSpeechService } from "./yandex-speech.service.js";

afterEach(() => vi.unstubAllEnvs());

function providers() {
  const salute = {
    upload: vi.fn().mockResolvedValue("file1"),
    start: vi.fn().mockResolvedValue("job1"),
    result: vi.fn().mockResolvedValue({ text: "Текст" }),
  };
  const yandex = {
    assertConfigured: vi.fn(),
    transcribe: vi.fn().mockResolvedValue("operation1"),
    result: vi.fn().mockResolvedValue({ text: "Протокол" }),
  };
  return {
    salute,
    yandex,
    service: new SpeechService(
      salute as unknown as SaluteSpeechService,
      yandex as unknown as YandexSpeechService,
    ),
  };
}

describe("Speech provider selection", () => {
  it("selects Yandex explicitly and does not fall back to another paid provider on errors", async () => {
    vi.stubEnv("SPEECH_PROVIDER", "yandex");
    vi.stubEnv("SALUTE_SPEECH_CREDENTIALS", "test-only");
    const f = providers();
    expect(f.service.audioFormat).toBe("ogg");
    expect(await f.service.transcribe("audio.ogg", 1000)).toEqual({
      taskId: "yandex_operation1",
    });
    f.yandex.transcribe.mockRejectedValue(new Error("offline"));
    await expect(f.service.transcribe("audio.ogg", 1000)).rejects.toThrow();
    expect(f.salute.upload).not.toHaveBeenCalled();
  });
  it("defaults to Yandex for new installs and preserves existing Salute deployments", async () => {
    vi.stubEnv("SPEECH_PROVIDER", "");
    vi.stubEnv("SALUTE_SPEECH_CREDENTIALS", "");
    const f = providers();
    expect(await f.service.transcribe("audio.ogg", 1000)).toEqual({
      taskId: "yandex_operation1",
    });
    vi.stubEnv("SALUTE_SPEECH_CREDENTIALS", "test-only");
    expect(f.service.audioFormat).toBe("flac");
    expect(await f.service.transcribe("audio.flac", 1000)).toEqual({
      uploadId: "salute_file1",
    });
  });
  it.each(["file1", "salute_file1"])(
    "resumes legacy Salute upload %s after switching to Yandex",
    async (id) => {
      vi.stubEnv("SPEECH_PROVIDER", "yandex");
      const f = providers();
      expect(await f.service.start(id)).toBe("salute_job1");
      expect(f.salute.start).toHaveBeenCalledWith("file1");
      for (const taskId of ["job1", "salute_job1"]) {
        expect(await f.service.result(taskId)).toEqual({
          taskId,
          text: "Текст",
        });
        expect(f.salute.result).toHaveBeenLastCalledWith("job1");
      }
      expect(f.yandex.transcribe).not.toHaveBeenCalled();
    },
  );
  it("polls a saved Yandex operation after switching the new-recording provider", async () => {
    vi.stubEnv("SPEECH_PROVIDER", "salute");
    const f = providers();
    expect(await f.service.result("yandex_operation1")).toEqual({
      taskId: "yandex_operation1",
      text: "Протокол",
    });
    expect(f.yandex.result).toHaveBeenCalledWith("operation1");
    expect(f.salute.result).not.toHaveBeenCalled();
  });
  it("rejects unsupported providers before any external call", async () => {
    vi.stubEnv("SPEECH_PROVIDER", "vosk");
    const f = providers();
    await expect(f.service.transcribe("audio.ogg", 1000)).rejects.toThrow(
      "Unknown speech provider",
    );
    expect(f.salute.upload).not.toHaveBeenCalled();
    expect(f.yandex.transcribe).not.toHaveBeenCalled();
  });
});
