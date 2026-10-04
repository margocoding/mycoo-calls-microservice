import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  WebhookReceiver,
} from "livekit-server-sdk";
import { TokenDto, ParticipantDto } from "./calls.dto.js";

@Injectable()
export class LivekitService {
  private config() {
    const {
      LIVEKIT_URL: url,
      LIVEKIT_API_KEY: key,
      LIVEKIT_API_SECRET: secret,
    } = process.env;
    if (!url || !key || !secret)
      throw new ServiceUnavailableException("LiveKit is not configured");
    return { url, key, secret };
  }
  private rooms() {
    const c = this.config();
    return new RoomServiceClient(c.url, c.key, c.secret);
  }
  private egress() {
    const c = this.config();
    return new EgressClient(c.url, c.key, c.secret);
  }
  sources(screenShare: boolean) {
    return [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      ...(screenShare
        ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
        : []),
    ];
  }
  async token(room: string, dto: TokenDto) {
    const c = this.config();
    await this.rooms().createRoom({
      name: room,
      emptyTimeout: 300,
      departureTimeout: 60,
      maxParticipants: 100,
    });
    const token = new AccessToken(c.key, c.secret, {
      identity: dto.identity,
      name: dto.name,
      ttl: 60,
    });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: this.sources(dto.screenShare),
    });
    return {
      token: await token.toJwt(),
      url: process.env.LIVEKIT_PUBLIC_URL || c.url.replace(/^http/, "ws"),
    };
  }
  async participants(room: string) {
    const existing = await this.rooms().listRooms([room]);
    if (!existing.length) return [];
    return (await this.rooms().listParticipants(room)).map((p) => ({
      identity: p.identity,
      name: p.name,
      tracks: p.tracks.map((t) => ({
        sid: t.sid,
        source: t.source,
        muted: t.muted,
      })),
    }));
  }
  async participant(room: string, dto: ParticipantDto) {
    const rooms = this.rooms();
    const people = await this.participants(room);
    if (!people.some((p) => p.identity === dto.identity)) return { ok: true };
    if (dto.action === "remove")
      await rooms.removeParticipant(room, dto.identity);
    else if (dto.action === "permissions")
      await rooms.updateParticipant(room, dto.identity, {
        permission: {
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
          canPublishSources: this.sources(dto.screenShare),
        },
      });
    else
      for (const track of people.find((p) => p.identity === dto.identity)!
        .tracks)
        if (track.source === TrackSource.MICROPHONE)
          await rooms.mutePublishedTrack(room, dto.identity, track.sid, true);
    return { ok: true };
  }
  async close(room: string) {
    const rooms = this.rooms();
    if ((await rooms.listRooms([room])).length) await rooms.deleteRoom(room);
    return { ok: true };
  }
  async recordings(room: string) {
    return (await this.egress().listEgress({ roomName: room })).map((e) => ({
      id: e.egressId,
      status: e.status,
      error: e.error ? "Recording failed" : null,
      files: e.fileResults.map((f) => ({
        filename: f.filename,
        size: String(f.size),
      })),
    }));
  }
  async startRecording(room: string) {
    const active = (await this.recordings(room)).find((e) =>
      [0, 1, 2].includes(e.status),
    );
    if (active) return active;
    const env = process.env;
    if (
      !env.RECORDINGS_S3_BUCKET ||
      !env.RECORDINGS_S3_ACCESS_KEY ||
      !env.RECORDINGS_S3_SECRET_KEY
    )
      throw new ServiceUnavailableException(
        "Recording storage is not configured",
      );
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: "meetings/" + room + "/{time}.mp4",
      output: {
        case: "s3",
        value: new S3Upload({
          bucket: env.RECORDINGS_S3_BUCKET,
          accessKey: env.RECORDINGS_S3_ACCESS_KEY,
          secret: env.RECORDINGS_S3_SECRET_KEY,
          region: env.RECORDINGS_S3_REGION || "us-east-1",
          endpoint: env.RECORDINGS_S3_ENDPOINT || "",
          forcePathStyle: true,
        }),
      },
    });
    const result = await this.egress().startRoomCompositeEgress(
      room,
      { file: output },
      { layout: "grid", audioOnly: false },
    );
    return { id: result.egressId, status: result.status };
  }
  async stopRecording(room: string) {
    for (const e of await this.recordings(room))
      if ([0, 1].includes(e.status)) await this.egress().stopEgress(e.id);
    return this.recordings(room);
  }
  async event(body: string, authorization?: string) {
    const c = this.config();
    const event = await new WebhookReceiver(c.key, c.secret)
      .receive(body, authorization)
      .catch(() => {
        throw new UnauthorizedException("Invalid LiveKit signature");
      });
    const url = process.env.MYCOO_EVENTS_URL;
    if (!url)
      throw new ServiceUnavailableException("Event receiver is not configured");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.CALLS_SERVICE_SECRET,
      },
      body: JSON.stringify({
        id: event.id,
        event: event.event,
        room: event.room?.name,
        identity: event.participant?.identity,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new ServiceUnavailableException("Event delivery failed");
    return { ok: true };
  }
}
