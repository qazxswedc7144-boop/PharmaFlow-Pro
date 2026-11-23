# PharmaFlow Pro — Controlled five-migration release runbook

**Status:** preparation only. This document does not authorize or perform a production migration.  
**Prepared from:** `main` at `0ba55bb73048aa4fc980e46ffa3bd87acccccacd` (2026-11-23).  
**Release branch:** `release/2026-11-24-five-prisma-migrations`

## 1. Exact release scope

The five pending migrations identified for this release are expected to be:

1. `20261108202000_sales_policy_phase1`
2. `20261110022000_tenant_sales_policy_rls`
3. `20261122150000_accounting_periods_authoritative`
4. `20261123100000_fifo_layer_cost_provenance`
5. `20261123120000_invoice_payment_allocations`

The repository currently contains seven migration directories in total. The initial schema migration and `20261108184500_add_lock_and_replication_audit_actions` are prerequisites, not part of this five-item release. **Do not proceed unless a live `prisma migrate status` confirms the exact expected applied/pending set above.** If the live ledger differs, stop and reconcile; do not use `migrate resolve`, manual ledger edits, `db push`, or `migrate reset`.

## 2. Hard release gates

- Confirm the target is the intended Supabase production project and record its project ref/region without exposing connection strings.
- Obtain a fresh, full logical backup immediately before the maintenance window. Record UTC timestamp, file size, SHA-256, and backup location.
- Perform a restore drill into a separate isolated PostgreSQL database. A successful backup command without a successful restore drill is not a release-ready backup.
- Confirm there are no active writes or deploys during the migration window; put the application in maintenance/read-only mode if operationally required.
- Run the same migration set against an isolated PostgreSQL clone first.
- Capture pre-migration counts for tenants, users, invoices, invoice items, payments, journal entries, inventory batches, and inventory movements.
- Confirm a tested rollback/restore owner and a communication window. PostgreSQL DDL rollback is not the recovery strategy; restore the verified backup if the migration or validation fails.

## 3. Preflight (read-only)

Use the repository commit selected for release and a protected shell/secret manager. Never paste credentials into chat, commit them, or place them in shell history.

```bash
set -euo pipefail
test -n "${DIRECT_URL:-}"
npx prisma validate
npx prisma migrate status
```

Expected ledger before applying: the initial schema migration and `20261108184500_add_lock_and_replication_audit_actions` are applied; the five migrations in section 1 are pending. Any other output is a **STOP**.

The repository did not contain `prisma/migrations/migration_lock.toml` at the inspected base commit. This release branch adds the standard PostgreSQL provider lock. Verify it is present in the checked-out release commit before any Prisma command.

## 4. Backup and restore verification

Create a uniquely named backup on encrypted storage with restricted access. Use the direct PostgreSQL connection string supplied through the secure environment, not a literal in the command.

```bash
umask 077
BACKUP_FILE="pharmaflow-prod-pre-migrations-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump "$DIRECT_URL" --format=custom --no-owner --no-privileges --file="$BACKUP_FILE"
test -s "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "${BACKUP_FILE}.contents.txt"
sha256sum "$BACKUP_FILE" | tee "${BACKUP_FILE}.sha256"
```

Then restore the dump into a **separate isolated restore-test database** (never the production URL), using a protected `RESTORE_TEST_URL`:

```bash
test -n "${RESTORE_TEST_URL:-}"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$RESTORE_TEST_URL" "$BACKUP_FILE"
```

Inspect the restored database and compare the pre-migration critical row counts. Do not continue if the dump is empty, the restore fails, or counts do not reconcile.

## 5. Migration execution — gated, single operation

Only after all gates pass and the production change window is explicitly approved:

```bash
npx prisma migrate deploy
npx prisma migrate status
```

Do **not** use `npm run db:release` for this operation: that script runs `secure-admin-bootstrap.ts` after migrations and can create/update bootstrap identity/tenant data, which is outside this schema-release scope. Do not run `migrate dev`, `db push`, `migrate reset`, or `migrate resolve` against production.

If deploy exits non-zero, stop immediately, preserve logs and the backup, do not blindly rerun, and inspect `_prisma_migrations` plus PostgreSQL state before choosing recovery.

## 6. Post-migration SQL verification

Run these read-only checks using a privileged, trusted database session. Save the raw output with the release evidence.

### 6.1 Migration ledger

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at, logs
FROM public."_prisma_migrations"
WHERE migration_name IN (
  '20261108202000_sales_policy_phase1',
  '20261110022000_tenant_sales_policy_rls',
  '20261122150000_accounting_periods_authoritative',
  '20261123100000_fifo_layer_cost_provenance',
  '20261123120000_invoice_payment_allocations'
)
ORDER BY migration_name;
```

Require exactly five rows, each with non-NULL `finished_at`, NULL `rolled_back_at`, and no failure logs. Also require `prisma migrate status` to report no pending migrations.

### 6.2 Required objects and columns

```sql
SELECT name, to_regclass('public.' || name) IS NOT NULL AS exists
FROM (VALUES
  ('tenant_sales_policies'),
  ('accounting_periods'),
  ('inventory_layers'),
  ('fifo_consumption_log'),
  ('invoice_payment_allocations')
) AS expected(name);

SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ( (table_name = 'invoices' AND column_name IN
          ('subtotalAmount','discountPercent','discountAmount','taxRatePercent','taxAmount','taxMode','clientRefId','paidAmount'))
     OR (table_name = 'payments' AND column_name IN ('status','cancelledAt','cancellationReason'))
     OR (table_name = 'journal_entries' AND column_name = 'reversalOfId') )
ORDER BY table_name, column_name;

SELECT typname, enumlabel
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE typname = 'SalesTaxMode'
ORDER BY enumsortorder;
```

Require all five tables, all listed columns, and the three `SalesTaxMode` labels (`NONE`, `EXCLUSIVE`, `INCLUSIVE`).

### 6.3 RLS state

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'tenant_sales_policies';
```

Require `relrowsecurity = true`. Verify separately that the application server's trusted database role can access the table and that public/API roles cannot read it. Do not infer role behavior from the flag alone.

### 6.4 Accounting-period constraints

```sql
SELECT conname, contype, convalidated
FROM pg_constraint
WHERE conrelid = 'public.accounting_periods'::regclass
ORDER BY conname;

SELECT COUNT(*) AS invalid_ranges
FROM public.accounting_periods
WHERE "endDate" < "startDate";
```

Require the primary key, tenant FK, unique tenant/client key, valid-range check, all applicable constraints validated, and zero invalid ranges.

### 6.5 FIFO baseline integrity

```sql
SELECT b.id, b."tenantId", b."stockQuantity",
       COALESCE(SUM(l."quantityRemaining"), 0) AS baseline_remaining
FROM public.inventory_batches b
LEFT JOIN public.inventory_layers l
  ON l."batchId" = b.id
 AND l."tenantId" = b."tenantId"
 AND l."isLegacyBaseline" = true
WHERE b."stockQuantity" > 0
GROUP BY b.id, b."tenantId", b."stockQuantity"
HAVING COALESCE(SUM(l."quantityRemaining"), 0) <> b."stockQuantity";
```

Require zero rows. Also verify no negative quantities/costs, unique `(tenantId, sourceKey)`, and valid tenant/product/batch foreign keys. Legacy baseline layers represent current on-hand stock only; they are **not** evidence of historical FIFO consumption or historical COGS.

### 6.6 Voucher/payment integrity

```sql
SELECT COUNT(*) AS paid_amount_mismatches
FROM public.invoices
WHERE ("paymentStatus"::text = 'PAID' AND "paidAmount" IS DISTINCT FROM "totalAmount")
   OR ("paymentStatus"::text = 'UNPAID' AND "paidAmount" IS DISTINCT FROM 0::numeric)
   OR ("paymentStatus"::text = 'PARTIALLY_PAID' AND "paidAmount" IS NOT NULL);

SELECT COUNT(*) AS invalid_allocations
FROM public.invoice_payment_allocations
WHERE amount <= 0 OR status NOT IN ('ACTIVE', 'REVERSED');

SELECT conname, contype, convalidated
FROM pg_constraint
WHERE conrelid = 'public.invoice_payment_allocations'::regclass
ORDER BY conname;
```

Require zero mismatches and invalid allocations, and validated tenant-scoped FKs to payments, invoices, and tenants. Preserve NULL `paidAmount` for legacy partial settlements; do not fabricate historical allocation values.

## 7. Application smoke tests and release evidence

After SQL checks pass, run read-only application smoke tests for:
- authenticated tenant-scoped read/write of a sales policy through the trusted server path;
- accounting-period create/read/lock/unlock with tenant isolation and invalid date-range rejection;
- FIFO layer lookup and a synthetic isolated receipt/issue test proving FEFO/FIFO cost provenance and idempotency;
- voucher allocation, partial settlement, reversal, and retry/idempotency in an isolated test tenant;
- no cross-tenant reads or writes;
- existing login, POS, purchase, inventory, and financial reports remain operational.

Record the release commit SHA, five migration names, backup SHA-256, restore-drill result, pre/post row counts, migration ledger output, SQL check outputs, smoke-test results, operator, and timestamps.

## 8. Stop / recovery criteria

Stop the release on any unexpected pending/applied migration, missing object, invalid FK/check, FIFO quantity mismatch, paid-amount mismatch, RLS access failure, failed smoke test, or missing/failed restore drill. Keep the app in maintenance mode as needed. Restore from the verified pre-release backup under the approved recovery procedure; never attempt an improvised reverse SQL migration.
