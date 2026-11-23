-- Phase 4C: add tenant-safe branch provenance to server FIFO records.
-- This migration deliberately does NOT overwrite existing branch_inventory balances.
-- Existing balances may include legacy stock that has no complete FIFO layer history;
-- those mismatches must be reconciled explicitly before branch-scoped posting.

-- A layer can be assigned automatically only when the tenant has exactly one branch.
-- Multi-branch legacy stock remains unassigned rather than being guessed into a branch.
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

-- Consumption provenance follows its exact source layer. This is not a heuristic:
-- the consumed layer is the authoritative record of the branch from which stock came.
UPDATE fifo_consumption_log AS consumption
SET "branchId" = layer."branchId"
FROM inventory_layers AS layer
WHERE consumption."tenantId" = layer."tenantId"
  AND consumption."layerId" = layer.id
  AND consumption."branchId" IS NULL
  AND layer."branchId" IS NOT NULL;

-- Invalid historical branch references are not trusted. Clear only the invalid
-- branch identity; quantity/cost/provenance rows remain intact for reconciliation.
UPDATE inventory_layers AS layer
SET "branchId" = NULL
WHERE layer."branchId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM branches AS branch
    WHERE branch.id = layer."branchId"
      AND branch."tenantId" = layer."tenantId"
  );

UPDATE fifo_consumption_log AS consumption
SET "branchId" = NULL
WHERE consumption."branchId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM branches AS branch
    WHERE branch.id = consumption."branchId"
      AND branch."tenantId" = consumption."tenantId"
  );

-- Initialize only missing projection rows. Existing branch_inventory rows are
-- intentionally preserved byte-for-byte even when they differ from layer totals.
-- Runtime FIFO posting detects mismatches and fails closed pending reconciliation.
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
ON CONFLICT ("branchId", "productId") DO NOTHING;

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
