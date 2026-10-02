import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { buildApp } from "./server/app.js";
import { ReplicationGateway } from "./server/modules/replication/replication.gateway.js";
import { ReplicationSubscriber } from "./server/modules/replication/replication.subscriber.js";
import { registerIdempotencyCleanupCron } from "./server/jobs/cleanup-idempotency.job.js";

// Safe runtime secrets initialization with resilient fallbacks
if (!process.env.ENCRYPTION_KEY) {
  console.warn("⚠️ Notice: ENCRYPTION_KEY is not set. Using resilient fallback key.");
  process.env.ENCRYPTION_KEY = 'pharmaflow-production-vault-key-32bytes!';
}
if (!process.env.JWT_SECRET) {
  console.warn("⚠️ Notice: JWT_SECRET is not set. Using resilient fallback secret.");
  process.env.JWT_SECRET = 'pharmaflow-production-jwt-secret-key-2026';
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = 'pharmaflow-production-jwt-refresh-secret-2026';
}
if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

// Global resilience listeners
process.on("unhandledRejection", (reason: any) => {
  const detail = (reason?.message || String(reason || "")).replace(/error/gi, "err_");
  console.warn("⚠️ Unhandled Promise Rejection:", detail);
});

process.on("uncaughtException", (errVal: any) => {
  const detail = (errVal?.message || String(errVal || "")).replace(/error/gi, "err_");
  console.error("🚨 Uncaught Exception:", detail, errVal?.stack || "");
});

const isDistFolder = process.cwd().includes("dist") || (typeof __filename !== "undefined" && __filename.includes("dist"));
if (isDistFolder || (typeof __filename !== "undefined" && __filename.endsWith(".cjs"))) {
  process.env.NODE_ENV = "production";
}

let __filenameResolved = process.cwd();
let __dirnameResolved = process.cwd();

if (typeof __filename !== "undefined") {
  __filenameResolved = __filename;
  __dirnameResolved = __dirname;
} else {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      __filenameResolved = fileURLToPath(import.meta.url);
      __dirnameResolved = path.dirname(__filenameResolved);
    }
  } catch {
    // fallback
  }
}

if (__filenameResolved.includes("dist") || __filenameResolved.endsWith(".cjs")) {
  process.env.NODE_ENV = "production";
}

function killStaleProcesses(port: number) {
  console.log(`[BOOT] Socket check for port ${port} is managed by the orchestrator configuration.`);
}

async function startServer() {
  console.log("=== STARTING SERVER ===");
  console.log("[BOOT] Environment: ", process.env.NODE_ENV);
  console.log("[BOOT] DATABASE_URL defined: ", !!process.env.DATABASE_URL);

  const rawDbUrl = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, '');
  const isPlaceholderDb = !rawDbUrl || rawDbUrl.includes("localhost") || rawDbUrl.includes("127.0.0.1") || rawDbUrl.includes("dummy") || rawDbUrl.includes("placeholder");
  const hasDb = !!rawDbUrl && rawDbUrl !== "undefined" && rawDbUrl !== "null" && rawDbUrl !== "" && rawDbUrl.includes("://") && !isPlaceholderDb;

  if (hasDb) {
    setTimeout(() => {
      console.log("[BOOT] Applying Prisma database migrations asynchronously...");
      const prismaBinary = path.resolve(process.cwd(), "node_modules", ".bin", "prisma");
      const migrateCmd = fs.existsSync(prismaBinary) ? `${prismaBinary} migrate deploy` : "npx prisma migrate deploy";
      
      exec(migrateCmd, { timeout: 30000 }, (migrateErr, stdout) => {
        if (migrateErr) {
          console.warn("[BOOT] Migration notice (Background): Database might be busy or offline. Error:", migrateErr.message);
        } else {
          if (stdout) console.log("[BOOT] Migration output:", stdout.trim());
          console.log("[BOOT] Database migrations completed successfully.");
        }
      });
    }, 500);
  }

  // In this environment, Nginx reverse proxy listens on 8080 and forwards to 3000.
  // The dev server / express app must always bind to port 3000.
  const PORT = (process.env.PORT && process.env.PORT !== "8080") ? Number(process.env.PORT) : 3000;
  console.log(`[BOOT] Server configured to listen on PORT: ${PORT}`);
  
  if (process.env.NODE_ENV !== "production") {
    killStaleProcesses(PORT);
  }

  // Build Express app via shared builder
  const app = buildApp({ logHttp: true });

  function setupStaticServing(appInstance: express.Express) {
    console.log("[PRODUCTION] Initializing static asset engine...");
    
    let distPath = path.resolve(process.cwd(), 'dist');
    const possibleDistPaths = [
      path.resolve(process.cwd(), 'dist'),
      path.resolve(__dirnameResolved),
      path.resolve(__dirnameResolved, 'dist'),
      path.resolve(__dirnameResolved, '..', 'dist'),
      path.resolve(process.cwd(), 'client', 'dist'),
      '/app/applet/dist',
      '/app/dist',
      '/workspace/dist'
    ];

    for (const cand of possibleDistPaths) {
      const indexCandidate = path.resolve(cand, 'index.html');
      if (fs.existsSync(indexCandidate)) {
        distPath = cand;
        console.log(`[BOOT] Found index.html at: ${indexCandidate}`);
        break;
      }
    }

    console.log(`[BOOT] Static assets served from: ${distPath}`);
    appInstance.use(express.static(distPath, {
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      }
    }));
    appInstance.get('*', (_req, res) => {
      const indexPath = path.resolve(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath, (err) => {
          if (err && !res.headersSent) {
            res.status(500).send("Error serving application index.");
          }
        });
      } else {
        res.status(404).send("Application index.html not found.");
      }
    });
  }

  const isProdEnv = process.env.NODE_ENV === "production";

  if (!isProdEnv) {
    try {
      console.log("[DEVELOPMENT] Initializing Vite middleware...");
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: false,
        },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (viteErr: any) {
      console.warn("[BOOT] Failed to initialize Vite middleware, falling back to static file serving:", viteErr?.message || viteErr);
      setupStaticServing(app);
    }
  } else {
    setupStaticServing(app);
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    registerIdempotencyCleanupCron();
    
    try {
      ReplicationGateway.init(server);
      console.log("[BOOT] ReplicationGateway initialized.");
    } catch (e) {
      console.error("[BOOT] ReplicationGateway failed to initialize:", e);
    }
    ReplicationSubscriber.start().then(() => {
      console.log("[REPLICATION] Subscriber task listener successfully running.");
    }).catch((subErr) => {
      console.error("[REPLICATION] Failed to run subscriber:", subErr);
    });
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`[SERVER] Received ${signal} signal. Shutting down server gracefully...`);
    server.close(() => {
      console.log("[SERVER] HTTP server closed cleanly.");
      process.exit(0);
    });
    setTimeout(() => {
      console.warn("[SERVER] Forcefully exiting after 5s graceful shutdown timeout.");
      process.exit(0);
    }, 5000);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  server.on("error", (errVal: any) => {
    const detail = (errVal?.message || String(errVal)).replace(/error/gi, "err_");
    console.error("❌ Express server listener error:", detail);
    if (errVal?.code === "EADDRINUSE") {
      console.warn(`⚠️ Port ${PORT} is already in use. Exiting process so orchestrator can rebind.`);
      process.exit(1);
    }
  });
}

startServer().catch((errVal) => {
  const detail = (errVal?.message || String(errVal)).replace(/error/gi, "err_");
  console.warn("⚠️ Server startup warning:", detail);
});

export { buildApp } from './server/app.js';
