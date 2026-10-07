import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Module,
  Param,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { ServiceGuard } from "./service.guard.js";
import { LivekitService } from "./livekit.service.js";
import {
  ParticipantDto,
  RecordingKeyDto,
  RoomParams,
  TokenDto,
  TranscribeDto,
} from "./calls.dto.js";
import { RecordingsService } from "./recordings.service.js";
import { SpeechService } from "./speech.service.js";
import { SaluteSpeechService } from "./salute-speech.service.js";
import { YandexSpeechService } from "./yandex-speech.service.js";

@Controller("rooms/:room")
@UseGuards(ServiceGuard)
class CallsController {
  constructor(
    private readonly livekit: LivekitService,
    private readonly recordingsStore: RecordingsService,
  ) {}
  @Post("token") token(@Param() p: RoomParams, @Body() dto: TokenDto) {
    return this.livekit.token(p.room, dto);
  }
  @Get("participants") participants(@Param() p: RoomParams) {
    return this.livekit.participants(p.room);
  }
  @Post("participant") participant(
    @Param() p: RoomParams,
    @Body() dto: ParticipantDto,
  ) {
    return this.livekit.participant(p.room, dto);
  }
  @Delete() close(@Param() p: RoomParams) {
    return this.livekit.close(p.room);
  }
  @Get("recordings") recordings(@Param() p: RoomParams) {
    return this.livekit.recordings(p.room);
  }
  @Post("recordings") start(@Param() p: RoomParams) {
    return this.livekit.startRecording(p.room);
  }
  @Post("recordings/stop") stop(@Param() p: RoomParams) {
    return this.livekit.stopRecording(p.room);
  }
  @Post("recordings/url") url(
    @Param() p: RoomParams,
    @Body() body: RecordingKeyDto,
  ) {
    return this.recordingsStore.url(p.room, body.key);
  }
  @Post("recordings/transcribe") transcribe(
    @Param() p: RoomParams,
    @Body() body: TranscribeDto,
  ) {
    return this.recordingsStore.transcribe(p.room, body);
  }
}
@Controller()
class SystemController {
  constructor(private readonly livekit: LivekitService) {}
  @Get("health") health() {
    return { status: "ok" };
  }
  @Post("webhooks/livekit") async event(
    @Req() req: RawBodyRequest<Request>,
    @Headers("authorization") auth?: string,
  ) {
    if (!auth || !req.rawBody) throw new UnauthorizedException();
    return this.livekit.event(req.rawBody.toString("utf8"), auth);
  }
}
@Module({
  controllers: [CallsController, SystemController],
  providers: [
    LivekitService,
    ServiceGuard,
    RecordingsService,
    SpeechService,
    SaluteSpeechService,
    YandexSpeechService,
  ],
})
export class AppModule {}
