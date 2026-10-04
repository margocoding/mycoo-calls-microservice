import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

export function authorized(
  header: unknown,
  secret = process.env.CALLS_SERVICE_SECRET,
) {
  if (!secret || secret.length < 32 || typeof header !== "string") return false;
  const actual = Buffer.from(header),
    expected = Buffer.from("Bearer " + secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

@Injectable()
export class ServiceGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (!authorized(context.switchToHttp().getRequest().headers.authorization))
      throw new UnauthorizedException();
    return true;
  }
}
