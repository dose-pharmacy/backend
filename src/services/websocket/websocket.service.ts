import { WebSocketServer, WebSocket } from "ws";
import { Server as HttpServer } from "http";
import { logger } from "../../config/logger.js";
import { prisma } from "../../database/prisma.js";
import { IncomingMessage } from "http";

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userRole?: string;
  isAlive?: boolean;
}

interface NotificationMessage {
  type: "notification.created" | "notification.read" | "notification.all_read";
  notification: 
    | {
        id: string;
        type: string;
        title: string;
        message: string;
        severity: string;
        entityType: string;
        entityId: string;
        createdAt: string;
      }
    | { id: string }
    | Record<string, unknown>;
}

const connectedClients = new Map<string, AuthenticatedWebSocket[]>();

async function validateSessionCookie(sessionCookie: string | undefined): Promise<{ userId: string; role: string } | null> {
  if (!sessionCookie) return null;

  try {
    // Extract session token from cookie
    const cookieParts = sessionCookie.split(";");
    let sessionToken: string | null = null;
    for (const part of cookieParts) {
      const [key, value] = part.trim().split("=");
      if (key === "better-auth.session_token") {
        sessionToken = value;
        break;
      }
    }
    if (!sessionToken) return null;

    // Find session in database
    const session = await prisma.session.findUnique({
      where: { token: sessionToken },
      include: { user: { select: { id: true, role: true } } },
    });

    if (!session) return null;
    if (session.expiresAt < new Date()) return null;

    return { userId: session.user.id, role: session.user.role };
  } catch (error) {
    logger.error({ err: error }, "Session validation error");
    return null;
  }
}

async function authenticateWebSocket(ws: AuthenticatedWebSocket, request: IncomingMessage): Promise<boolean> {
  try {
    const sessionCookie = request.headers.cookie;
    const authResult = await validateSessionCookie(sessionCookie);
    
    if (!authResult) {
      logger.warn({ ip: request.socket.remoteAddress }, "WebSocket connection attempt without valid session");
      return false;
    }

    ws.userId = authResult.userId;
    ws.userRole = authResult.role;
    ws.isAlive = true;

    if (!connectedClients.has(ws.userId)) {
      connectedClients.set(ws.userId, []);
    }
    connectedClients.get(ws.userId)!.push(ws);

    logger.info({ userId: ws.userId, role: ws.userRole }, "WebSocket client connected");
    return true;
  } catch (error) {
    logger.error({ err: error, ip: request.socket.remoteAddress }, "WebSocket authentication error");
    return false;
  }
}

function removeClient(ws: AuthenticatedWebSocket): void {
  if (ws.userId) {
    const clients = connectedClients.get(ws.userId);
    if (clients) {
      const index = clients.indexOf(ws);
      if (index !== -1) {
        clients.splice(index, 1);
      }
      if (clients.length === 0) {
        connectedClients.delete(ws.userId);
      }
    }
  }
}

function sendToUser(userId: string, message: NotificationMessage): void {
  const clients = connectedClients.get(userId);
  if (!clients || clients.length === 0) return;

  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function heartbeat(): void {
  for (const clients of connectedClients.values()) {
    for (const client of clients) {
      if (client.isAlive === false) {
        removeClient(client);
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }
}

export const websocketService = {
  initialize(httpServer: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", async (ws: AuthenticatedWebSocket, request) => {
      const authenticated = await authenticateWebSocket(ws, request);
      if (!authenticated) {
        ws.close(4001, "Authentication required");
        return;
      }

      ws.on("pong", () => {
        ws.isAlive = true;
      });

      ws.on("close", () => {
        removeClient(ws);
        logger.info({ userId: ws.userId }, "WebSocket client disconnected");
      });

      ws.on("error", (error) => {
        logger.error({ err: error, userId: ws.userId }, "WebSocket error");
        removeClient(ws);
      });

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch {
          // Ignore invalid messages
        }
      });
    });

    const heartbeatInterval = setInterval(heartbeat, 30000);

    wss.on("close", () => {
      clearInterval(heartbeatInterval);
    });

    logger.info("WebSocket server initialized on path /ws");
    return wss;
  },

  sendNotification(userId: string, notification: {
    id: string;
    type: string;
    title: string;
    message: string;
    severity: string;
    entityType: string;
    entityId: string;
    createdAt: Date;
  }): void {
    const message: NotificationMessage = {
      type: "notification.created",
      notification: {
        ...notification,
        createdAt: notification.createdAt.toISOString(),
      },
    };
    sendToUser(userId, message);
  },

  sendNotificationRead(userId: string, notificationId: string): void {
    const message: NotificationMessage = {
      type: "notification.read",
      notification: { id: notificationId } as Record<string, unknown>,
    };
    sendToUser(userId, message);
  },

  sendAllNotificationsRead(userId: string): void {
    const message: NotificationMessage = {
      type: "notification.all_read",
      notification: {} as Record<string, unknown>,
    };
    sendToUser(userId, message);
  },

  getConnectedUserCount(): number {
    let count = 0;
    for (const clients of connectedClients.values()) {
      count += clients.length;
    }
    return count;
  },

  isUserConnected(userId: string): boolean {
    const clients = connectedClients.get(userId);
    return clients !== undefined && clients.length > 0;
  },
};

export type { NotificationMessage };