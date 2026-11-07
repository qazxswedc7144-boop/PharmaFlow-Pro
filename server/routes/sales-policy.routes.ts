import { Router, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { tenantPrisma as prisma } from "../database/tenantPrisma.js";
import { OfflineDatabaseError } from "../database/prisma.js";
import { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { requirePermission } from "../middleware/permission.middleware.js";

export const salesPolicyRouter = Router();

const SalesPolicySchema = z.object({
  maxDiscountPercent: z.number().finite().min(0).max(100),
  taxRatePercent: z.number().finite().min(0).max(100),
  taxMode: z.enum(["NONE", "EXCLUSIVE", "INCLUSIVE"])
}).strict().superRefine((policy, ctx) => {
  if (policy.taxMode === "NONE" && policy.taxRatePercent !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxRatePercent"],
      message: "يجب أن تكون نسبة الضريبة صفراً عند تعطيل الضريبة."
    });
  }
  if (policy.taxMode !== "NONE" && policy.taxRatePercent <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxRatePercent"],
      message: "يجب تحديد نسبة ضريبية أكبر من صفر عند تفعيل الضريبة."
    });
  }
});

function getTenantId(req: AuthenticatedRequest): string | null {
  const tenantId = req.user?.tenantId?.trim();
  return tenantId || null;
}

function serializePolicy(policy: any) {
  return {
    tenantId: policy.tenantId,
    maxDiscountPercent: Number(policy.maxDiscountPercent),
    taxRatePercent: Number(policy.taxRatePercent),
    taxMode: policy.taxMode,
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt
  };
}

salesPolicyRouter.get("/", requirePermission("settings.view"), async (req, res: Response) => {
  const tenantId = getTenantId(req as AuthenticatedRequest);
  if (!tenantId) {
    return res.status(403).json({ error: "TENANT_REQUIRED" });
  }

  try {
    const policy = await prisma.tenantSalesPolicy.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {}
    });
    return res.json({ success: true, policy: serializePolicy(policy) });
  } catch (error: any) {
    if (error instanceof OfflineDatabaseError) {
      return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
    }
    return res.status(500).json({ error: "SALES_POLICY_READ_FAILED" });
  }
});

salesPolicyRouter.put("/", requirePermission("settings.update"), async (req, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const tenantId = getTenantId(authReq);
  if (!tenantId) {
    return res.status(403).json({ error: "TENANT_REQUIRED" });
  }

  const parsed = SalesPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_FAILED",
      details: parsed.error.issues.map(issue => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  try {
    const policy = await prisma.$transaction(async (tx: any) => {
      const previous = await tx.tenantSalesPolicy.findUnique({ where: { tenantId } });
      const updated = await tx.tenantSalesPolicy.upsert({
        where: { tenantId },
        create: {
          tenantId,
          maxDiscountPercent: new Prisma.Decimal(parsed.data.maxDiscountPercent),
          taxRatePercent: new Prisma.Decimal(parsed.data.taxRatePercent),
          taxMode: parsed.data.taxMode,
          updatedBy: authReq.user?.userId || null
        },
        update: {
          maxDiscountPercent: new Prisma.Decimal(parsed.data.maxDiscountPercent),
          taxRatePercent: new Prisma.Decimal(parsed.data.taxRatePercent),
          taxMode: parsed.data.taxMode,
          updatedBy: authReq.user?.userId || null
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: authReq.user?.userId || null,
          action: "UPDATE",
          entity: "TenantSalesPolicy",
          entityId: updated.id,
          before: null,
          after: JSON.stringify(serializePolicy(updated)),
          ipAddress: req.ip
        }
      });

      return updated;
    });

    return res.json({ success: true, policy: serializePolicy(policy) });
  } catch (error: any) {
    if (error instanceof OfflineDatabaseError) {
      return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
    }
    return res.status(500).json({ error: "SALES_POLICY_UPDATE_FAILED" });
  }
});
