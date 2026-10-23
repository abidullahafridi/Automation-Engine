import morgan from "morgan";
import type { Logger } from "./types.js";

type HttpLoggerOptions = Readonly<{
  logger: Logger;
  format?: "combined" | "common" | "dev" | "short" | "tiny";
}>;

export const createHttpLogger = ({ logger, format = "combined" }: HttpLoggerOptions): ReturnType<typeof morgan> =>
  morgan(format, {
    stream: {
      write: (line: string) => { logger.info("HTTP request", { http: line.trim() }); }
    }
  });
