import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";

const sttUrl = "https://stt.api.cloud.yandex.net/stt/v3";
const operationUrl = "https://operation.api.cloud.yandex.net/operations/";
const validId = /^[a-zA-Z0-9_-]{1,180}$/;
// Base64 plus the JSON envelope must fit SpeechKit v3's 60 MB request limit.
const maxAudioBytes = 44_000_000;

@Injectable()
export class YandexSpeechService {
  assertConfigured() {
    if (!process.env.YANDEX_SPEECHKIT_API_KEY?.trim())
      throw new ServiceUnavailableException(
        "Yandex SpeechKit is not configured",
      );
  }

  async transcribe(path: string, timeoutMs: number): Promise<string> {
    this.assertConfigured();
    const size = (await stat(path)).size;
    if (size < 1 || size > maxAudioBytes)
      throw new ServiceUnavailableException(
        "Audio exceeds SpeechKit size limits",
      );
    const duration = await audioDuration(path);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 14_400)
      throw new ServiceUnavailableException(
        "SpeechKit audio must be under 4 hours",
      );
    const data = await readFile(path);
    const operation = parseObject(
      await this.request(
        sttUrl + "/recognizeFileAsync",
        {
          method: "POST",
          body: JSON.stringify({
            content: data.toString("base64"),
            recognitionModel: {
              model: "general",
              audioFormat: {
                containerAudio: { containerAudioType: "OGG_OPUS" },
              },
              textNormalization: {
                textNormalization: "TEXT_NORMALIZATION_ENABLED",
              },
              languageRestriction: {
                restrictionType: "WHITELIST",
                languageCode: ["ru-RU"],
              },
            },
          }),
        },
        Math.max(1, Math.min(timeoutMs, 180_000)),
      ),
    );
    if (typeof operation.id !== "string" || !validId.test(operation.id))
      throw new ServiceUnavailableException(
        "Invalid SpeechKit operation response",
      );
    // Persist this ID before polling; do not hold a long meeting in one request.
    return operation.id;
  }

  async result(id: string): Promise<{ text?: string; failed?: boolean }> {
    if (!validId.test(id))
      throw new ServiceUnavailableException("Invalid SpeechKit operation ID");
    const operation = parseObject(await this.request(operationUrl + id));
    if (
      operation.id !== id ||
      (operation.done !== undefined && typeof operation.done !== "boolean")
    )
      throw new ServiceUnavailableException(
        "Invalid SpeechKit operation response",
      );
    if (operation.error) return { failed: true };
    if (!operation.done) return {};
    return {
      text: yandexTranscript(
        await this.request(
          sttUrl + "/getRecognition?operation_id=" + encodeURIComponent(id),
        ),
      ),
    };
  }

  private async request(
    url: string,
    init: RequestInit = {},
    timeoutMs = 60_000,
  ) {
    this.assertConfigured();
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Api-Key " + process.env.YANDEX_SPEECHKIT_API_KEY!.trim(),
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("SpeechKit request failed");
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32_000_000)
            throw new Error("SpeechKit response too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch {
      // Provider errors can include request data; never return them or credentials.
      throw new ServiceUnavailableException("Yandex SpeechKit request failed");
    }
  }
}

async function audioDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.FFPROBE_PATH || "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", path],
      { windowsHide: true, timeout: 30_000, maxBuffer: 16_384 },
      (error, stdout) => {
        if (error) return reject(new Error("Cannot inspect recognition audio"));
        try {
          resolve(Number(JSON.parse(stdout).format?.duration));
        } catch {
          reject(new Error("Cannot inspect recognition audio"));
        }
      },
    );
  });
}

function parseObject(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new ServiceUnavailableException("Invalid SpeechKit response");
  }
}

export function yandexTranscript(text: string): string {
  const segments = new Map<
    string,
    { index: number; text: string; refined: boolean }
  >();
  // REST getRecognition returns one JSON object per line, including both raw
  // finals and normalized refinements. The refinement replaces the same final.
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    const event = parseObject(line);
    if (event.error || !event.result || typeof event.result !== "object")
      throw new ServiceUnavailableException(
        "Invalid SpeechKit recognition result",
      );
    const result = event.result;
    const refinement = result.finalRefinement;
    const final = refinement?.normalizedText ?? result.final;
    if (!final) continue;
    const index = Number(
      refinement?.finalIndex ?? result.audioCursors?.finalIndex ?? 0,
    );
    const channel = result.channelTag ?? final.channelTag ?? "0";
    const best = final.alternatives?.[0]?.text;
    if (!Number.isSafeInteger(index) || index < 0 || typeof best !== "string")
      throw new ServiceUnavailableException(
        "Invalid SpeechKit recognition text",
      );
    const key = channel + ":" + index;
    if (refinement || !segments.get(key)?.refined)
      segments.set(key, {
        index,
        text: best.trim(),
        refined: Boolean(refinement),
      });
  }
  const transcript = [...segments.values()]
    .sort((a, b) => a.index - b.index)
    .map((segment) => segment.text)
    .filter(Boolean)
    .join("\n");
  if (transcript.length > 250_000)
    throw new ServiceUnavailableException("Transcript exceeds meeting limit");
  return transcript;
}
