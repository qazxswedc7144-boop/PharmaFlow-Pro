type TestDatabaseEnvironment = {
  DATABASE_URL?: string;
  NODE_ENV?: string;
  CI?: string;
};

/**
 * The P0-02 integration suite creates and deletes database records.
 * It may only run against the exact local PostgreSQL service provisioned by CI.
 * A database name containing "test" is not sufficient to establish isolation.
 */
export function isSafeP0TestDatabase(
  env: TestDatabaseEnvironment = process.env,
): { safe: boolean; reason?: string } {
  if (env.NODE_ENV !== "test" || env.CI !== "true") {
    return { safe: false, reason: 'NODE_ENV must be "test" and CI must be "true"' };
  }

  if (!env.DATABASE_URL) {
    return { safe: false, reason: "DATABASE_URL is not set" };
  }

  let parsed: URL;
  try {
    parsed = new URL(env.DATABASE_URL);
  } catch {
    return { safe: false, reason: "DATABASE_URL is not a valid URL" };
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { safe: false, reason: "DATABASE_URL must use the PostgreSQL protocol" };
  }

  // Do not accept DNS names, remote hosts, sockets, or alternate connection ports.
  // This suite is wired to the localhost:5432 PostgreSQL service in GitHub Actions.
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    return { safe: false, reason: "database host must be localhost or 127.0.0.1" };
  }

  if (parsed.port !== "5432") {
    return { safe: false, reason: "database port must be 5432" };
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return { safe: false, reason: "database name is not valid URL encoding" };
  }

  // Exact allow-list: substring checks such as "prod_test" are unsafe.
  if (databaseName !== "pharmaflow_test") {
    return { safe: false, reason: 'database name must be exactly "pharmaflow_test"' };
  }

  // Prisma needs only the schema parameter here. Reject libpq/pg connection
  // overrides (host, hostaddr, port, dbname, service, options, etc.).
  const queryKeys = [...parsed.searchParams.keys()];
  if (queryKeys.some((key) => key !== "schema")) {
    return { safe: false, reason: "DATABASE_URL contains unsupported connection overrides" };
  }
  if (parsed.searchParams.getAll("schema").length > 1) {
    return { safe: false, reason: "DATABASE_URL contains duplicate schema parameters" };
  }
  if (parsed.hash) {
    return { safe: false, reason: "DATABASE_URL must not contain a fragment" };
  }

  return { safe: true };
}
