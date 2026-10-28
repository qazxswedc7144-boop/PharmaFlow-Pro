// apps/api/src/modules/auth/auth.service.ts
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../../../../server/database/prisma.js";
import { Role } from "@prisma/client";

// 🚨 FIX: Centralized constants to prevent expiration drift between JWT and DB records
const ACCESS_TOKEN_EXPIRY_STR = "4h";
const ACCESS_TOKEN_EXPIRY_MS = 4 * 60 * 60 * 1000;
const REFRESH_TOKEN_EXPIRY_STR = "7d";
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET environment variable is missing in production.');
    }
    return 'pharmaflow-local-development-jwt-secure-secret-2026';
  }
  return secret;
};

const getJwtRefreshSecret = () => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_REFRESH_SECRET environment variable is missing in production.');
    }
    return 'pharmaflow-local-development-jwt-refresh-secure-secret-2026';
  }
  return secret;
};

export interface DecodedAccessToken {
  userId: string;
  username: string;
  role: Role;
  tenantId: string;
}

export interface DecodedRefreshToken {
  userId: string;
  tenantId: string;
}

export class AuthService {
  /**
   * Secure bcrypt salt generation and hashing with 12 cycles.
   */
  static async hashPassword(password: string): Promise<string> {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Standard secure comparison of plain texts against stored hashes.
   */
  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Token generator representing valid authorization duration.
   */
  // 🚨 FIX: Accept both `userId` and `id` to support the updated AuthController payload while maintaining backwards compatibility
  static generateAccessToken(user: { id?: string; userId?: string; username: string; role: Role; tenantId: string }): string {
    const finalUserId = user.userId || user.id;
    if (!finalUserId) throw new Error("USER_ID_REQUIRED: Cannot generate token without user ID.");

    return jwt.sign(
      { 
        userId: finalUserId, 
        username: user.username, 
        role: user.role,
        tenantId: user.tenantId
      },
      getJwtSecret(),
      { expiresIn: ACCESS_TOKEN_EXPIRY_STR, algorithm: "HS256" }
    );
  }

  /**
   * Refreshes JWT tokens allowing users to request a new session.
   */
  // 🚨 FIX: Accept both `userId` and `id`
  static generateRefreshToken(user: { id?: string; userId?: string; tenantId: string }): string {
    const finalUserId = user.userId || user.id;
    if (!finalUserId) throw new Error("USER_ID_REQUIRED: Cannot generate refresh token without user ID.");

    return jwt.sign(
      { userId: finalUserId, tenantId: user.tenantId }, 
      getJwtRefreshSecret(),
      { expiresIn: REFRESH_TOKEN_EXPIRY_STR, algorithm: "HS256" }
    );
  }

  /**
   * Safe payload parsing for verification of access signatures.
   */
  static verifyAccessToken(token: string): DecodedAccessToken {
    return jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as DecodedAccessToken;
  }

  /**
   * Safe payload parsing for verification of refresh signatures.
   */
  static verifyRefreshToken(token: string): DecodedRefreshToken {
    return jwt.verify(token, getJwtRefreshSecret(), { algorithms: ["HS256"] }) as DecodedRefreshToken;
  }

  /**
   * Generates or retrieves active server-side sessions.
   */
  static async createSession(userId: string, token: string, ip?: string, agent?: string) {
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_EXPIRY_MS);
    return prisma.session.create({
      data: {
        userId,
        token,
        ipAddress: ip || null,
        userAgent: agent || null,
        expiresAt
      }
    });
  }

  /**
   * Refreshes access tokens when validated against the database refresh tokens.
   */
  static async createRefreshTokenRecord(userId: string, token: string) {
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);
    return prisma.refreshToken.create({
      data: {
        userId,
        token,
        expiresAt
      }
    });
  }

  /**
   * Revokes matching tokens to secure session termination.
   */
  static async revokeSession(token: string) {
    try {
      await prisma.session.delete({
        where: { token }
      });
    } catch (e: any) {
      // 🚨 FIX: Log unexpected errors instead of failing silently, but maintain idempotency
      if (e.code !== 'P2025') {
        console.warn("[AuthService] Unexpected error revoking session:", e.message);
      }
    }
  }

  static async revokeRefreshToken(token: string) {
    try {
      await prisma.refreshToken.update({
        where: { token },
        data: { revoked: true }
      });
    } catch (e: any) {
      // 🚨 FIX: Log unexpected errors instead of failing silently
      if (e.code !== 'P2025') {
        console.warn("[AuthService] Unexpected error revoking refresh token:", e.message);
      }
    }
  }
}
