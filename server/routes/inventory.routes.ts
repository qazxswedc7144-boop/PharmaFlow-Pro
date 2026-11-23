// server/routes/inventory.routes.ts
import { Router, Response } from "express";
import { tenantPrisma as prisma } from "../database/tenantPrisma.js";
import { runInTransaction } from "../core/database/transactionGuard.js";
import { FifoService } from "../modules/inventory/services/fifo.service.js";
import { authenticateToken, requireRoles, AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { Role } from "@prisma/client";
import { LockingService } from "../modules/locking/locking.service.js";
import { ReplicationPublisher } from "../modules/replication/replication.publisher.js";
import { StockMoveSchema } from "../../src/shared/validation/inventory.schema.js";
import { validateRequestBody } from "../middleware/validate.js";

export const inventoryRouter = Router();

/**
 * POST /api/inventory/move
 * Post custom inward stock additions or adjustments securely.
 */
inventoryRouter.post("/move", authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN, Role.INVENTORY_MANAGER]), validateRequestBody(StockMoveSchema), async (req: AuthenticatedRequest, res: Response) => {
  const data = req.body; // sanitized and verified by validateRequestBody
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    return res.status(401).json({
      error: "TENANT_REQUIRED",
      message: "A trusted tenant context is required for inventory mutations."
    });
  }
  const key = `inventory:${data.productId}`;
  const headerBranchId = req.headers["x-branch-id"] || req.headers["branch-id"];
  const branchId = req.user?.branchId || (typeof headerBranchId === "string" ? headerBranchId.trim() : "");
  const userId = req.user?.userId || "SYSTEM";
  if (!branchId) {
    return res.status(400).json({ error: "TRUSTED_BRANCH_CONTEXT_REQUIRED", message: "يجب تحديد فرع موثوق لتنفيذ حركة المخزون." });
  }
  if (req.user?.branchId && headerBranchId && String(headerBranchId).trim() !== req.user.branchId) {
    return res.status(403).json({ error: "BRANCH_MISMATCH", message: "الفرع المطلوب لا يطابق الفرع المرتبط بجلسة المستخدم." });
  }
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, tenantId },
    select: { id: true }
  });
  if (!branch) {
    return res.status(403).json({ error: "BRANCH_NOT_IN_TENANT", message: "الفرع لا ينتمي إلى المؤسسة المصادق عليها." });
  }
  const membership = await prisma.branchUser.findFirst({
    where: { userId, branchId, tenantId },
    select: { id: true }
  });
  if (!membership) {
    return res.status(403).json({ error: "BRANCH_MEMBERSHIP_REQUIRED", message: "لا توجد عضوية مستخدم معتمدة لهذا الفرع." });
  }

  // Acquire Redis lock
  const lock = await LockingService.acquireLock({
    key,
    branchId,
    lockType: "INVENTORY",
    ownerId: userId,
    ttl: 15000 // 15s lock TTL for adjustments
  });

  if (!lock) {
    return res.status(423).json({
      error: "LOCK_CONFLICT",
      message: "The requested medicine is currently locked by another inventory transaction. Please try again soon."
    });
  }

  try {
    const refId = `ADJ-${Date.now()}`;

    await runInTransaction("InventoryService", async (tx) => {
      if (data.qty > 0) {
        // Stock addition
        await FifoService.addStock(
          tx,
          data.productId,
          data.batchNumber,
          data.qty,
          data.cost,
          data.expiryDate,
          refId,
          "ADJUSTMENT",
          data.reason || "Manual Stock Intake Adjustment",
          tenantId
        );
      } else {
        // Stock depletion / write off
        await FifoService.depleteStock(
          tx,
          data.productId,
          Math.abs(data.qty),
          refId,
          "ADJUSTMENT",
          data.reason || "Manual Stock Depletion Adjustment",
          tenantId,
          undefined,
          branchId
        );
      }

      // Record audit details
      await tx.auditLog.create({
        data: {
          tenantId: (req as any).tenantId || req.user?.tenantId || null,
          userId: req.user?.userId || null,
          action: "UPDATE",
          entity: "Product",
          entityId: data.productId,
          before: null,
          after: JSON.stringify(data),
          ipAddress: req.ip
        }
      });
    });

    // Broadcast inventory updated in real-time
    try {
      await ReplicationPublisher.publish({
        type: "InventoryUpdated",
        branchId,
        userId,
        tenantId: (req as any).tenantId || req.user?.tenantId,
        payload: {
          productId: data.productId,
          qty: data.qty,
          batchNumber: data.batchNumber || "ADJUSTMENT-BATCH",
          reason: data.reason || "Manual Stock Movement"
        }
      });
    } catch (repErr: any) {
      console.warn("[REPLICATION] Failed to publish inventory modification event:", repErr.message);
    }

    return res.json({
      success: true,
      message: "Warehouse movement posted and calculated dynamically."
    });
  } catch (err: any) {
    return res.status(400).json({
      error: "MOVEMENT_FAILED",
      message: err.message || err
    });
  } finally {
    await LockingService.releaseLock(key, lock.id, branchId, userId);
  }
});

/**
 * GET /api/inventory/batches
 * Fetches all dynamic medicine physical inventory batches
 */
inventoryRouter.get("/batches", authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const batches = await prisma.inventoryBatch.findMany({
      where: {
        stockQuantity: { gt: 0 }
      },
      orderBy: [
        { expiryDate: "asc" },
        { createdAt: "asc" }
      ],
      include: {
        product: true
      }
    });

    return res.json({
      success: true,
      batches
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * GET /api/inventory/products
 * Fetch products and their current aggregate stock quantities
 */
inventoryRouter.get("/products", authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" }
    });

    return res.json({
      success: true,
      products
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});
