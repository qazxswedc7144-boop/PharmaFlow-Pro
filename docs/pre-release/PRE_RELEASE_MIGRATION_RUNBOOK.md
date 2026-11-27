# PharmaFlow Pro — Production Pre-Release Migration Runbook

> **Status:** Reviewable preparation only. This document is not an execution authorization.
> **Production safety:** No production migration, backup, restore, SQL diagnostic, or database write is authorized by this PR. All commands below are templates for an isolated rehearsal. Never paste production credentials into chat, GitHub, shell history, CI logs, or this repository.

## 1. Purpose and non-goals

Provide a controlled, auditable process to review four pending Prisma migrations, create and verify an external logical backup, restore it to an isolated PostgreSQL instance, rehearse the migrations there, and collect evidence before a separate owner decision.

This runbook does **not** authorize:
- Running diagnostics against production.
- Running `prisma migrate deploy`, `db:release`, `migrate resolve`, or any DDL/DML against production.
- Editing `public."_prisma_migrations"` or manually marking migrations applied/rolled back.
- Reordering, rewriting, or skipping existing migration files.
- Merging this PR or PR #124.

## 2. Verified repository and migration evidence

Repository: [qazxswedc7144-boop/PharmaFlow-Pro](https://github.com/qazxswedc7144-boop/PharmaFlow-Pro)  
Reviewed source ref: `main` at `efe3c4acce66a6e14b36a8b2b0df2af3a724abfe`.

Relevant source evidence:
- `prisma/schema.prisma` blob SHA: `db8adf49eba2af78bbfc57377061c2021dd9d644`.
- `20261108184500_add_lock_and_replication_audit_actions/migration.sql` blob SHA: `f1a4521c98ef3c66256a3a320b581d83d5ac9e20`.
- `20261122150000_accounting_periods_authoritative/migration.sql` blob SHA: `ddf482d9f1072d272bdd3b20ccc49482f56fe20d`.
- `20261123100000_fifo_layer_cost_provenance/migration.sql` blob SHA: `db3b0113ad648a750d2f6b64e5dd07f0142bb32d`.
- `20261123120000_invoice_payment_allocations/migration.sql` blob SHA: `0927c4480846dfc0f6e04344172d13963f0ccb40`.

The preceding read-only production-ledger review recorded three applied migrations and these four pending migrations:
1. `20261108184500_add_lock_and_replication_audit_actions`
2. `20261122150000_accounting_periods_authoritative`
3. `20261123100000_fifo_layer_cost_provenance`
4. `20261123120000_invoice_payment_allocations`

Treat that ledger snapshot as time-bound evidence, not a live assertion. Reconfirm only on an isolated restored copy before rehearsal. The precise applied migration names/checksums must be exported from that copy; do not infer them from this document.

### 2.1 SQL review and dependencies

| Migration | Direct changes | Required pre-existing objects / dependencies | Review notes |
|---|---|---|---|
| `20261108184500_add_lock_and_replication_audit_actions` | Adds five values to `AuditActionType` | Existing enum `AuditActionType` | No table creation. App writes must be tested for LOCK_ACQUIRED, LOCK_RELEASED, LOCK_EXTENDED, LOCK_RECOVERY, REPLICATION_PUBLISHED. |
| `20261122150000_accounting_periods_authoritative` | Creates `accounting_periods`, PK, date-range CHECK, unique/indexes, tenant FK | `tenants(id)` | No historical financial rows are backfilled. SQL does not enforce non-overlap between periods for a tenant. Confirm application/service enforcement and add a test/evidence before production. |
| `20261123100000_fifo_layer_cost_provenance` | Creates `inventory_layers`, seeds positive current `inventory_batches.stockQuantity` as legacy baseline, creates `fifo_consumption_log`, indexes/FKs/CHECKs | `inventory_batches`, `products`, `tenants`, and composite unique keys `(id, tenantId)` on batch/product | Baseline represents remaining stock only. It does not reconstruct historic FIFO consumption or historical COGS. Compare every positive source batch with exactly one baseline layer and reconcile quantities/costs. |
| `20261123120000_invoice_payment_allocations` | Adds `invoices.paidAmount`; adds payment status/cancellation fields; adds `journal_entries.reversalOfId`; creates allocation table/indexes/FKs/CHECKs | `invoices`, `payments`, `journal_entries`, `tenants`; composite unique keys on payment/invoice | Review amount reconciliation, duplicate allocations, reversal/cancellation flows, and tenant boundaries. |

### 2.2 Ordering and CASH findings

Prisma applies pending migrations in lexicographic directory-name order. The lock/replication migration is dated **2026-11-08 18:45**, earlier than two migrations already reported applied in the production ledger (timestamps 20:20 and 21:00 on that date). This is unusual history ordering, not by itself proof that deployment will fail. Rehearse the exact repository migration set against a fresh isolated restore and retain the complete output. Never change timestamps or migration history to make the sequence appear consistent.

The invoice-allocation migration contains:
```sql
WHEN "paymentStatus"::text IN ('PAID', 'CASH') THEN "totalAmount"
```
The reviewed Prisma schema declares `PaymentStatus` as `PAID`, `UNPAID`, `PARTIALLY_PAID`; therefore `CASH` is not a valid value of that enum. The `CASH` branch is unreachable for a valid enum column (the cast to text avoids an enum-literal cast error). Separately, `payments.paymentMethod` is a text field whose default is `CASH`, and the migration adds `payments.status` as text with default `LEGACY_UNVERIFIED`. Do not conflate payment method, invoice payment status, and payment status. The diagnostic SQL reports actual counts where the columns exist. Decide whether the migration condition is a harmless stale branch or requires a new forward-only corrective migration; do not rewrite a migration already applied in any environment without checksum/history analysis.

## 3. Diagnostics (read-only SQL)

File: `scripts/diagnostics/check_migration_readiness.sql`.

- Run only against a disposable local database or isolated restored clone, after verifying the target host/database.
- The SQL file contains a heuristic Fail-Closed guard that refuses database names containing `prod`, `production`, `pharmaflow`, `live`, `master`, or `primary`, unless the name also contains `restore`, `test`, or `ci`. This naming guard is not proof of environment identity; independently verify the host and target before use.
- The script starts a read-only transaction and contains SELECT/catalog inspection plus PL/pgSQL diagnostic blocks that only emit NOTICE messages. It does not create tables, update rows, or modify migration history.
- The `payments.status` check is conditional because the column is introduced by the fourth pending migration.
- Review every non-zero conflict count. A missing object before its migration is expected; rerun the same diagnostics after the isolated rehearsal to verify the final state.
- The diagnostics cover 9 migration-defined indexes, 5 added columns, the 5 release-scope `AuditActionType` values, foreign keys (including tenant-scoped references), accounting-period overlap by calendar date, and FIFO layer `unitCost` versus source batch `cost`.
- `AuditActionType` in this release must contain exactly these five expected values: `LOCK_ACQUIRED`, `LOCK_RELEASED`, `LOCK_EXTENDED`, `LOCK_RECOVERY`, `REPLICATION_PUBLISHED`. `BACKUP_UPLOAD` and `SESSION_CLEANED` are not required in this release and are deferred for a future decision.
- Do not use this script as a substitute for application-level integration tests.

### 3.1 Diagnostic coverage summary

| Diagnostic | Expected objects / values | Purpose |
|---|---:|---|
| Migration indexes | 9 indexes (5 FIFO + 4 payment/allocation indexes) | Confirm all indexes created by the FIFO and allocation migrations exist. |
| Added columns | 5 columns (`invoices.paidAmount`; `payments.status`, `cancelledAt`, `cancellationReason`; `journal_entries.reversalOfId`) | Confirm the Phase 4B column additions. |
| `AuditActionType` | 5 release-scope values | Confirm `LOCK_ACQUIRED`, `LOCK_RELEASED`, `LOCK_EXTENDED`, `LOCK_RECOVERY`, and `REPLICATION_PUBLISHED`. |
| Foreign keys | All FKs on the four new tenant-scoped tables | Inspect tenant references and composite tenant-scoped relations. |
| Accounting periods | Date-based overlap check | Detect inclusive calendar-date overlaps within a tenant. |
| FIFO cost provenance | `inventory_layers.unitCost` versus `inventory_batches.cost` | Identify layer/batch cost differences above the diagnostic tolerance. |

## 4. Backup preparation — logical database export

### 4.1 Preconditions

1. Choose an encrypted storage destination outside the application repository and outside the production Supabase project. Restrict access to the release operators.
2. Record the backup timestamp, source project reference, PostgreSQL major version, Supabase CLI version, and operator.
3. Obtain connection strings through the approved secret manager. Do not commit them, paste them into tickets/chat, print them, or enable shell tracing (`set -x`).
4. Confirm sufficient storage, network access, and a maintenance/consistency window. A logical dump is not a full Supabase project snapshot.
5. Use the CLI version validated by the team. Confirm `supabase db dump --help` before use; command options can vary by CLI version. **يتطلب Supabase CLI v3 أو أحدث. تأكد من الإصدار قبل التشغيل.**

### 4.2 Export commands (template — do not execute against production as part of this PR)

```bash
set +x
umask 077
BACKUP_DIR="/secure/external/path/pharmaflow-pre-release-YYYYMMDD-HHMM"
mkdir -p "$BACKUP_DIR"

# SOURCE_DB_URL must be injected from a secret manager, never hard-coded.
: "${SOURCE_DB_URL:?Set SOURCE_DB_URL through the approved secret manager}"

supabase db dump --remote="$SOURCE_DB_URL" --role-only -f "$BACKUP_DIR/roles.sql"
supabase db dump --remote="$SOURCE_DB_URL" -f "$BACKUP_DIR/schema.sql"
supabase db dump --remote="$SOURCE_DB_URL" --use-copy --data-only \
  -x "storage.buckets_vectors" -x "storage.vector_indexes" \
  -f "$BACKUP_DIR/data.sql"

sha256sum "$BACKUP_DIR/roles.sql" "$BACKUP_DIR/schema.sql" "$BACKUP_DIR/data.sql" \
  > "$BACKUP_DIR/SHA256SUMS"
```

**Backup acceptance:** all three files exist and are non-empty; `sha256sum -c SHA256SUMS` passes; file sizes and export logs are retained; the backup is encrypted and stored separately; source/target identity and tool versions are recorded. A successful command alone is not proof of recoverability.

**Important scope limitations:** Supabase CLI database dumps normally exclude managed schemas such as `auth` and `storage` by default. Database dumps do not include Storage object bytes. Auth configuration, provider settings, API keys, project settings, Edge Functions, secrets, Realtime configuration, extensions/integrations, and other project-level settings may require separate export/recreation. Inventory these explicitly and document what is included, excluded, or **not proven**. Do not claim a full project backup from these three SQL files.

## 5. Restore and migration rehearsal — isolated PostgreSQL only

### 5.1 Isolated target gate

Provision a fresh, disposable PostgreSQL instance that is not production and has no production application traffic. Use a distinct hostname and database name (for example, `pharmaflow_restore_rehearsal`). Restrict network access. Do not reuse a production connection string.

Before restoring, verify the target using a non-secret identity query and operator-reviewed host/database metadata. If the hostname, database name, or environment cannot be positively identified as the isolated target, **STOP**. Never echo connection URLs.

```bash
set +x
: "${RESTORE_DATABASE_URL:?Set isolated restore URL from secret manager}"
psql -X "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
```

Acceptance: returned database, server address, and port match the approved isolated target record. Save the output (excluding secrets). A mismatch or ambiguous identity is an automatic stop.

### 5.2 Restore

Run only after the backup checksum gate passes and the target identity is confirmed:

```bash
psql -X --single-transaction --set ON_ERROR_STOP=1 \
  --file "$BACKUP_DIR/roles.sql" \
  --file "$BACKUP_DIR/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$BACKUP_DIR/data.sql" \
  --dbname "$RESTORE_DATABASE_URL"
```

This restore template assumes the isolated target permits role/ownership restoration and that the backup files are compatible with its PostgreSQL version. Resolve any role/extension/ownership prerequisite on the isolated target only. Do not disable constraints or triggers outside this documented restore session. If restore fails, discard and recreate the isolated target from scratch; do not patch production or edit migration history.

**Restore acceptance:** command exits zero; all expected application schemas/tables are present; representative row counts reconcile with the export manifest; key constraints are present; application roles/ownership are understood; backup checksums still pass. Record any excluded Supabase-managed/project data separately.

### 5.3 Prisma status and deployment on the clone only

Set both Prisma URLs to the isolated restored database using the approved secret manager. Ensure no inherited CI/Vercel environment can override them. Do not print values.

```bash
set +x
export DATABASE_URL="$RESTORE_DATABASE_URL"
export DIRECT_URL="$RESTORE_DATABASE_URL"

npx prisma migrate status
npx prisma migrate deploy
npx prisma migrate status
```

**Hard gate:** the shell environment and target identity must be rechecked immediately before each Prisma command. These commands are for the isolated restored clone only. Do not run `db:release`; it invokes application bootstrap behavior beyond migration deployment. Do not run `migrate resolve`, do not edit `_prisma_migrations`, and do not manually mark any migration applied or rolled back.

**Migration acceptance:** all four expected migrations complete in the Prisma-reported order; final `migrate status` reports no pending migrations; no failed/incomplete migration rows exist; the command logs and resulting migration ledger are saved. Any checksum mismatch, unexpected applied migration, drift suspicion, or SQL failure is a STOP requiring investigation on a disposable clone.

## 6. Post-migration verification checklist

Run the diagnostic SQL on the clone both before and after deployment. In addition, collect:

`AuditActionType` must contain these five values: `LOCK_ACQUIRED`, `LOCK_RELEASED`, `LOCK_EXTENDED`, `LOCK_RECOVERY`, `REPLICATION_PUBLISHED`. `BACKUP_UPLOAD` and `SESSION_CLEANED` are not required in this release; they are deferred for a future decision.

- [ ] `accounting_periods`, `inventory_layers`, `fifo_consumption_log`, `invoice_payment_allocations` exist.
- [ ] `AuditActionType` contains all five lock/replication values; `PaymentStatus` remains limited to the schema-defined values unless a separately reviewed migration changes it.
- [ ] Required indexes, primary keys, foreign keys, and CHECK constraints exist and are validated.
- [ ] No negative FIFO quantities, negative costs, invalid allocation amounts/statuses, duplicate tenant/payment/invoice allocations, or orphan tenant references.
- [ ] For every positive `inventory_batches.stockQuantity`, the legacy baseline layer exists and quantity matches; total baseline remaining quantity reconciles by batch and tenant. Do not infer historical COGS from baseline rows.
- [ ] Accounting periods have `endDate >= startDate`; overlapping periods per tenant are zero or explicitly handled by documented application policy. SQL migration alone does not enforce overlap exclusion.
- [ ] Invoice `paidAmount` backfill distribution is understood, including NULLs for legacy partial payments; `CASH` counts are reported separately for invoice status and payment status.
- [ ] Active allocation totals do not exceed payment amounts or invoice totals under the agreed business rules.
- [ ] `journal_entries.reversalOfId` and payment cancellation/reversal flows pass integration tests.
- [ ] Lock acquisition/release/recovery and replication publication audit writes pass service-level tests.
- [ ] Run Prisma schema validation/generation, TypeScript typecheck, production build, and targeted PostgreSQL integration tests against the clone.
- [ ] Exercise representative sales, purchase, returns, FIFO consumption, payment allocation, reversal, accounting-period lock, and tenant isolation workflows.

Acceptance requires zero unexplained conflicts, all expected objects/constraints, reconciled counts/totals, and passing targeted tests. Record evidence paths, commit SHA, tool versions, and test summaries. A green migration command alone is insufficient.

## 7. Rollback — rehearsal database only

There is no reverse SQL migration procedure authorized by this runbook. For an unsuccessful rehearsal:

1. Stop the test application and all clients connected to the clone.
2. Preserve logs, diagnostics, migration output, and the failed clone's metadata for analysis.
3. Drop/discard the disposable clone using its infrastructure controls, after verifying its identity one more time.
4. Provision a new isolated target and restore again from the immutable verified backup.
5. Re-run the rehearsal only after the cause is understood and documented.

Never use this rollback procedure against production. Never delete, rewrite, or manually edit `_prisma_migrations`. Do not use `migrate resolve` to bypass an error.

## 8. Risk register and decisions required before production

| Risk | Evidence / impact | Required resolution |
|---|---|---|
| Non-chronological migration history | The 2026-11-08 18:45 migration is pending while later 20:20 and 21:00 migrations were reported applied. | Rehearse exact current main migration history on restored clone; inspect all checksums and status; explain any mismatch before release. |
| `CASH` not in `PaymentStatus` enum | Schema enum has PAID, UNPAID, PARTIALLY_PAID; migration's CASH branch is unreachable for a valid enum value. | Capture actual counts; clarify business meaning; decide whether a forward-only correction is needed and test it on clone. |
| Backup scope gaps | Managed `auth`/`storage` schemas and Storage objects/project configuration may not be included in DB dumps. | Produce a separate coverage inventory and recovery procedure for auth, Storage bytes, project settings, Edge Functions, secrets, Realtime and integrations. |
| Overlapping accounting periods | Migration checks date range but has no exclusion constraint preventing tenant period overlap. | Prove application enforcement with tests or approve a separate database-level control before release. |
| FIFO baseline limitations | Only positive current batch stock is represented; historic consumption/COGS is not reconstructed. | Reconcile baseline quantities and costs; document historical provenance boundary and accounting acceptance. |
| Allocation/reversal integrity | New table enforces positive amount, status, uniqueness and tenant FKs but business totals/reversal sequencing need application tests. | Prove active allocations reconcile to payment/invoice balances and cancellation/reversal paths. |

### Production go/no-go checklist

Production release remains **NO-GO** until all are true:

1. Owner approves the final migration set and any corrective migration separately.
2. PR review and CI checks are complete; this documentation PR is not itself authorization to deploy.
3. Independent, encrypted backup is produced, checksummed, retained outside the project, and successfully restored in isolation.
4. Storage/auth/project recovery scope is explicitly documented and accepted.
5. Exact production migration ledger is reconciled with repository migration checksums on the isolated clone.
6. All four migrations pass isolated rehearsal in order, with post-migration SQL diagnostics and targeted application tests.
7. Risks above are resolved or explicitly accepted in writing by the owner.
8. A separate change window, operator, monitoring plan, and recovery decision are approved.
9. Owner provides explicit execution authorization for production. Only then may a separately reviewed procedure consider `prisma migrate deploy`; never `db:release`.

**Current state:** preparation only. Production migration execution is not authorized.
