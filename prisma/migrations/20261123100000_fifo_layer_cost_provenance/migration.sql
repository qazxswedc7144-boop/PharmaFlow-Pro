-- Phase 4A: preserve immutable receipt-layer cost provenance and per-invoice FIFO allocations.
-- Legacy inventory is represented as a current-stock baseline only. This does not fabricate
-- historical consumption or claim that legacy batch balances can reconstruct prior COGS.

CREATE TABLE "inventory_layers" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "sourceReferenceId" TEXT NOT NULL,
    "sourceReferenceType" TEXT NOT NULL,
    "sourceLineId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "quantityInitial" INTEGER NOT NULL,
    "quantityRemaining" INTEGER NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isLegacyBaseline" BOOLEAN NOT NULL DEFAULT false,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    CONSTRAINT "inventory_layers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inventory_layers_quantity_check"
      CHECK ("quantityInitial" >= 0 AND "quantityRemaining" >= 0 AND "quantityRemaining" <= "quantityInitial"),
    CONSTRAINT "inventory_layers_unit_cost_check" CHECK ("unitCost" >= 0)
);

CREATE UNIQUE INDEX "inventory_layers_id_tenantId_key"
  ON "inventory_layers"("id", "tenantId");
CREATE UNIQUE INDEX "inventory_layers_tenantId_sourceKey_key"
  ON "inventory_layers"("tenantId", "sourceKey");
CREATE INDEX "inventory_layers_tenantId_productId_expiryDate_createdAt_idx"
  ON "inventory_layers"("tenantId", "productId", "expiryDate", "createdAt");
CREATE INDEX "inventory_layers_batchId_tenantId_idx"
  ON "inventory_layers"("batchId", "tenantId");

-- Baseline only the quantity that is currently on hand. The legacy batch's historical
-- initialQty is intentionally not treated as a fully auditable receipt/consumption history.
INSERT INTO "inventory_layers" (
  "id", "batchId", "productId", "batchNumber",
  "sourceReferenceId", "sourceReferenceType", "sourceLineId", "sourceKey",
  "quantityInitial", "quantityRemaining", "unitCost", "expiryDate",
  "createdAt", "isLegacyBaseline", "tenantId", "branchId"
)
SELECT
  'LEGACY-LAYER-' || b."id",
  b."id",
  b."productId",
  b."batchNumber",
  'LEGACY_BASELINE:' || b."id",
  'LEGACY_BASELINE',
  NULL,
  'legacy:' || b."id",
  b."stockQuantity",
  b."stockQuantity",
  b."cost",
  b."expiryDate",
  b."createdAt",
  true,
  b."tenantId",
  NULL
FROM "inventory_batches" b
WHERE b."stockQuantity" > 0;

CREATE TABLE "fifo_consumption_log" (
    "id" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "totalCost" DECIMAL(18,4) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    CONSTRAINT "fifo_consumption_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fifo_consumption_log_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "fifo_consumption_log_unit_cost_check" CHECK ("unitCost" >= 0),
    CONSTRAINT "fifo_consumption_log_total_cost_check" CHECK ("totalCost" >= 0)
);

CREATE UNIQUE INDEX "fifo_consumption_log_id_tenantId_key"
  ON "fifo_consumption_log"("id", "tenantId");
CREATE UNIQUE INDEX "fifo_consumption_log_tenantId_idempotencyKey_key"
  ON "fifo_consumption_log"("tenantId", "idempotencyKey");
CREATE INDEX "fifo_consumption_log_tenantId_invoiceId_idx"
  ON "fifo_consumption_log"("tenantId", "invoiceId");
CREATE INDEX "fifo_consumption_log_tenantId_layerId_idx"
  ON "fifo_consumption_log"("tenantId", "layerId");
CREATE INDEX "fifo_consumption_log_tenantId_productId_idx"
  ON "fifo_consumption_log"("tenantId", "productId");

ALTER TABLE "inventory_layers"
  ADD CONSTRAINT "inventory_layers_batchId_tenantId_fkey"
  FOREIGN KEY ("batchId", "tenantId") REFERENCES "inventory_batches"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_layers"
  ADD CONSTRAINT "inventory_layers_productId_tenantId_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "products"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_layers"
  ADD CONSTRAINT "inventory_layers_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fifo_consumption_log"
  ADD CONSTRAINT "fifo_consumption_log_layerId_tenantId_fkey"
  FOREIGN KEY ("layerId", "tenantId") REFERENCES "inventory_layers"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fifo_consumption_log"
  ADD CONSTRAINT "fifo_consumption_log_productId_tenantId_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "products"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fifo_consumption_log"
  ADD CONSTRAINT "fifo_consumption_log_invoiceId_tenantId_fkey"
  FOREIGN KEY ("invoiceId", "tenantId") REFERENCES "invoices"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fifo_consumption_log"
  ADD CONSTRAINT "fifo_consumption_log_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
