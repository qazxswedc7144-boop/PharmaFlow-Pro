// server/modules/replication/replication.gateway.ts

import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server as HttpServer } from "http";
import { Duplex } from "stream";
import url from "url";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { Role } from "@prisma/client";
import { ReplicationSubscriber } from "./replication.subscriber.js";
import { ReplicationEvent, ClientConnectionInfo } from "./replication.types.js";

// ---------------------------------------------------------------------------
// الإعدادات (Config)
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;        // 64 كيلو — حماية من DoS بالرسائل الكبيرة
const MAX_BUFFERED_BYTES = 1_000_000;       // لو العميل بطيء نقفله بدل ما نكدّس
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MESSAGES = 50;



const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FATAL: JWT_SECRET environment variable is missing in production.");
    }
    return "pharmaflow-local-development-jwt-secure-secret-2026";
  }
  return secret;
};

const AUTHORIZED_ROLES = new Set<string>([
  Role.ADMIN,
  Role.ACCOUNTANT,
  Role.PHARMACIST,
  Role.INVENTORY_MANAGER,
  Role.TENANT_ADMIN,
  Role.PLATFORM_OWNER,
]);

const BRANCH_SWITCH_ALLOWED_ROLES = new Set<string>([
  Role.ADMIN,
  Role.TENANT_ADMIN,
  Role.PLATFORM_OWNER,
]);

// ---------------------------------------------------------------------------
// الأنواع
// ---------------------------------------------------------------------------

interface JwtPayload {
  userId?: string;
  role?: Role;
  branchId?: string;
  tenantId?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

interface CustomWebSocket extends WebSocket {
  isAlive?: boolean;
  session?: ClientConnectionInfo;
  rateLimit?: { windowStart: number; count: number };
}

type EnrichedReplicationEvent = ReplicationEvent & {
  originSessionId?: string;
  scope?: "SAME_BRANCH" | "ALL_BRANCHES";
};

// ---------------------------------------------------------------------------
// الـ Gateway
// ---------------------------------------------------------------------------

export class ReplicationGateway {
  private static wss: WebSocketServer | null = null;
  private static heartbeatInterval: NodeJS.Timeout | null = null;
  private static activeSockets = new Map<string, CustomWebSocket>();
  private static sessionsByUser = new Map<string, Set<string>>();

  static init(server: HttpServer): void {
    if (this.wss) {
      console.log("[REPLICATION_GATEWAY] Already initialized; skipping.");
      return;
    }

    console.log("[REPLICATION_GATEWAY] Initializing...");

    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

    ReplicationSubscriber.addMessageHandler((_channel, event) => {
      this.routeEventToClients(event);
    });

    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(request, socket, head);
    });

    this.wss.on("connection", (ws: CustomWebSocket, session: ClientConnectionInfo) => {
      this.handleConnection(ws, session);
    });

    this.heartbeatInterval = setInterval(() => this.sweepHeartbeat(), HEARTBEAT_INTERVAL_MS);

    console.log("[REPLICATION_GATEWAY] WebSocket replication server initialized: listening on /ws");
  }

  static close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.activeSockets.forEach((ws) => {
      try { ws.close(1001, "Server shutting down"); } catch { /* noop */ }
    });
    this.activeSockets.clear();
    this.sessionsByUser.clear();
    this.wss?.close();
    this.wss = null;
    console.log("[REPLICATION_GATEWAY] Closed.");
  }

  // -------------------------------------------------------------------------
  // Upgrade + JWT Auth
  // -------------------------------------------------------------------------

  private static handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const parsedUrl = url.parse(request.url || "", true);
      if (parsedUrl.pathname !== "/ws") return;

      const token =
        (parsedUrl.query.token as string | undefined) ||
        this.extractTokenFromCookies(request.headers.cookie);

      if (!token) {
        this.rejectUpgrade(socket, 401, "Unauthorized", "Missing credentials");
        return;
      }

      let decoded: JwtPayload;
      try {
        decoded = jwt.verify(token, getJwtSecret(), {
          algorithms: ["HS256"], // يمنع algorithm confusion
        }) as JwtPayload;
      } catch (err: any) {
        this.rejectUpgrade(socket, 403, "Forbidden", `Invalid JWT: ${err?.message ?? "unknown"}`);
        return;
      }

      // التحقق من انتهاء JWT
      if (typeof decoded.exp !== "number") {
        this.rejectUpgrade(socket, 403, "Forbidden", "JWT missing exp claim");
        return;
      }
      if (decoded.exp * 1000 <= Date.now()) {
        this.rejectUpgrade(socket, 403, "Forbidden", "JWT expired");
        return;
      }

      // إجبارية tenantId
      if (!decoded.tenantId || typeof decoded.tenantId !== "string") {
        this.rejectUpgrade(socket, 403, "Forbidden", "JWT missing tenantId");
        return;
      }

      if (!decoded.role || !AUTHORIZED_ROLES.has(decoded.role)) {
        this.rejectUpgrade(socket, 403, "Forbidden", `Unauthorized role: ${decoded.role ?? "none"}`);
        return;
      }

      const branchId = decoded.branchId || "GENERIC";
      const role = decoded.role;
      const tenantId = decoded.tenantId;

      this.wss?.handleUpgrade(request, socket, head, (ws: CustomWebSocket) => {
        const session: ClientConnectionInfo = {
          sessionId: randomUUID(),
          userId: decoded.userId || "unknown",
          tenantId,
          branchId,
          role,
          connectedAt: new Date().toISOString(),
        };
        this.wss?.emit("connection", ws, session);
      });
    } catch (err: any) {
      console.error("[REPLICATION_GATEWAY] Upgrade intercept failure:", err?.message ?? err);
      try { socket.destroy(); } catch { /* noop */ }
    }
  }

  private static rejectUpgrade(socket: Duplex, status: number, reason: string, detail: string): void {
    console.warn(`[REPLICATION_GATEWAY] Upgrade rejected (${status} ${reason}): ${detail}`);
    try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch { /* noop */ }
    try { socket.destroy(); } catch { /* noop */ }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private static handleConnection(ws: CustomWebSocket, session: ClientConnectionInfo): void {
    ws.isAlive = true;
    ws.session = session;
    ws.rateLimit = { windowStart: Date.now(), count: 0 };

    this.activeSockets.set(session.sessionId, ws);
    const userSessions = this.sessionsByUser.get(session.userId) ?? new Set<string>();
    userSessions.add(session.sessionId);
    this.sessionsByUser.set(session.userId, userSessions);

    console.log(`🔌 [REPLICATION_GATEWAY] Client connected: user=${session.userId}, tenant=${session.tenantId}, role=${session.role}, branch=${session.branchId}`);

    try {
      ws.send(JSON.stringify({
        type: "HandshakeAck",
        message: "Successfully connected to PharmaFlow Pro real-time replication gateway.",
        session,
      }));
    } catch { /* noop */ }

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => this.handleMessage(ws, raw));

    ws.on("close", () => {
      this.activeSockets.delete(session.sessionId);
      const set = this.sessionsByUser.get(session.userId);
      if (set) {
        set.delete(session.sessionId);
        if (set.size === 0) this.sessionsByUser.delete(session.userId);
      }
    });

    ws.on("error", (err) => {
      console.error(`[REPLICATION_GATEWAY] Socket error:`, err?.message ?? err);
      try { ws.terminate(); } catch { /* noop */ }
    });
  }

  private static handleMessage(ws: CustomWebSocket, raw: WebSocket.RawData): void {
    const session = ws.session;
    if (!session) return;

    const now = Date.now();
    const rl = ws.rateLimit ?? { windowStart: now, count: 0 };
    if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) { rl.windowStart = now; rl.count = 0; }
    rl.count += 1;
    ws.rateLimit = rl;
    if (rl.count > RATE_LIMIT_MAX_MESSAGES) {
      try { ws.close(1008, "Rate limit exceeded"); } catch { /* noop */ }
      return;
    }

    let text: string;
    try {
      if (typeof raw === "string") text = raw;
      else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
      else if (Array.isArray(raw)) text = Buffer.concat(raw).toString("utf8");
      else text = Buffer.from(raw as ArrayBuffer).toString("utf8");
    } catch { return; }

    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    switch (msg?.type) {
      case "Heartbeat":
        try { ws.send(JSON.stringify({ type: "HeartbeatAck", timestamp: Date.now() })); } catch { /* noop */ }
        return;
      case "ChangeBranch":
        if (!BRANCH_SWITCH_ALLOWED_ROLES.has(session.role)) return;
        const targetBranch = typeof msg.branchId === "string" ? msg.branchId.trim() : null;
        if (!targetBranch) return;
        session.branchId = targetBranch;
        try { ws.send(JSON.stringify({ type: "BranchChanged", branchId: targetBranch })); } catch { /* noop */ }
        return;
      default: return;
    }
  }

  private static sweepHeartbeat(): void {
    this.wss?.clients.forEach((ws: CustomWebSocket) => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* noop */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    });
  }

  // -------------------------------------------------------------------------
  // توجيه الأحداث — مع عزل الـ tenant + anti-loopback + scope
  // -------------------------------------------------------------------------

  private static routeEventToClients(event: ReplicationEvent): void {
    if (!event || !event.id) return;

    if (!event.tenantId) {
      console.error(`[REPLICATION_GATEWAY] Dropped event ${event.id}: missing tenantId.`);
      return;
    }

    const enriched = event as EnrichedReplicationEvent;
    const originSessionId = enriched.originSessionId;
    const scope = enriched.scope;

    this.activeSockets.forEach((ws) => {
      if (!ws.session || ws.readyState !== WebSocket.OPEN) return;

      // عزل المؤسسات
      if (event.tenantId && ws.session.tenantId !== event.tenantId) return;

      // Anti-loopback
      if (originSessionId && ws.session.sessionId === originSessionId) return;

      // Scope filter
      if (scope === "SAME_BRANCH" && ws.session.branchId !== event.branchId) return;

      // Backpressure
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        try { ws.terminate(); } catch { /* noop */ }
        return;
      }

      try {
        ws.send(JSON.stringify({ type: "ReplicationEvent", event }));
      } catch { /* noop */ }
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  static getActiveSessions(): ClientConnectionInfo[] {
    return Array.from(this.activeSockets.values()).filter(ws => ws.session).map(ws => ({ ...ws.session! }));
  }

  static getSessionsForUser(userId: string): ClientConnectionInfo[] {
    const ids = this.sessionsByUser.get(userId);
    if (!ids) return [];
    return Array.from(ids).map(sid => this.activeSockets.get(sid)?.session).filter(Boolean) as ClientConnectionInfo[];
  }

  static disconnectUser(userId: string, code = 1000, reason = "Logged out"): number {
    const ids = this.sessionsByUser.get(userId);
    if (!ids) return 0;
    let closed = 0;
    ids.forEach((sid) => {
      const ws = this.activeSockets.get(sid);
      if (ws) { try { ws.close(code, reason); closed += 1; } catch { /* noop */ } }
    });
    return closed;
  }

  private static extractTokenFromCookies(cookieString?: string): string | null {
    if (!cookieString) return null;
    for (const raw of cookieString.split(";")) {
      const cookie = raw.trim();
      const eqIdx = cookie.indexOf("=");
      if (eqIdx === -1) continue;
      if (cookie.slice(0, eqIdx).trim() !== "token") continue;
      const value = cookie.slice(eqIdx + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
    return null;
  }
        }
