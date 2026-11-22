-- PUR-006: authoritative tenant-scoped accounting periods.
-- Existing client-side Dexie periods are imported through the authenticated API;
-- no historical financial rows are modified by this migration.
CREATE TABLE "accounting_periods" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,
    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_periods_valid_range_check" CHECK ("endDate" >= "startDate")
);

CREATE UNIQUE INDEX "accounting_periods_tenantId_clientId_key"
    ON "accounting_periods"("tenantId", "clientId");

CREATE INDEX "accounting_periods_tenantId_startDate_endDate_idx"
    ON "accounting_periods"("tenantId", "startDate", "endDate");
CREATE INDEX "accounting_periods_tenantId_isLocked_idx"
    ON "accounting_periods"("tenantId", "isLocked");

ALTER TABLE "accounting_periods"
    ADD CONSTRAINT "accounting_periods_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
