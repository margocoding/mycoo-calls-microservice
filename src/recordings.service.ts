import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { SpeechService } from "./speech.service.js";
import type { TranscribeDto } from "./calls.dto.js";
import { audioDuration } from "./yandex-speech.service.js";

@Injectable()
export class RecordingsService {
  constructor(private readonly speech: SpeechService) {}
  client(endpoint = process.env.RECORDINGS_S3_ENDPOINT) {
    const e = process.env;
    return new S3Client({
      endpoint: endpoint || undefined,
      region: e.RECORDINGS_S3_REGION || "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: e.RECORDINGS_S3_ACCESS_KEY || "",
        secretAccessKey: e.RECORDINGS_S3_SECRET_KEY || "",
      },
    });
  }
  command(room: string, key: string) {
    if (!key.startsWith("meetings/" + room + "/") || key.includes(".."))
      throw new BadRequestException("Invalid recording key");
    return new GetObjectCommand({
      Bucket: process.env.RECORDINGS_S3_BUCKET,
      Key: key,
    });
  }
  async url(room: string, key: string) {
    const command = this.command(room, key);
    // Sign against the browser-facing host; changing a signed URL afterwards
    // invalidates its signature. Uploads and recognition keep the internal host.
    const client = this.client(
      process.env.RECORDINGS_S3_PUBLIC_ENDPOINT ||
        process.env.RECORDINGS_S3_ENDPOINT,
    );
    try {
      return { url: await getSignedUrl(client, command, { expiresIn: 300 }) };
    } finally {
      client.destroy();
    }
  }
  async info(room: string, key: string) {
    const command = this.command(room, key);
    const client = this.client();
    try {
      const object = await client.send(new HeadObjectCommand(command.input), { abortSignal: AbortSignal.timeout(15_000) });
      const sizeBytes = object.ContentLength;
      if (!Number.isSafeInteger(sizeBytes) || !sizeBytes || sizeBytes < 0) throw new Error('Recording size unavailable');
      const url = await getSignedUrl(client, command, { expiresIn: 120 });
      const duration = await audioDuration(url);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Recording duration unavailable');
      return { sizeBytes, audioSeconds: Math.ceil(duration), provider: this.speech.providerName };
    } finally { client.destroy(); }
  }

  async transcribe(room: string, dto: TranscribeDto) {
    const deadline = Date.now() + 17 * 60_000;
    const command = this.command(room, dto.key);
    if (dto.taskId) return this.speech.result(dto.taskId);
    if (dto.expectedProvider && dto.expectedProvider !== (dto.uploadId ? 'salute' : this.speech.providerName))
      throw new ForbiddenException('Speech provider changed; request a new budget reservation');
    if (dto.uploadId)
      return {
        uploadId: dto.uploadId,
        taskId: await this.speech.start(dto.uploadId),
      };
    const format = this.speech.audioFormat;
    const base = resolve(tmpdir()),
      directory = await mkdtemp(join(base, "mycoo-recording-"));
    const client = this.client();
    try {
      const source = join(directory, "recording.mp4"),
        audio = join(directory, "audio." + format);
      const object = await client.send(command, {
        abortSignal: AbortSignal.timeout(180_000),
      });
      if (!object.Body || (object.ContentLength ?? 0) > 2_000_000_000)
        throw new Error("Recording is missing or too large");
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(
            bytes > 2_000_000_000
              ? new Error("Recording exceeds download limit")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        object.Body as Readable,
        limit,
        createWriteStream(source),
        { signal: AbortSignal.timeout(180_000) },
      );
      await convertAudio(source, audio, format);
      if (dto.maxAudioSeconds !== undefined && Math.ceil(await audioDuration(audio)) > dto.maxAudioSeconds)
        throw new ForbiddenException('Audio exceeds the reserved recognition limit');
      if ((await stat(audio)).size > 1_000_000_000)
        throw new Error("Audio exceeds recognition limit");
      return await this.speech.transcribe(
        audio,
        Math.max(1, deadline - Date.now()),
      );
    } finally {
      client.destroy();
      // Only remove the exact temporary directory we created inside the OS temp root.
      if (resolve(directory).startsWith(join(base, "mycoo-recording-")))
        await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function convertAudio(
  source: string,
  output: string,
  format: "ogg" | "flac" = "flac",
) {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        source,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        ...(format === "ogg"
          ? ["-c:a", "libopus", "-b:a", "16k", "-vbr", "off"]
          : ["-c:a", "flac"]),
        "-y",
        output,
      ],
      { stdio: "ignore", windowsHide: true, timeout: 600_000 },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? done() : reject(new Error("Audio conversion failed")),
    );
  });
}
