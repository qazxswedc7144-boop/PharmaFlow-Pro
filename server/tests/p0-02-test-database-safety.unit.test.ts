import { describe, expect, it } from "vitest";
import { isSafeP0TestDatabase } from "./helpers/p0-02-test-database-safety.js";

const validEnvironment = {
  NODE_ENV: "test",
  CI: "true",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/pharmaflow_test?schema=public",
};

describe("P0-02 integration database safety guard", () => {
  it("allows only the isolated local CI PostgreSQL database", () => {
    expect(isSafeP0TestDatabase(validEnvironment)).toEqual({ safe: true });
  });

  it.each([
    ["production Supabase host", "postgresql://postgres:secret@db.example.supabase.co:5432/pharmaflow_test?schema=public"],
    ["remote host with a test-like name", "postgresql://postgres:secret@db.example.com:5432/pharmaflow_test?schema=public"],
    ["production database with test substring", "postgresql://postgres:secret@localhost:5432/production_test?schema=public"],
    ["wrong database", "postgresql://postgres:secret@localhost:5432/postgres?schema=public"],
    ["nonstandard port", "postgresql://postgres:secret@localhost:6543/pharmaflow_test?schema=public"],
    ["host override parameter", "postgresql://postgres:secret@localhost:5432/pharmaflow_test?schema=public&host=db.example.com"],
    ["database override parameter", "postgresql://postgres:secret@localhost:5432/pharmaflow_test?schema=public&dbname=production"],
    ["duplicate schema parameter", "postgresql://postgres:secret@localhost:5432/pharmaflow_test?schema=public&schema=other"],
    ["fragment", "postgresql://postgres:secret@localhost:5432/pharmaflow_test?schema=public#production"],
    ["malformed URL", "not-a-database-url"],
  ])("rejects %s", (_label, DATABASE_URL) => {
    expect(isSafeP0TestDatabase({ ...validEnvironment, DATABASE_URL }).safe).toBe(false);
  });

  it.each([
    ["missing CI marker", { ...validEnvironment, CI: undefined }],
    ["CI marker not true", { ...validEnvironment, CI: "false" }],
    ["wrong node environment", { ...validEnvironment, NODE_ENV: "production" }],
    ["missing database URL", { NODE_ENV: "test", CI: "true" }],
  ])("rejects unsafe environment: %s", (_label, env) => {
    expect(isSafeP0TestDatabase(env).safe).toBe(false);
  });
});
