import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./database/prisma.js";

let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  }

  await disconnectDatabase();
  process.exit(0);
}

async function main(): Promise<void> {
  await connectDatabase();

  await new Promise<void>((resolve, reject) => {
    server = app.listen(env.port, env.host, () => {
      logger.info(
        {
          port: env.port,
          host: env.host,
          env: env.nodeEnv,
          api: env.apiPrefix,
          auth: env.authBasePath,
        },
        "Server started",
      );
      resolve();
    });
    server.on("error", reject);
  });
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled rejection");
});

void main().catch((error) => {
  logger.error({ err: error }, "Failed to start server");
  process.exit(1);
});
