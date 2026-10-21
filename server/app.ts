import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import securityRouter from "./routes/security.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { invoiceRouter } from "./routes/invoice.routes.js";
import { accountingRouter } from "./routes/accounting.routes.js";
import { inventoryRouter } from "./routes/inventory.routes.js";
import { lockingRouter } from "./modules/locking/locking.router.js";
import { consolidationRouter } from "./modules/consolidation/consolidation.router.js";
import { replicationRouter } from "./modules/replication/replication.router.js";
import { saasRouter } from "./modules/saas/saas.router.js";
import { aiRouter } from "./routes/ai.routes.js";
import { idempotencyMiddleware } from "./modules/idempotency/idempotency.middleware.js";
import { requestContextPlugin } from "../apps/api/src/plugins/request-context.js";
import { authV1Router } from "../apps/api/src/modules/auth/auth.routes.js";
import { syncV1Router } from "../apps/api/src/modules/sync/sync.routes.js";
import { subscriptionGuard } from "./middleware/subscription.middleware.js";
import { authenticateToken } from "./middleware/auth.middleware.js";
import { tenantContextMiddleware } from "./middleware/tenant.middleware.js";
import organizationRouter from "./routes/organization.routes.js";
import rbacRouter from "./routes/rbac.routes.js";
import { reportingRouter } from "./routes/reporting.routes.js";
import { platformRouter } from "./modules/platform/platform.router.js";
import { prisma } from "./database/prisma.js";

export interface BuildAppOptions {
  logHttp?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.disable('x-powered-by');

  // 1. Health check endpoints (Public)
  app.all(["/api/health", "/health", "/healthz", "/ready", "/live", "/_ah/health", "/_ah/start", "/ping"], async (_req, res) => {
    let dbStatus = "NOT_CONFIGURED";
    try {
      if (process.env.DATABASE_URL) {
        await prisma.$queryRaw`SELECT 1`;
        dbStatus = "CONNECTED";
      } else {
        dbStatus = "OFFLINE_FALLBACK";
      }
    } catch (err: any) {
      console.warn("[Health] Database query check notice:", err?.message || err);
      dbStatus = "OFFLINE_FALLBACK";
    }

    res.status(200).json({ 
      status: "ok", 
      env: process.env.NODE_ENV || "development", 
      database: dbStatus,
      version: "1.2.0-prod",
      timestamp: new Date().toISOString()
    });
  });

  if (options.logHttp) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on("finish", () => {
        const duration = Date.now() - start;
        const sanitizedUrl = req.url.replace(/error/gi, "err");
        console.log(`[HTTP LOG] ${req.method} ${sanitizedUrl} - Status: ${res.statusCode} - IP: ${req.ip} - ${duration}ms`);
      });
      next();
    });
  }

  // 2. Security Headers & Rate Limiting
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: false,
    xFrameOptions: false,
    xssFilter: true,
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
  }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2500,
    message: "Too many requests from this IP, please try again after 15 minutes",
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false },
  });
  app.use("/api/", limiter);

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.use(requestContextPlugin);
  app.use(idempotencyMiddleware);

  // =========================================================================
  // 3. PUBLIC ROUTES (No Auth Required)
  // =========================================================================
  app.use("/api/auth", authRouter);
  app.use("/api/v1/auth", authV1Router);

  // =========================================================================
  // 4. EXTERNAL INTEGRATIONS (SaaS / FHIR - Auth via API Keys)
  // =========================================================================
  const isSaasDemoEnabled = (): boolean => {
    if (process.env.NODE_ENV === "production") {
      return process.env.ENABLE_SAAS_DEMO_ENDPOINTS === "true";
    }
    return process.env.ENABLE_SAAS_DEMO_ENDPOINTS !== "false";
  };

  const validateSaasApiKey = (requiredScope: string) => {
    return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "security", diagnostics: "Missing or invalid Authorization header. Expected Bearer token." }]
        });
      }
      const token = authHeader.split(" ")[1];

      // 🚨 SEC-02 FIX: Fail closed. Absolutely NO hardcoded fallback keys or tenantIds.
      const mouwasatKey = process.env.SAAS_KEY_MOUWASAT?.trim();
      const cloudSyncKey = process.env.SAAS_KEY_CLOUD_SYNC?.trim();
      const mouwasatTenant = process.env.SAAS_MOUWASAT_TENANT_ID?.trim();
      const cloudSyncTenant = process.env.SAAS_CLOUD_SYNC_TENANT_ID?.trim();

      const validKeys: Array<{ name: string; key: string; scopes: string[]; tenantId: string }> = [];

      if (mouwasatKey && mouwasatTenant) {
        validKeys.push({
          name: "Mouwasat EHR Gateway",
          key: mouwasatKey,
          scopes: ["fhir.read", "fhir.write"],
          tenantId: mouwasatTenant
        });
      }

      if (cloudSyncKey && cloudSyncTenant) {
        validKeys.push({
          name: "Cloud Sync Ledger Gateway",
          key: cloudSyncKey,
          scopes: ["financials.read", "inventory.write", "fhir.read"],
          tenantId: cloudSyncTenant
        });
      }

      if (validKeys.length === 0) {
        return res.status(503).json({
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "security", diagnostics: "SaaS gateway authentication is not configured (FAIL CLOSED)." }]
        });
      }

      const verified = validKeys.find(k => k.key === token);
      if (!verified) {
        return res.status(403).json({
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "forbidden", diagnostics: "Provided API key is invalid, expired or revoked." }]
        });
      }

      if (!verified.scopes.includes(requiredScope)) {
        return res.status(403).json({
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "forbidden", diagnostics: `Insufficient scopes. Required scope: [${requiredScope}]` }]
        });
      }

      (req as any).apiKeyName = verified.name;
      (req as any).tenantId = verified.tenantId;
      next();
    };
  };

  // FHIR Prototype endpoints (SEC-03 FIX: Guarded by feature flag)
  app.get("/api/v1/saas/fhir/Patient", validateSaasApiKey("fhir.read"), (_req, res) => {
    if (!isSaasDemoEnabled()) {
      return res.status(404).json({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: "FHIR Patient prototype endpoint is disabled in this environment." }]
      });
    }
    // ... Demo payload remains the same ...
    res.json({ resourceType: "Bundle", id: "bundle-pat-dallah-2026", type: "searchset", meta: { lastUpdated: new Date().toISOString() }, total: 2, entry: [] });
  });

  app.post("/api/v1/saas/sync", validateSaasApiKey("financials.read"), (req, res) => {
    const { ciphertext, tenantId: bodyTenantId } = req.body;
    if (!ciphertext) return res.status(400).json({ error: "Empty cryptographic packet. Ciphertext required." });

    const authenticatedTenantId = (req as any).tenantId;

    if (bodyTenantId && bodyTenantId !== authenticatedTenantId) {
      return res.status(403).json({ error: "TENANT_MISMATCH", message: "Forbidden: Request body tenantId does not match authenticated credential context." });
    }

    res.json({ status: "SUCCESS", syncId: `sync-tx-${Math.random().toString(36).substring(3, 11)}`, timestamp: new Date().toISOString(), tenantId: authenticatedTenantId });
  });

  // =========================================================================
  // 5. INTERNAL PROTECTED ROUTES (Auth + Tenant Isolation)
  // 🚨 SEC-01 FIX: Global authentication applied to ALL /api routes below.
  // =========================================================================
  app.use("/api", authenticateToken);
  app.use("/api", tenantContextMiddleware);
  app.use("/api", subscriptionGuard);

  // All internal modules are safely protected below:
  app.use("/api/security", securityRouter);
  app.use("/api/v1/sync", syncV1Router);
  app.use("/api/sync", syncV1Router);
  app.use("/api/invoices", invoiceRouter);
  app.use("/api/accounting", accountingRouter);
  app.use("/api/inventory", inventoryRouter);
  app.use("/api/locks", lockingRouter);
  app.use("/api/consolidation", consolidationRouter);
  app.use("/api/replication", replicationRouter);
  app.use("/api/saas", saasRouter);
  app.use("/api/platform", platformRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/organization", organizationRouter);
  app.use("/api/rbac", rbacRouter);
  app.use("/api/reports", reportingRouter);

  // =========================================================================
  // 6. Fallbacks & Error Handlers
  // =========================================================================
  app.use("/api/*", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found" });
  });

  app.use(
    (
      err: Error & { statusCode?: number; status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err.statusCode ?? err.status ?? 500;

      console.error('[Global Error Handler]', {
        message: err.message,
        code: err.code,
        status,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
      });

      const isProd = process.env.NODE_ENV === 'production';
      const safeMessage = isProd && status >= 500 ? 'An internal error occurred. Please contact support.' : err.message;

      res.status(status).json({
        error: err.code || 'INTERNAL_ERROR',
        message: safeMessage,
        timestamp: new Date().toISOString(),
      });
    },
  );

  return app;
}
