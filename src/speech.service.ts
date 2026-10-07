import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { SaluteSpeechService } from "./salute-speech.service.js";
import { YandexSpeechService } from "./yandex-speech.service.js";

export interface SpeechResult {
  uploadId?: string;
  taskId?: string;
  text?: string;
  failed?: boolean;
}

const salutePrefix = "salute_";
const yandexPrefix = "yandex_";

@Injectable()
export class SpeechService {
  constructor(
    private readonly salute: SaluteSpeechService,
    private readonly yandex: YandexSpeechService,
  ) {}

  private provider() {
    // Preserve existing deployments that already configured SaluteSpeech.
    const provider =
      process.env.SPEECH_PROVIDER ||
      (process.env.SALUTE_SPEECH_CREDENTIALS ? "salute" : "yandex");
    if (provider !== "yandex" && provider !== "salute")
      throw new ServiceUnavailableException("Unknown speech provider");
    return provider;
  }

  get audioFormat(): "ogg" | "flac" {
    if (this.provider() === "yandex") {
      this.yandex.assertConfigured();
      return "ogg";
    }
    return "flac";
  }

  async transcribe(audio: string, timeoutMs: number): Promise<SpeechResult> {
    const provider = this.provider();
    if (provider === "yandex")
      return {
        taskId: yandexPrefix + (await this.yandex.transcribe(audio, timeoutMs)),
      };
    if (provider === "salute")
      return { uploadId: salutePrefix + (await this.salute.upload(audio)) };
    throw new ServiceUnavailableException("Unknown speech provider");
  }

  // Persisted cloud IDs belong to their original provider, regardless of the
  // provider selected for new files. Unprefixed IDs are legacy SaluteSpeech IDs.
  async start(uploadId: string) {
    return salutePrefix + (await this.salute.start(this.saluteId(uploadId)));
  }

  async result(taskId: string): Promise<SpeechResult> {
    if (taskId.startsWith(yandexPrefix))
      return {
        ...(await this.yandex.result(taskId.slice(yandexPrefix.length))),
        taskId,
      };
    return { ...(await this.salute.result(this.saluteId(taskId))), taskId };
  }

  private saluteId(id: string) {
    return id.startsWith(salutePrefix) ? id.slice(salutePrefix.length) : id;
  }
}
