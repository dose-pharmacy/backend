import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./database/prisma.js";
import { notificationService } from "./services/notification/notification.service.js";
import { websocketService } from "./services/websocket/websocket.service.js";
import cron, { ScheduledTask } from "node-cron";

let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;
let paymentReminderJob: ScheduledTask | undefined;
let expiryAlertJob: ScheduledTask | undefined;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  // Stop cron jobs
  if (paymentReminderJob) {
    paymentReminderJob.stop();
    paymentReminderJob = undefined;
  }
  if (expiryAlertJob) {
    expiryAlertJob.stop();
    expiryAlertJob = undefined;
  }

  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  }

  await disconnectDatabase();
  process.exit(0);
}

function startCronJobs(): void {
  // Payment reminder job - runs every hour at minute 0
  paymentReminderJob = cron.schedule("0 * * * *", async () => {
    if (shuttingDown) return;
    try {
      const result = await notificationService.runPaymentReminderScheduler();
      logger.info({ paymentReminders: result }, "Payment reminder cron job completed");
    } catch (error) {
      logger.error({ err: error }, "Payment reminder cron job failed");
    }
  });

  // Expiry alert job - runs daily at 6 AM UTC
  expiryAlertJob = cron.schedule("0 6 * * *", async () => {
    if (shuttingDown) return;
    try {
      const result = await notificationService.runExpiryAlertScheduler();
      logger.info({ expiryAlerts: result }, "Expiry alert cron job completed");
    } catch (error) {
      logger.error({ err: error }, "Expiry alert cron job failed");
    }
  });

  logger.info("Cron jobs started: payment reminders (hourly), expiry alerts (daily at 6 AM UTC)");
}

async function main(): Promise<void> {
  await connectDatabase();

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(env.port, env.host, () => {
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
      // Initialize WebSocket server
      websocketService.initialize(httpServer);
      // Start cron jobs
      startCronJobs();
      resolve();
    });
    server = httpServer;
    httpServer.on("error", reject);
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
