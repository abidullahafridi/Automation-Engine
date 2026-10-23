import type { Logger } from "@workspace/logging";
import type { MongoDbIntegration } from "../integrations/index.js";
import type { ApiServer } from "./create-server.js";

type ShutdownDependencies = Readonly<{
  database: Pick<MongoDbIntegration, "disconnect">;
  logger: Logger;
  server: Pick<ApiServer, "stop">;
}>;

export const createShutdown = ({ database, logger, server }: ShutdownDependencies) =>
  async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("API shutdown requested.", { signal });
    await server.stop();
    await database.disconnect();
  };
