import { createHash, randomBytes } from "node:crypto";

const DEVELOPMENT_ACCESS_SECRET = randomBytes(32).toString("base64url");
const DEVELOPMENT_REFRESH_SECRET = randomBytes(32).toString("base64url");

const LEGACY_ACCESS_SECRET_HASH = "e68ffb9e56ff36097dfacd0c88f218c91750d39708995868f28c09a04c77470c";
const LEGACY_REFRESH_SECRET_HASH = "a1e7b26aa051938728900f28c82c5e25019b1568bbc903a140aa1b655cc89247";

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function validateProductionSecrets(): { access: string; refresh: string } {
  const access = process.env.JWT_SECRET?.trim() || "";
  const refresh = process.env.JWT_REFRESH_SECRET?.trim() || "";

  if (!access) {
    throw new Error("FATAL: JWT_SECRET must be configured in production.");
  }
  if (!refresh) {
    throw new Error("FATAL: JWT_REFRESH_SECRET must be configured in production.");
  }

  const accessHash = createHash("sha256").update(access).digest("hex");
  const refreshHash = createHash("sha256").update(refresh).digest("hex");
  const knownDevelopmentSecretHashes = new Set([LEGACY_ACCESS_SECRET_HASH, LEGACY_REFRESH_SECRET_HASH]);
  if (knownDevelopmentSecretHashes.has(accessHash) || knownDevelopmentSecretHashes.has(refreshHash)) {
    throw new Error("FATAL: A known development JWT secret cannot be used in production.");
  }
  if (Buffer.byteLength(access, "utf8") < 32 || Buffer.byteLength(refresh, "utf8") < 32) {
    throw new Error("FATAL: Production JWT secrets must each contain at least 32 bytes.");
  }
  if (access === refresh) {
    throw new Error("FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be different values.");
  }

  return { access, refresh };
}

/**
 * Production never falls back to a source-controlled secret.
 * Development/test use per-process random secrets unless explicit env values exist.
 */
export function getJwtSecret(): string {
  if (isProductionRuntime()) return validateProductionSecrets().access;
  return process.env.JWT_SECRET?.trim() || DEVELOPMENT_ACCESS_SECRET;
}

export function getJwtRefreshSecret(): string {
  if (isProductionRuntime()) return validateProductionSecrets().refresh;

  const access = process.env.JWT_SECRET?.trim();
  const refresh = process.env.JWT_REFRESH_SECRET?.trim();
  if (access && refresh && access === refresh) {
    throw new Error("JWT_SECRET and JWT_REFRESH_SECRET must be different values.");
  }
  return refresh || DEVELOPMENT_REFRESH_SECRET;
}
