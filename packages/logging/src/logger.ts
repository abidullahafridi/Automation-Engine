import pino, { type DestinationStream, type LoggerOptions } from "pino";
import pretty from "pino-pretty";
import type { Logger, LogContext, LogLevel } from "./types.js";

type CreateLoggerOptions = Readonly<{
  service: string;
  level?: LogLevel;
  format?: "json" | "pretty";
  colorize?: boolean;
  destination?: DestinationStream;
}>;

const write = (
  operation: (context: LogContext, message: string) => void,
  message: string,
  context: LogContext = {}
) => { operation(context, message); };

export const createLogger = ({
  service,
  level = "info",
  format = "json",
  colorize = process.stdout.isTTY,
  destination
}: CreateLoggerOptions): Logger => {
  const options: LoggerOptions = {
    name: service,
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime
  };
  const output = format === "pretty"
    ? pretty({
        colorize,
        destination: destination ?? 1,
        ignore: "hostname,pid,service",
        levelFirst: true,
        sync: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l"
      })
    : destination;
  const instance = output ? pino(options, output) : pino(options);
  return Object.freeze({
    info: (message: string, context?: LogContext) => { write(instance.info.bind(instance), message, context); },
    warn: (message: string, context?: LogContext) => { write(instance.warn.bind(instance), message, context); },
    error: (message: string, context?: LogContext) => { write(instance.error.bind(instance), message, context); }
  });
};
