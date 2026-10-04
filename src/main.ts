import "reflect-metadata";
import "dotenv/config";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.js";

if (
  !process.env.CALLS_SERVICE_SECRET ||
  process.env.CALLS_SERVICE_SECRET.length < 32
)
  throw new Error("CALLS_SERVICE_SECRET must contain at least 32 characters");
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  rawBody: true,
});
app.useBodyParser("json", {
  type: ["application/json", "application/webhook+json"],
  limit: "256kb",
});
app.use(helmet());
app.enableShutdownHooks();
app.useGlobalPipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
);
await app.listen(
  Number(process.env.PORT || 4200),
  process.env.HOST || "127.0.0.1",
);
