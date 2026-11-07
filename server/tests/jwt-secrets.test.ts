import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJwtRefreshSecret, getJwtSecret, isProductionRuntime } from "../security/jwtSecrets.js";

describe("production JWT secret configuration", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("JWT_SECRET", "");
    vi.stubEnv("JWT_REFRESH_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses per-process random secrets only outside production", () => {
    const access = getJwtSecret();
    const refresh = getJwtRefreshSecret();

    expect(access).toHaveLength(43);
    expect(refresh).toHaveLength(43);
    expect(access).not.toBe(refresh);
    expect(getJwtSecret()).toBe(access);
    expect(getJwtRefreshSecret()).toBe(refresh);
  });

  it("treats Vercel production as production even if NODE_ENV is not set to production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isProductionRuntime()).toBe(true);
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET must be configured/);
  });

  it("fails closed when either production secret is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "a".repeat(40));
    expect(() => getJwtSecret()).toThrow(/JWT_REFRESH_SECRET must be configured/);
  });

  it("rejects production secrets shorter than 32 bytes", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "a".repeat(31));
    vi.stubEnv("JWT_REFRESH_SECRET", "b".repeat(40));
    expect(() => getJwtSecret()).toThrow(/at least 32 bytes/);
  });

  it("rejects the former source-controlled development secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "pharmaflow-local-development-jwt-secure-secret-2026");
    vi.stubEnv("JWT_REFRESH_SECRET", "pharmaflow-local-development-jwt-refresh-secure-secret-2026");
    expect(() => getJwtSecret()).toThrow(/known development JWT secret/);
  });

  it("requires distinct access and refresh secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "same-secret-value-which-is-long-enough-123");
    vi.stubEnv("JWT_REFRESH_SECRET", "same-secret-value-which-is-long-enough-123");
    expect(() => getJwtSecret()).toThrow(/must be different/);
  });

  it("returns explicitly configured strong production secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "access-secret-with-strong-randomness-0123456789");
    vi.stubEnv("JWT_REFRESH_SECRET", "refresh-secret-with-strong-randomness-9876543210");

    expect(getJwtSecret()).toBe("access-secret-with-strong-randomness-0123456789");
    expect(getJwtRefreshSecret()).toBe("refresh-secret-with-strong-randomness-9876543210");
  });
});
