import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from "class-validator";

export class RoomParams {
  @Matches(/^meeting_[a-zA-Z0-9_-]{1,100}$/) room!: string;
}
export class TokenDto {
  @Matches(/^[a-zA-Z0-9_-]{1,128}$/) identity!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsBoolean() screenShare!: boolean;
}
export class ParticipantDto {
  @Matches(/^[a-zA-Z0-9_-]{1,128}$/) identity!: string;
  @IsIn(["remove", "mute", "permissions"]) action!: string;
  @IsBoolean() screenShare!: boolean;
}
export class RecordingKeyDto {
  @IsString() @Length(1, 512) key!: string;
}
export class TranscribeDto extends RecordingKeyDto {
  @IsOptional() @Matches(/^[a-zA-Z0-9_-]{1,200}$/) uploadId?: string;
  @IsOptional() @Matches(/^[a-zA-Z0-9_-]{1,200}$/) taskId?: string;
}
