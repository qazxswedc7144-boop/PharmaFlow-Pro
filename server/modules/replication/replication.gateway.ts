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

// الأدوار اللي مسموح لها تبدّل الفرع وقت الاتصال.
// ⚠️ في الإنتاج لازم يكون في تحقق من الـ DB إن المستخدم فعلاً عضو في الفرع الهدف،
// وإلا الأفضل تشيل أمر ChangeBranch بالكامل.
const BRANCH_SWITCH_ALLOWED_ROLES = new Set<string>([
  Role.ADMIN,
  Role.TENANT_ADMIN,
  Role.PLATFORM_OWNER,
]);

// ---------------------------------------------------------------------------
// الأنواع (Types)
// ---------------------------------------------------------------------------

interface JwtPayload {
  userId?: string;
  role?: Role;
  branchId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

interface CustomWebSocket extends WebSocket {
  isAlive?: boolean;
  session?: ClientConnectionInfo;
  rateLimit?: { windowStart: number; count: number };
}

// الحقول الجديدة نقراها بشكل آمن حتى لو الـ types ما تحدّثت بعد
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
  private static activeSockets = new Map<string, CustomWebSocket>(); // sessionId -> ws
  private static sessionsByUser = new Map<string, Set<string>>();   // userId -> Set<sessionId>

  /**
   * يبدأ الـ WebSocket Server ويربطه بسيرفر Express الموجود.
   */
  static init(server: HttpServer): void {
    if (this.wss) {
      console.log("[REPLICATION_GATEWAY] Already initialized; skipping.");
      return;
    }

    console.log("[REPLICATION_GATEWAY] Initializing...");

    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

    // ١. نربط الـ Subscriber بالـ WebSocket عشان الأحداث تجي من Redis وتوصل للعملاء
    ReplicationSubscriber.addMessageHandler((_channel, event) => {
      this.routeEventToClients(event);
    });

    // ٢. نعترض طلبات الـ upgrade ونتحقق من الـ JWT قبل ما نفتح الاتصال
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(request, socket, head);
    });

    // ٣. دورة حياة الاتصال
    this.wss.on("connection", (ws: CustomWebSocket, session: ClientConnectionInfo) => {
      this.handleConnection(ws, session);
    });

    // ٤. فحص الـ heartbeat الدوري
    this.heartbeatInterval = setInterval(() => this.sweepHeartbeat(), HEARTBEAT_INTERVAL_MS);

    console.log("[REPLICATION_GATEWAY] WebSocket replication server initialized: listening on /ws");
  }

  /**
   * إغلاق نظيف: نوقف الـ interval، نقفل السوكيتس، ونفضي المراجع.
   */
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
  // الـ Upgrade والتحقق من الهوية
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
        decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
      } catch (err: any) {
        // لا تسجل التوكن ولا محتواه أبداً هنا
        this.rejectUpgrade(socket, 403, "Forbidden", `Invalid JWT: ${err?.message ?? "unknown"}`);
        return;
      }

      if (!decoded.role || !AUTHORIZED_ROLES.has(decoded.role)) {
        this.rejectUpgrade(socket, 403, "Forbidden", `Unauthorized role: ${decoded.role ?? "none"}`);
        return;
      }

      // الفرع يُستخرج من التوكن الموقّع فقط.
      // نتجاهل ?branchId= من الـ query عمداً لمنع تسريب بيانات فروع ثانية.
      const branchId = decoded.branchId || "GENERIC";
      const role = decoded.role;

      this.wss?.handleUpgrade(request, socket, head, (ws: CustomWebSocket) => {
        const session: ClientConnectionInfo = {
          sessionId: randomUUID(),
          userId: decoded.userId || "unknown",
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

  private static rejectUpgrade(
    socket: Duplex,
    status: number,
    reason: string,
    detail: string,
  ): void {
    console.warn(`[REPLICATION_GATEWAY] Upgrade rejected (${status} ${reason}): ${detail}`);
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    } catch { /* noop */ }
    try { socket.destroy(); } catch { /* noop */ }
  }

  // -------------------------------------------------------------------------
  // دورة حياة الاتصال
  // -------------------------------------------------------------------------

  private static handleConnection(ws: CustomWebSocket, session: ClientConnectionInfo): void {
    ws.isAlive = true;
    ws.session = session;
    ws.rateLimit = { windowStart: Date.now(), count: 0 };

    this.activeSockets.set(session.sessionId, ws);

    const userSessions = this.sessionsByUser.get(session.userId) ?? new Set<string>();
    userSessions.add(session.sessionId);
    this.sessionsByUser.set(session.userId, userSessions);

    console.log(
      `🔌 [REPLICATION_GATEWAY] Client connected: user=${session.userId}, role=${session.role}, branch=${session.branchId} (sess: ${session.sessionId})`,
    );

    try {
      ws.send(JSON.stringify({
        type: "HandshakeAck",
        message: "Successfully connected to PharmaFlow Pro real-time replication gateway.",
        session,
      }));
    } catch (err: any) {
      console.warn(
        `[REPLICATION_GATEWAY] Failed to send handshake ack (sess=${session.sessionId}):`,
        err?.message ?? err,
      );
    }

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => this.handleMessage(ws, raw));

    ws.on("close", () => {
      this.activeSockets.delete(session.sessionId);
      const set = this.sessionsByUser.get(session.userId);
      if (set) {
        set.delete(session.sessionId);
        if (set.size === 0) this.sessionsByUser.delete(session.userId);
      }
      console.log(`🔌 [REPLICATION_GATEWAY] Client disconnected: sess=${session.sessionId}`);
    });

    ws.on("error", (err) => {
      console.error(
        `[REPLICATION_GATEWAY] Socket error (sess=${session.sessionId}):`,
        err?.message ?? err,
      );
      try { ws.terminate(); } catch { /* noop */ }
    });
  }

  private static handleMessage(ws: CustomWebSocket, raw: WebSocket.RawData): void {
    const session = ws.session;
    if (!session) return;

    // ---- Rate limiting لكل اتصال ----
    const now = Date.now();
    const rl = ws.rateLimit ?? { windowStart: now, count: 0 };
    if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
      rl.windowStart = now;
      rl.count = 0;
    }
    rl.count += 1;
    ws.rateLimit = rl;
    if (rl.count > RATE_LIMIT_MAX_MESSAGES) {
      console.warn(
        `[REPLICATION_GATEWAY] Rate limit exceeded (sess=${session.sessionId}); closing.`,
      );
      try { ws.close(1008, "Rate limit exceeded"); } catch { /* noop */ }
      return;
    }

    // ---- تحويل آمن للرسالة إلى نص ----
    let text: string;
    try {
      if (typeof raw === "string") text = raw;
      else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
      else if (Array.isArray(raw)) text = Buffer.concat(raw).toString("utf8");
      else text = Buffer.from(raw as ArrayBuffer).toString("utf8");
    } catch {
      console.warn(`[REPLICATION_GATEWAY] Non-text frame (sess=${session.sessionId}); ignoring.`);
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      console.warn(
        `[REPLICATION_GATEWAY] Malformed JSON (sess=${session.sessionId}); ignoring.`,
      );
      return;
    }

    switch (msg?.type) {
      case "Heartbeat": {
        try {
          ws.send(JSON.stringify({ type: "HeartbeatAck", timestamp: Date.now() }));
        } catch { /* noop */ }
        return;
      }

      case "ChangeBranch": {
        if (!BRANCH_SWITCH_ALLOWED_ROLES.has(session.role)) {
          try {
            ws.send(JSON.stringify({
              type: "Error",
              code: "FORBIDDEN",
              message: "Not authorized to change branch.",
            }));
          } catch { /* noop */ }
          return;
        }

        const targetBranch = typeof msg.branchId === "string" ? msg.branchId.trim() : null;
        if (!targetBranch) {
          try {
            ws.send(JSON.stringify({
              type: "Error",
              code: "BAD_REQUEST",
              message: "Missing branchId.",
            }));
          } catch { /* noop */ }
          return;
        }

        const old = session.branchId;
        session.branchId = targetBranch;
        console.log(
          `[REPLICATION_GATEWAY] Session ${session.sessionId} switched branch ${old} -> ${targetBranch} (user=${session.userId})`,
        );
        try {
          ws.send(JSON.stringify({ type: "BranchChanged", branchId: targetBranch }));
        } catch { /* noop */ }
        return;
      }

      default:
        return;
    }
  }

  private static sweepHeartbeat(): void {
    this.wss?.clients.forEach((ws: CustomWebSocket) => {
      if (ws.isAlive === false) {
        console.warn(
          `[REPLICATION_GATEWAY] Client dormant; terminating sess=${ws.session?.sessionId ?? "?"}`,
        );
        try { ws.terminate(); } catch { /* noop */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    });
  }

  // -------------------------------------------------------------------------
  // توجيه الأحداث للعملاء
  // -------------------------------------------------------------------------

  private static routeEventToClients(event: ReplicationEvent): void {
    if (!event || !event.id) return;

    const enriched = event as EnrichedReplicationEvent;
    const originSessionId = enriched.originSessionId;
    const scope = enriched.scope;

    this.activeSockets.forEach((ws) => {
      if (!ws.session || ws.readyState !== WebSocket.OPEN) return;

      // ✅ منع الـ loopback: نتخطى العميل اللي أنتج الـ event بس.
      // هذا يحافظ على الـ multi-tab / multi-user sync داخل نفس الفرع.
      if (originSessionId && ws.session.sessionId === originSessionId) return;

      // ✅ فلترة النطاق: لو SAME_BRANCH، نبعتها لعملاء نفس الفرع فقط.
      // ALL_BRANCHES أو بدون قيمة = بث للجميع.
      if (scope === "SAME_BRANCH" && ws.session.branchId !== event.branchId) return;

      // ✅ backpressure: لو العميل بطيء نقفله بدل ما نكدّس بلا نهاية
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        console.warn(
          `[REPLICATION_GATEWAY] Slow consumer (sess=${ws.session.sessionId}, buffered=${ws.bufferedAmount}); terminating.`,
        );
        try { ws.terminate(); } catch { /* noop */ }
        return;
      }

      try {
        ws.send(JSON.stringify({ type: "ReplicationEvent", event }));
      } catch (err: any) {
        console.warn(
          `[REPLICATION_GATEWAY] Failed to send event to sess=${ws.session.sessionId}:`,
          err?.message ?? err,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // الدوال العامة (Helpers)
  // -------------------------------------------------------------------------

  static getActiveSessions(): ClientConnectionInfo[] {
    const list: ClientConnectionInfo[] = [];
    this.activeSockets.forEach((ws) => {
      if (ws.session) list.push({ ...ws.session });
    });
    return list;
  }

  static getSessionsForUser(userId: string): ClientConnectionInfo[] {
    const ids = this.sessionsByUser.get(userId);
    if (!ids) return [];
    const out: ClientConnectionInfo[] = [];
    ids.forEach((sid) => {
      const ws = this.activeSockets.get(sid);
      if (ws?.session) out.push({ ...ws.session });
    });
    return out;
  }

  /**
   * يفصل كل سوكيتس مستخدم معيّن (مثلاً عند logout أو تغيير الباسورد).
   */
  static disconnectUser(userId: string, code = 1000, reason = "Logged out"): number {
    const ids = this.sessionsByUser.get(userId);
    if (!ids) return 0;
    let closed = 0;
    ids.forEach((sid) => {
      const ws = this.activeSockets.get(sid);
      if (ws) {
        try { ws.close(code, reason); closed += 1; } catch { /* noop */ }
      }
    });
    return closed;
  }

  // -------------------------------------------------------------------------
  // أدوات مساعدة
  // -------------------------------------------------------------------------

  /**
   * يستخرج كوكي `token` بأمان حتى لو القيمة فيها `=`.
   */
  private static extractTokenFromCookies(cookieString?: string): string | null {
    if (!cookieString) return null;
    for (const raw of cookieString.split(";")) {
      const cookie = raw.trim();
      if (!cookie) continue;
      const eqIdx = cookie.indexOf("=");
      if (eqIdx === -1) continue;
      const name = cookie.slice(0, eqIdx).trim();
      if (name !== "token") continue;
      const value = cookie.slice(eqIdx + 1).trim();
      if (!value) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  }
  }
