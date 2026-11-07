-- Tenant-authoritative sales policy and immutable invoice financial breakdown.
CREATE TYPE "SalesTaxMode" AS ENUM ('NONE', 'EXCLUSIVE', 'INCLUSIVE');

ALTER TABLE "invoices"
  ADD COLUMN "subtotalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.00,
  ADD COLUMN "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.00,
  ADD COLUMN "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0.00,
  ADD COLUMN "taxMode" "SalesTaxMode" NOT NULL DEFAULT 'NONE';

-- Preserve the historical invoice base amount for records created before this migration.
UPDATE "invoices"
SET "subtotalAmount" = "totalAmount"
WHERE "subtotalAmount" = 0.00 AND "totalAmount" <> 0.00;

CREATE TABLE "tenant_sales_policies" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "maxDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  "taxMode" "SalesTaxMode" NOT NULL DEFAULT 'NONE',
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_sales_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_sales_policies_tenantId_key"
  ON "tenant_sales_policies"("tenantId");
ALTER TABLE "tenant_sales_policies"
  ADD CONSTRAINT "tenant_sales_policies_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
