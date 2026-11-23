-- Phase 4C: make server FIFO provenance and branch stock projections branch-aware.
-- Existing unassigned layers are assigned automatically only when a tenant has
-- exactly one branch. Multi-branch stock is never guessed into a branch.

WITH single_branch AS (
  SELECT "tenantId", MIN(id) AS "branchId"
  FROM branches
  GROUP BY "tenantId"
  HAVING COUNT(*) = 1
)
UPDATE inventory_layers AS layer
SET "branchId" = single_branch."branchId"
FROM single_branch
WHERE layer."tenantId" = single_branch."tenantId"
  AND layer."branchId" IS NULL;

-- Rebuild the branch stock projection from branch-assigned FIFO layers.
-- Unassigned legacy layers remain excluded until an explicit reconciliation.
INSERT INTO branch_inventory (
  id, "tenantId", "branchId", "productId", "stockQuantity", "createdAt", "updatedAt"
)
SELECT
  'FIFO-BRANCH-' || md5(layer."tenantId" || ':' || layer."branchId" || ':' || layer."productId"),
  layer."tenantId",
  layer."branchId",
  layer."productId",
  SUM(layer."quantityRemaining")::INTEGER,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM inventory_layers AS layer
WHERE layer."branchId" IS NOT NULL
GROUP BY layer."tenantId", layer."branchId", layer."productId"
ON CONFLICT ("branchId", "productId")
DO UPDATE SET
  "stockQuantity" = EXCLUDED."stockQuantity",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE branch_inventory AS projection
SET
  "stockQuantity" = COALESCE((
    SELECT SUM(layer."quantityRemaining")::INTEGER
    FROM inventory_layers AS layer
    WHERE layer."tenantId" = projection."tenantId"
      AND layer."branchId" = projection."branchId"
      AND layer."productId" = projection."productId"
  ), 0),
  "updatedAt" = CURRENT_TIMESTAMP;

CREATE INDEX "inventory_layers_tenantId_branchId_productId_expiryDate_createdAt_idx"
  ON inventory_layers ("tenantId", "branchId", "productId", "expiryDate", "createdAt");

CREATE INDEX "fifo_consumption_log_tenantId_branchId_productId_idx"
  ON fifo_consumption_log ("tenantId", "branchId", "productId");

ALTER TABLE inventory_layers
  ADD CONSTRAINT "inventory_layers_branchId_tenantId_fkey"
  FOREIGN KEY ("branchId", "tenantId")
  REFERENCES branches (id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE fifo_consumption_log
  ADD CONSTRAINT "fifo_consumption_log_branchId_tenantId_fkey"
  FOREIGN KEY ("branchId", "tenantId")
  REFERENCES branches (id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
