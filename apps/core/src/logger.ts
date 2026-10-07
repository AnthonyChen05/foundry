import { pino, type Logger } from "pino";
import type { AppConfig } from "./config.js";

/**
 * pino logger. JSON lines always; pretty to a real TTY when not under vitest.
 * Guardrail: `redact` strips master-key-looking fields from log lines.
 */
export function makeLogger(config: AppConfig): Logger {
  const pretty =
    config.isTest === false && process.stdout.isTTY === true;

  return pino({
    level: config.logLevel,
    base: { app: "foundry" },
    redact: {
      paths: [
        "masterKey",
        "*.masterKey",
        "authorization",
        "*.authorization",
        "apiKey",
        "*.apiKey",
        "token",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  });
}