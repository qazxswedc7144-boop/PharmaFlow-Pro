// apps/api/src/modules/auth/auth.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { AuthController } from "./auth.controller.js";
import { authMiddleware } from "./auth.middleware.js";
import { LoginSchema, RefreshTokenSchema } from "./auth.schema.js";
import { validateRequestBody } from "../../../../../server/middleware/validate.js";

export const authV1Router = Router();

// Brute-force credentials limit protection layer
const loginFallbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes duration
  max: 10, // Max 10 attempts
  message: {
    error: "RATE_LIMIT_EXCEEDED",
    message: "تم تقييد محاولات تسجيل الدخول حماية للحسابات من هجمات القوة الغاشمة. يرجى الانتظار 15 دقيقة."
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false }
});

// 🚨 SECURITY FIX: Add rate limiting to the refresh endpoint to prevent DoS and token brute-forcing
const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Allow slightly more requests for legitimate background refreshes
  message: {
    error: "RATE_LIMIT_EXCEEDED",
    message: "تم تقييد محاولات تحديث الجلسة. يرجى تسجيل الدخول مجدداً."
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false }
});

authV1Router.post("/login", loginFallbackLimiter, validateRequestBody(LoginSchema), AuthController.login);
authV1Router.post("/refresh", refreshTokenLimiter, validateRequestBody(RefreshTokenSchema), AuthController.refresh);
// Note: /logout intentionally lacks authMiddleware to allow session revocation even if the access token is expired.
authV1Router.post("/logout", AuthController.logout);
authV1Router.get("/me", authMiddleware, AuthController.me);
