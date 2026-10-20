// server/modules/replication/replication.gateway.ts

import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { ReplicationSubscriber } from "./replication.subscriber.js";
import { ReplicationEvent, ClientConnectionInfo } from "./replication.types.js";
import { prisma } from "../../database/prisma.js";
import { PolicyEngine } from "../../services/rbac/policy.engine.js";

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FATAL: JWT_SECRET environment variable is missing in production.");
    }
    return "pharmaflow-local-development-jwt-secure-secret-2026";
  }
  return secret;
};

const AUTHORIZED_ROLES: string[] = [Role.ADMIN, Role.ACCOUNTANT, Role.PHARMACIST, Role.INVENTORY_MANAGER, Role.TENANT_ADMIN, Role.PLATFORM_OWNER];

interface RateLimitTracker {
  count: number;
  resetAt: number;
}

interface CustomWebSocket extends WebSocket {
  isAlive?: boolean;
  session?: ClientConnectionInfo;
  messageRateLimit?: RateLimitTracker;
  changeBranchRateLimit?: RateLimitTracker;
}

export class ReplicationGateway {
  private static wss: WebSocketServer | null = null;
  private static activeSockets = new Map<string, CustomWebSocket>(); // sessionId -> ws

  /**
   * Initializes the WebSocket Server attached to the shared Http/Express server.
   */
  static init(server: HttpServer): void {
    console.log("[REPLICATION_GATEWAY] Initializing...");
    if (this.wss) {
      console.log("[REPLICATION_GATEWAY] Already initialized.");
      return;
    }

    this.wss = new WebSocketServer({ noServer: true });

    // 1. Hook up the subscriber to push Redis matches directly to clients
    ReplicationSubscriber.addMessageHandler((_channel, event) => {
      this.routeEventToClients(event);
    });

    console.log("[REPLICATION_GATEWAY] WebSocket replication server initialized: listening for upgrade requests on /ws");

    // 2. Intercept Express HTTP Server generic upgrade requests
    server.on("upgrade", async (request: IncomingMessage, socket: any, head: Buffer) => {
      try {
        const protocol = request.headers["x-forwarded-proto"] || "http";
        const host = request.headers.host || "localhost";
        const parsedUrl = new URL(request.url || "", `${protocol}://${host}`);
        const { pathname, searchParams } = parsedUrl;

        if (pathname === "/ws") {
          // Perform JWT Authentication prior to establishing WS socket handshake
          const token = searchParams.get("token") || this.extractTokenFromCookies(request.headers.cookie);
          
          if (!token) {
            console.warn("[REPLICATION_GATEWAY] Connection upgrade rejected: Missing credentials.");
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }

          try {
            const decoded = jwt.verify(token, getJwtSecret()) as any;
            
            // Validate RBAC roles are authorized to access replication streams
            if (!decoded || !AUTHORIZED_ROLES.includes(decoded.role)) {
              console.warn(`[REPLICATION_GATEWAY] Connection upgrade rejected: Unauthorized role ${decoded?.role}`);
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }

            const userId = decoded.userId;
            const tenantId = decoded.tenantId;
            const requestedBranchId = decoded.branchId || searchParams.get("branchId");

            if (!tenantId) {
              console.warn("[REPLICATION_GATEWAY] Connection upgrade rejected: Missing tenantId in token claims.");
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }

            if (!userId) {
              console.warn("[REPLICATION_GATEWAY] Connection upgrade rejected: Missing userId in token claims.");
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }

            // Fetch authorized branches for user in this tenant via BranchUser
            let allowedBranchIds: string[] = [];
            try {
              const branchUsers = await prisma.branchUser.findMany({
                where: { userId, tenantId },
                select: { branchId: true }
              });
              allowedBranchIds = branchUsers.map(bu => bu.branchId);
            } catch (dbErr: any) {
              console.warn("[REPLICATION_GATEWAY] Failed to query branch users:", dbErr?.message);
            }

            const roleUpper = (decoded.role || "").toUpperCase();
            const isTenantWide = roleUpper === "PLATFORM_OWNER" || roleUpper === "TENANT_ADMIN" || roleUpper === "OWNER";

            // If tenant wide admin, allow all tenant branches or default if allowedBranchIds is empty
            if (isTenantWide && allowedBranchIds.length === 0) {
              try {
                const tenantBranches = await prisma.branch.findMany({
                  where: { tenantId },
                  select: { id: true }
                });
                allowedBranchIds = tenantBranches.map(b => b.id);
              } catch {
                // fallback
              }
            }

            const assignedBranchId = requestedBranchId || allowedBranchIds[0] || "GENERIC";

            // Verify branch access
            if (!isTenantWide && assignedBranchId !== "GENERIC" && !allowedBranchIds.includes(assignedBranchId)) {
              console.warn(`[REPLICATION_GATEWAY] Connection upgrade rejected: User ${userId} not authorized for branch ${assignedBranchId}`);
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }

            // Authentication succeeded! Continue upgrade.
            this.wss?.handleUpgrade(request, socket, head, (ws) => {
              const session: ClientConnectionInfo = {
                sessionId: Math.random().toString(36).substring(2, 14),
                userId,
                tenantId,
                branchId: assignedBranchId,
                role: decoded.role,
                allowedBranchIds,
                connectedAt: new Date().toISOString()
              };

              this.wss?.emit("connection", ws, session);
            });
          } catch (jwtErr: any) {
            console.warn("[REPLICATION_GATEWAY] Connection upgrade rejected: Invalid JWT Token.", jwtErr?.message);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
          }
        }
      } catch (err: any) {
        console.error("[REPLICATION_GATEWAY] Upgrade intercept failure:", err?.message);
        socket.destroy();
      }
    });

    // 3. Handle actual WebSocket connection lifecycles
    this.wss.on("connection", (ws: CustomWebSocket, session: ClientConnectionInfo) => {
      ws.isAlive = true;
      ws.session = session;
      ws.messageRateLimit = { count: 0, resetAt: Date.now() + 60000 };
      ws.changeBranchRateLimit = { count: 0, resetAt: Date.now() + 60000 };
      this.activeSockets.set(session.sessionId, ws);

      console.log(`🔌 [REPLICATION_GATEWAY] Client connected: user=${session.userId}, tenant=${session.tenantId}, role=${session.role}, branch=${session.branchId} (Sess: ${session.sessionId})`);

      // Send initial acknowledgement handshake to client
      ws.send(JSON.stringify({
        type: "HandshakeAck",
        message: "Successfully connected to PharmaFlow Pro real-time replication gateway.",
        session
      }));

      // Listen for heartbeats (ping/pong) and commands
      ws.on("pong", () => {
        ws.isAlive = true;
      });

      ws.on("message", (rawMessage: any) => {
        try {
          const messageStr = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
          
          // Check message size (max 1MB)
          if (messageStr.length > 1024 * 1024) {
            ws.send(JSON.stringify({ type: "Error", message: "Oversized message rejected" }));
            return;
          }

          // Rate limit check for messages (60 messages / minute)
          const now = Date.now();
          if (ws.messageRateLimit) {
            if (now > ws.messageRateLimit.resetAt) {
              ws.messageRateLimit.count = 1;
              ws.messageRateLimit.resetAt = now + 60000;
            } else {
              ws.messageRateLimit.count++;
              if (ws.messageRateLimit.count > 60) {
                ws.send(JSON.stringify({ type: "RateLimitExceeded", message: "Message rate limit exceeded (max 60/min)" }));
                return;
              }
            }
          }

          const msg = JSON.parse(messageStr);
          
          if (msg.type === "Heartbeat") {
            ws.send(JSON.stringify({ type: "HeartbeatAck", timestamp: Date.now() }));
          } else if (msg.type === "ChangeBranch") {
            // Rate limit check for ChangeBranch (10 changes / minute)
            if (ws.changeBranchRateLimit) {
              if (now > ws.changeBranchRateLimit.resetAt) {
                ws.changeBranchRateLimit.count = 1;
                ws.changeBranchRateLimit.resetAt = now + 60000;
              } else {
                ws.changeBranchRateLimit.count++;
                if (ws.changeBranchRateLimit.count > 10) {
                  ws.send(JSON.stringify({ type: "RateLimitExceeded", message: "Change branch rate limit exceeded (max 10/min)" }));
                  return;
                }
              }
            }

            if (ws.session && msg.branchId) {
              const targetBranchId = String(msg.branchId);
              
              // Verify branch access using PolicyEngine and allowedBranchIds
              const identityCtx = {
                userId: ws.session.userId,
                tenantId: ws.session.tenantId,
                role: ws.session.role,
                branchId: ws.session.branchId
              };

              const hasAccess = PolicyEngine.canAccessBranch(identityCtx, targetBranchId) ||
                                ws.session.allowedBranchIds.includes(targetBranchId);

              if (!hasAccess) {
                console.warn(`[REPLICATION_GATEWAY] Branch change denied for user ${ws.session.userId} to branch ${targetBranchId}`);
                ws.send(JSON.stringify({
                  type: "BranchChangeDenied",
                  branchId: targetBranchId,
                  reason: "Access denied to target branch"
                }));
                return;
              }

              const old = ws.session.branchId;
              ws.session.branchId = targetBranchId;
              console.log(`[REPLICATION_GATEWAY] Session ${ws.session.sessionId} switched branch from ${old} to ${targetBranchId}`);
              ws.send(JSON.stringify({ type: "BranchChanged", branchId: targetBranchId }));
            }
          }
        } catch (mErr: any) {
          ws.send(JSON.stringify({ type: "Error", message: "Invalid JSON message format" }));
        }
      });

      ws.on("close", () => {
        this.activeSockets.delete(session.sessionId);
        console.log(`🔌 [REPLICATION_GATEWAY] Client disconnected: session=${session.sessionId}`);
      });

      ws.on("error", (errVal) => {
        console.error(`[REPLICATION_GATEWAY] Error in socket session ${session.sessionId}:`, errVal?.message);
        ws.terminate();
      });
    });

    // 4. Heartbeat checking process: periodic ping-pong sweeps
    setInterval(() => {
      this.wss?.clients.forEach((ws: CustomWebSocket) => {
        if (ws.isAlive === false) {
          console.warn(`[REPLICATION_GATEWAY] Client dormant. Terminating session ${ws.session?.sessionId}`);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // 30 seconds interval
  }

  /**
   * Pushes incoming replication events to the correct websocket connections with tenant & branch security.
   */
  private static routeEventToClients(event: ReplicationEvent): void {
    if (!event || !event.id) return;

    this.activeSockets.forEach((ws) => {
      if (!ws.session || ws.readyState !== WebSocket.OPEN) return;

      // 1. Cross-tenant isolation check
      if (event.tenantId && ws.session.tenantId && event.tenantId !== ws.session.tenantId) {
        return;
      }

      // 2. Branch authorization check: client must have access to the event's branch
      const eventBranchId = event.branchId;
      const isAuthorizedForBranch = 
        ws.session.branchId === eventBranchId ||
        ws.session.allowedBranchIds.includes(eventBranchId) ||
        ["PLATFORM_OWNER", "TENANT_ADMIN", "OWNER"].includes((ws.session.role || "").toUpperCase());

      if (!isAuthorizedForBranch) {
        return;
      }



      try {
        ws.send(JSON.stringify({
          type: "ReplicationEvent",
          event
        }));
      } catch (err: any) {
        console.warn(`[REPLICATION_GATEWAY] Failed to send event to session ${ws.session.sessionId}:`, err?.message);
      }
    });
  }

  /**
   * Helper to fetch active sessions information for telemetry
   */
  static getActiveSessions(): ClientConnectionInfo[] {
    const list: ClientConnectionInfo[] = [];
    this.activeSockets.forEach((ws) => {
      if (ws.session) {
        list.push(ws.session);
      }
    });
    return list;
  }

  /**
   * Token retrieval utility from headers cookies
   */
  private static extractTokenFromCookies(cookieString?: string): string | null {
    if (!cookieString) return null;
    const cookies = cookieString.split(";");
    for (const cookie of cookies) {
      const parts = cookie.trim().split("=");
      const name = parts[0];
      const value = parts[1];
      if (name === "token" && value) {
        return decodeURIComponent(value);
      }
    }
    return null;
  }
}
