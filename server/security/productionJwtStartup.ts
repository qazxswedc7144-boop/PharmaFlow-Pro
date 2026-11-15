/**
 * Production startup guard for JWT signing secrets.
 * Deliberately does not inject or generate production secrets.
 */
export function assertProductionJwtSecrets(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.NODE_ENV !== "production") return;

  const access = env.JWT_SECRET?.trim() || "";
  const refresh = env.JWT_REFRESH_SECRET?.trim() || "";

  if (
    Buffer.byteLength(access, "utf8") < 32 ||
    Buffer.byteLength(refresh, "utf8") < 32 ||
    access === refresh
  ) {
    throw new Error("FATAL: Missing or invalid JWT secrets in production");
  }
}
