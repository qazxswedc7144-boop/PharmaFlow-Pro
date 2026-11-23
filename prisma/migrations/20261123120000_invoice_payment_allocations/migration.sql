-- Phase 4B: durable voucher-to-invoice allocations and explicit paid amount.
-- Legacy PAID/UNPAID rows can be backfilled deterministically. Legacy partial-payment
-- rows remain NULL because the historical amount cannot be inferred safely.

ALTER TABLE "invoices"
  ADD COLUMN "paidAmount" DECIMAL(18,4);

UPDATE "invoices"
SET "paidAmount" = CASE
  WHEN "paymentStatus"::text IN ('PAID', 'CASH') THEN "totalAmount"
  WHEN "paymentStatus"::text = 'UNPAID' THEN 0
  ELSE NULL
END;

ALTER TABLE "payments"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'POSTED',
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" TEXT;

ALTER TABLE "journal_entries"
  ADD COLUMN "reversalOfId" TEXT;

CREATE UNIQUE INDEX "payments_id_tenantId_key"
  ON "payments"("id", "tenantId");
CREATE INDEX "payments_tenantId_status_idx"
  ON "payments"("tenantId", "status");
CREATE INDEX "journal_entries_tenantId_reversalOfId_idx"
  ON "journal_entries"("tenantId", "reversalOfId");

CREATE TABLE "invoice_payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    CONSTRAINT "invoice_payment_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_payment_allocations_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "invoice_payment_allocations_status_check" CHECK ("status" IN ('ACTIVE', 'REVERSED'))
);

CREATE UNIQUE INDEX "invoice_payment_allocations_id_tenantId_key"
  ON "invoice_payment_allocations"("id", "tenantId");
CREATE UNIQUE INDEX "invoice_payment_allocations_tenantId_paymentId_invoiceId_key"
  ON "invoice_payment_allocations"("tenantId", "paymentId", "invoiceId");
CREATE INDEX "invoice_payment_allocations_tenantId_invoiceId_status_idx"
  ON "invoice_payment_allocations"("tenantId", "invoiceId", "status");
CREATE INDEX "invoice_payment_allocations_tenantId_paymentId_idx"
  ON "invoice_payment_allocations"("tenantId", "paymentId");

ALTER TABLE "invoice_payment_allocations"
  ADD CONSTRAINT "invoice_payment_allocations_paymentId_tenantId_fkey"
  FOREIGN KEY ("paymentId", "tenantId") REFERENCES "payments"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_payment_allocations"
  ADD CONSTRAINT "invoice_payment_allocations_invoiceId_tenantId_fkey"
  FOREIGN KEY ("invoiceId", "tenantId") REFERENCES "invoices"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_payment_allocations"
  ADD CONSTRAINT "invoice_payment_allocations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
