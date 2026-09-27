const fs = require('fs');
let content = fs.readFileSync('server/app.ts', 'utf8');

const target = `  app.all(["/api/health", "/health", "/healthz", "/ready", "/live", "/_ah/health", "/_ah/start", "/ping"], async (_req, res) => {
    let dbStatus = "NOT_CONFIGURED";`;

const replacement = `  app.all(["/api/health", "/health", "/healthz", "/ready", "/live", "/_ah/health", "/_ah/start", "/ping"], async (_req, res) => {
    console.log("[DB_HEALTH] env check:", {
      hasDatabaseUrl: typeof process.env.DATABASE_URL === 'string' 
                      && process.env.DATABASE_URL.length > 0,
      databaseUrlLength: process.env.DATABASE_URL?.length ?? 0,
      hasDirectUrl: typeof process.env.DIRECT_URL === 'string' 
                    && process.env.DIRECT_URL.length > 0,
      nodeEnv: process.env.NODE_ENV,
      hasVercel: !!process.env.VERCEL,
    });
    let dbStatus = "NOT_CONFIGURED";`;

if (content.includes(target)) {
  content = content.replace(target, replacement);
  fs.writeFileSync('server/app.ts', content, 'utf8');
  console.log("Successfully updated server/app.ts health check");
} else {
  console.error("ERROR: Target health check not found in server/app.ts");
  process.exit(1);
}
