// apps/api/src/modules/auth/auth.service.ts
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../../../../server/database/prisma.js";
import { Role } from "@prisma/client";

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

// ✅ إصلاح 1: إضافة tenantId إلى واجهات الأنواع
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
   * Token generator representing valid authorization duration (e.g., 1 hour).
   */
  // ✅ إصلاح 2: تمرير وحفظ tenantId داخل التوكن
  static generateAccessToken(user: { id: string; username: string; role: Role; tenantId: string }): string {
    return jwt.sign(
      { 
        userId: user.id, 
        username: user.username, 
        role: user.role,
        tenantId: user.tenantId // 👈 إجباري لعزل المؤسسات
      },
      getJwtSecret(),
      { expiresIn: "4h", algorithm: "HS256" } // ✅ تحديد الخوارزمية
    );
  }

  /**
   * Refreshes JWT tokens allowing users to request a new session within 7 days.
   */
  // ✅ إصلاح 3: تمرير وحفظ tenantId داخل توكن التحديث
  static generateRefreshToken(user: { id: string; tenantId: string }): string {
    return jwt.sign(
      { userId: user.id, tenantId: user.tenantId }, 
      getJwtRefreshSecret(),
      { expiresIn: "7d", algorithm: "HS256" } // ✅ تحديد الخوارزمية
    );
  }

  /**
   * Safe payload parsing for verification of access signatures.
   */
  static verifyAccessToken(token: string): DecodedAccessToken {
    // ✅ إصلاح أمني: منع Algorithm Confusion
    return jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as DecodedAccessToken;
  }

  /**
   * Safe payload parsing for verification of refresh signatures.
   */
  static verifyRefreshToken(token: string): DecodedRefreshToken {
    // ✅ إصلاح أمني: منع Algorithm Confusion
    return jwt.verify(token, getJwtRefreshSecret(), { algorithms: ["HS256"] }) as DecodedRefreshToken;
  }

  /**
   * Generates or retrieves active server-side sessions.
   */
  static async createSession(userId: string, token: string, ip?: string, agent?: string) {
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours
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
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
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
    } catch (e) {
      // Already deleted or non-existent
    }
  }

  static async revokeRefreshToken(token: string) {
    try {
      await prisma.refreshToken.update({
        where: { token },
        data: { revoked: true }
      });
    } catch (e) {
      // Already revoked or non-existent
    }
  }
}
