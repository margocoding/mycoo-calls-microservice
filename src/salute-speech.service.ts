import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

// Keep the provider IDs in the main DB between requests. A restart must not
// restart a paid recognition task that has already been accepted by Salute.
@Injectable()
export class SaluteSpeechService {
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000)
      return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = this.authorize();
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = undefined;
    }
  }
  private async authorize() {
    const credentials = process.env.SALUTE_SPEECH_CREDENTIALS;
    if (!credentials)
      throw new ServiceUnavailableException("SaluteSpeech is not configured");
    const response = await fetch(
      "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + credentials,
          RqUID: randomUUID(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          scope: process.env.SALUTE_SPEECH_SCOPE || "SALUTE_SPEECH_PERS",
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const data = (await response.json()) as {
      access_token?: string;
      expires_at?: number;
    };
    if (!response.ok || !data.access_token || !data.expires_at)
      throw new ServiceUnavailableException(
        "SaluteSpeech authorization failed",
      );
    this.token = { value: data.access_token, expiresAt: data.expires_at };
    return data.access_token;
  }
  async request(
    path: string,
    init: () => RequestInit = () => ({}),
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(),
        options = init();
      const response = await fetch(
        "https://smartspeech.sber.ru/rest/v1" + path,
        {
          ...options,
          headers: { ...options.headers, Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(180_000),
        },
      );
      if (response.status === 401 && !attempt) {
        await response.body?.cancel();
        this.token = undefined;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ServiceUnavailableException("SaluteSpeech request failed");
      }
      const text = await response.text();
      if (text.length > 4_000_000)
        throw new ServiceUnavailableException(
          "Recognition result is too large",
        );
      const data = JSON.parse(text);
      if (data && typeof data.status === "number" && data.status !== 200)
        throw new ServiceUnavailableException("SaluteSpeech request failed");
      return data?.result ?? data;
    }
    throw new ServiceUnavailableException("SaluteSpeech authorization failed");
  }
  async upload(path: string) {
    const size = (await stat(path)).size;
    if (size < 400 || size > 1_000_000_000)
      throw new ServiceUnavailableException(
        "Audio size is outside SaluteSpeech limits",
      );
    const result = (await this.request(
      "/data:upload",
      () =>
        ({
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
          },
          body: createReadStream(path),
          duplex: "half",
        }) as unknown as RequestInit,
    )) as { request_file_id?: string };
    if (!result.request_file_id)
      throw new ServiceUnavailableException(
        "SaluteSpeech did not return an upload ID",
      );
    return result.request_file_id;
  }
  async start(uploadId: string) {
    const result = (await this.request("/speech:async_recognize", () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_file_id: uploadId,
        options: {
          audio_encoding: "FLAC",
          language: "ru-RU",
          model: "general",
        },
      }),
    }))) as { id?: string };
    if (!result.id)
      throw new ServiceUnavailableException(
        "SaluteSpeech did not return a task ID",
      );
    return result.id;
  }
  async result(
    taskId: string,
  ): Promise<{ taskId: string; text?: string; failed?: boolean }> {
    const task = (await this.request(
      "/task:get?id=" + encodeURIComponent(taskId),
    )) as { status?: string; response_file_id?: string };
    if (task.status === "ERROR" || task.status === "CANCELED")
      return { taskId, failed: true };
    if (task.status === "NEW" || task.status === "RUNNING") return { taskId };
    if (task.status !== "DONE" || !task.response_file_id)
      throw new ServiceUnavailableException(
        "Invalid recognition task response",
      );
    return {
      taskId,
      text: transcriptText(
        await this.request(
          "/data:download?response_file_id=" +
            encodeURIComponent(task.response_file_id),
        ),
      ),
    };
  }
}

export function transcriptText(value: unknown): string {
  // Async output consists of RecognitionResponse segments. Hypotheses within a
  // segment are alternatives: use only the first, never concatenate them.
  const segments = Array.isArray(value) ? value : [value];
  const lines = segments
    .map((segment) => {
      if (
        !segment ||
        typeof segment !== "object" ||
        !Array.isArray(segment.results)
      )
        throw new Error("Invalid recognition segment");
      const first = segment.results[0];
      if (!first) return "";
      const text = first.normalized_text || first.text;
      if (typeof text !== "string") throw new Error("Invalid recognition text");
      return text.trim();
    })
    .filter(Boolean);
  const result = lines.join("\n");
  if (result.length > 250_000)
    throw new Error("Transcript exceeds meeting limit");
  return result;
}
