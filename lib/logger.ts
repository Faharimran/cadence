import winston from "winston";
import { env } from "@/lib/env";

export const logger = winston.createLogger({
  level: env.NODE_ENV === "development" ? "debug" : "info",
  format:
    env.NODE_ENV === "development"
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: "HH:mm:ss" }),
          winston.format.printf(
            ({ level, message, timestamp, ...rest }) =>
              `${timestamp} ${level} ${message}` +
              (Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ""),
          ),
        )
      : winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});
