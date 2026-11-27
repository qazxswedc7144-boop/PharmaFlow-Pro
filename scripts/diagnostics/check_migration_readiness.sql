-- PharmaFlow Pro migration readiness diagnostics
-- READ ONLY: intended for a local disposable DB or isolated restored clone ONLY.
-- Do NOT run against production as part of this PR.
-- No DDL/DML is issued. The DO block below executes dynamic SELECTs and emits NOTICEs only.

BEGIN;
SET TRANSACTION READ ONLY;

\echo '=== 1. Target identity (operator must independently confirm this is isolated) ==='
SELECT current_database() AS database_name,
       current_user AS database_user,
       inet_server_addr() AS server_address,
       inet_server_port() AS server_port,
       current_setting('transaction_read_only') AS transaction_read_only;

\echo '=== 2. CASH values and related enum labels ==='
SELECT n.nspname AS schema_name,
       t.typname AS enum_name,
       e.enumlabel AS enum_value
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typname IN ('PaymentStatus', 'AuditActionType')
ORDER BY n.nspname, t.typname, e.enumsortorder;

SELECT COUNT(*) AS invoices_payment_status_cash_count
FROM public.invoices
WHERE "paymentStatus"::text = 'CASH';

DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payments'
      AND column_name = 'status'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM public.payments WHERE status::text = $1'
      INTO v_count USING 'CASH';
    RAISE NOTICE 'payments.status CASH count = %', v_count;
  ELSE
    RAISE NOTICE 'payments.status column is absent (expected before migration 20261123120000)';
  END IF;
END $$;

\echo '=== 3. Four expected Prisma migration ledger states ==='
WITH expected(migration_name, expected_order) AS (
  VALUES
    ('20261108184500_add_lock_and_replication_audit_actions', 1),
    ('20261122150000_accounting_periods_authoritative', 2),
    ('20261123100000_fifo_layer_cost_provenance', 3),
    ('20261123120000_invoice_payment_allocations', 4)
)
SELECT e.expected_order,
       e.migration_name,
       CASE
         WHEN m.migration_name IS NULL THEN 'PENDING_NOT_RECORDED'
         WHEN m.rolled_back_at IS NOT NULL THEN 'ROLLED_BACK'
         WHEN m.finished_at IS NOT NULL THEN 'APPLIED'
         ELSE 'INCOMPLETE_OR_FAILED'
       END AS ledger_state,
       m.started_at,
       m.finished_at,
       m.rolled_back_at,
       m.logs
FROM expected e
LEFT JOIN public."_prisma_migrations" m
  ON m.migration_name = e.migration_name
ORDER BY e.expected_order;

SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied_count,
       COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished_or_failed_count,
       COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back_count
FROM public."_prisma_migrations";

\echo '=== 4. Required tables, enum types, indexes, and constraints ==='
WITH required_objects(object_kind, object_name) AS (
  VALUES
    ('table', 'accounting_periods'),
    ('table', 'inventory_layers'),
    ('table', 'fifo_consumption_log'),
    ('table', 'invoice_payment_allocations'),
    ('type', 'AuditActionType'),
    ('type', 'PaymentStatus'),
    ('index', 'accounting_periods_tenantId_clientId_key'),
    ('index', 'accounting_periods_tenantId_startDate_endDate_idx'),
    ('index', 'accounting_periods_tenantId_isLocked_idx'),
    ('index', 'inventory_layers_tenantId_sourceKey_key'),
    ('index', 'inventory_layers_batchId_tenantId_idx'),
    ('index', 'fifo_consumption_log_tenantId_idempotencyKey_key'),
    ('index', 'fifo_consumption_log_tenantId_layerId_idx'),
    ('index', 'payments_tenantId_status_idx'),
    ('index', 'invoice_payment_allocations_tenantId_paymentId_invoiceId_key'),
    ('index', 'invoice_payment_allocations_tenantId_invoiceId_status_idx')
)
SELECT r.object_kind,
       r.object_name,
       CASE
         WHEN r.object_kind = 'table' THEN to_regclass('public.' || quote_ident(r.object_name)) IS NOT NULL
         WHEN r.object_kind = 'index' THEN EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = r.object_name AND c.relkind = 'i'
         )
         WHEN r.object_kind = 'type' THEN EXISTS (
           SELECT 1 FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typname = r.object_name
         )
       END AS exists_now
FROM required_objects r
ORDER BY r.object_kind, r.object_name;

SELECT conrelid::regclass AS table_name,
       conname AS constraint_name,
       contype AS constraint_type,
       convalidated AS validated
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND conname IN (
    'accounting_periods_valid_range_check',
    'accounting_periods_tenantId_fkey',
    'inventory_layers_quantity_check',
    'inventory_layers_unit_cost_check',
    'inventory_layers_batchId_tenantId_fkey',
    'inventory_layers_productId_tenantId_fkey',
    'fifo_consumption_log_quantity_check',
    'fifo_consumption_log_unit_cost_check',
    'fifo_consumption_log_total_cost_check',
    'fifo_consumption_log_layerId_tenantId_fkey',
    'invoice_payment_allocations_amount_check',
    'invoice_payment_allocations_status_check',
    'invoice_payment_allocations_paymentId_tenantId_fkey',
    'invoice_payment_allocations_invoiceId_tenantId_fkey'
  )
ORDER BY table_name::text, constraint_name;

\echo '=== 5. Potential conflicting source data / backfill reconciliation ==='
SELECT COUNT(*) AS negative_inventory_batch_stock_count
FROM public.inventory_batches
WHERE "stockQuantity" < 0;

SELECT COUNT(*) AS positive_inventory_batches_expected_for_legacy_baseline
FROM public.inventory_batches
WHERE "stockQuantity" > 0;

DO $$
DECLARE
  v_count bigint;
  v_overlap_count bigint;
BEGIN
  IF to_regclass('public.accounting_periods') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.accounting_periods WHERE "endDate" < "startDate"'
      INTO v_count;
    RAISE NOTICE 'accounting_periods invalid date ranges = %', v_count;

    EXECUTE $q$
      SELECT COUNT(*)
      FROM public.accounting_periods a
      JOIN public.accounting_periods b
        ON a."tenantId" = b."tenantId"
       AND a.id < b.id
       AND daterange(a."startDate"::date, b."endDate"::date, '[]') IS NOT NULL
       AND a."startDate" <= b."endDate"
       AND b."startDate" <= a."endDate"
    $q$ INTO v_overlap_count;
    RAISE NOTICE 'accounting_periods overlapping pairs (inclusive date ranges) = %', v_overlap_count;
  ELSE
    RAISE NOTICE 'accounting_periods table absent; overlap check deferred until after isolated migration rehearsal';
  END IF;

  IF to_regclass('public.inventory_layers') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COUNT(*)
      FROM public.inventory_batches b
      LEFT JOIN public.inventory_layers l
        ON l."batchId" = b.id
       AND l."tenantId" = b."tenantId"
       AND l."isLegacyBaseline" = true
      WHERE b."stockQuantity" > 0
        AND (l.id IS NULL OR l."quantityRemaining" <> b."stockQuantity"
             OR l."quantityInitial" <> b."stockQuantity")
    $q$ INTO v_count;
    RAISE NOTICE 'positive inventory batches missing/mismatched legacy baseline = %', v_count;

    EXECUTE $q$
      SELECT COUNT(*)
      FROM public.inventory_layers
      WHERE "quantityInitial" < 0
         OR "quantityRemaining" < 0
         OR "quantityRemaining" > "quantityInitial"
         OR "unitCost" < 0
    $q$ INTO v_count;
    RAISE NOTICE 'inventory_layers violating expected quantity/cost rules = %', v_count;
  ELSE
    RAISE NOTICE 'inventory_layers absent; baseline reconciliation deferred until after isolated migration rehearsal';
  END IF;

  IF to_regclass('public.invoice_payment_allocations') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COUNT(*) FROM public.invoice_payment_allocations
      WHERE amount <= 0 OR status NOT IN ('ACTIVE', 'REVERSED')
    $q$ INTO v_count;
    RAISE NOTICE 'invoice_payment_allocations invalid amount/status rows = %', v_count;

    EXECUTE $q$
      SELECT COUNT(*) FROM (
        SELECT "tenantId", "paymentId", "invoiceId"
        FROM public.invoice_payment_allocations
        GROUP BY "tenantId", "paymentId", "invoiceId"
        HAVING COUNT(*) > 1
      ) d
    $q$ INTO v_count;
    RAISE NOTICE 'duplicate tenant/payment/invoice allocation groups = %', v_count;

    EXECUTE $q$
      SELECT COUNT(*)
      FROM (
        SELECT a."tenantId", a."paymentId", SUM(a.amount) AS allocated
        FROM public.invoice_payment_allocations a
        WHERE a.status = 'ACTIVE'
        GROUP BY a."tenantId", a."paymentId"
      ) s
      JOIN public.payments p
        ON p.id = s."paymentId" AND p."tenantId" = s."tenantId"
      WHERE s.allocated > p.amount
    $q$ INTO v_count;
    RAISE NOTICE 'payments whose active allocations exceed payment amount = %', v_count;
  ELSE
    RAISE NOTICE 'invoice_payment_allocations absent; allocation checks deferred until after isolated migration rehearsal';
  END IF;
END $$;

\echo '=== 6. CASH semantic distinction ==='
SELECT "paymentMethod"::text AS payment_method,
       COUNT(*) AS row_count
FROM public.payments
GROUP BY "paymentMethod"::text
ORDER BY payment_method;

-- No row data is modified by this script.
COMMIT;
