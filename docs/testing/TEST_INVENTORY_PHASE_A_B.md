# PharmaFlow Pro — Test Inventory & Duplication Audit (Phase A/B)

**Audit date:** 2026-11-23  
**Audited branch/ref:** `main`  
**Audited commit:** `4d538e70761c9906a72ecebb2a93eba37f965f0e`  
**Scope:** read-only inventory and case-level overlap review. No test, production, accounting, FIFO, or CI behavior changed by this audit.

## Executive summary

| Metric | Result |
|---|---:|
| Tracked repository files (tree blobs) | 917 |
| Conventional Vitest test/spec files (`.test.*` / `.spec.*`) | 90 |
| Conventional files explicitly referenced by `.github/workflows/run-tests.yml` | 73 |
| Conventional files not explicitly referenced by that workflow | 17 |
| Conventional files run in the main `test` job (by explicit path) | 66 |
| Conventional files run in `PostgreSQL + HTTP Integration` job | 7 |
| Standalone `scripts/test-*.ts` files | 40 |
| npm test scripts declared in package.json | 6 |

**Interpretation:** a test file being present does not mean it runs in CI. The 17 omitted conventional files below are not explicitly named in the current workflow. The 40 standalone scripts are a separate execution surface; they are not automatically included merely because they are named `test-*.ts`.

## Inventory register — conventional test/spec files

Status is based on exact path references in the workflow at the audited commit. “PostgreSQL/HTTP” means the path is named in the dedicated job; it is not inferred from the filename.

| File | Functional domain (path/name classification) | Execution group | Explicit CI? |
|---|---|---|---|
| `app/applet/server/tests/security-patch-2.test.ts` | الأمن/الصلاحيات | Vitest | لا |
| `server/tests/atomic-post-sale-price-policy.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `server/tests/auth-register-security.integration.test.ts` | الأمن/الصلاحيات | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/auth.integration.test.ts` | الأمن/الصلاحيات | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/fifo-cost-chain.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `server/tests/fifo-layer-cost-provenance.integration.test.ts` | المخزون/FIFO | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/fifo-tenant-boundary.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `server/tests/financial-reconciliation.phase3.integration.test.ts` | المحاسبة/المالية | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/financial-transaction-sales-price-policy.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `server/tests/idempotency-middleware-security.test.ts` | الأمن/الصلاحيات | Vitest | لا |
| `server/tests/inventory-move-expiry-safety.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `server/tests/invoice-isolation.integration.test.ts` | المبيعات/الفواتير | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/jwt-secrets.test.ts` | الأمن/الصلاحيات | Vitest | نعم — test job |
| `server/tests/legacy-local-sync-cleanup.test.ts` | المزامنة | Vitest | نعم — test job |
| `server/tests/login-attempt-guard.test.ts` | عام/خدمات | Vitest | نعم — test job |
| `server/tests/manual-journal-tenant-isolation.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `server/tests/middleware-fail-closed.test.ts` | الأمن/الصلاحيات | Vitest | نعم — test job |
| `server/tests/p0-hotfix-inventory-isolation.test.ts` | المخزون/FIFO | Vitest | لا |
| `server/tests/p0-hotfix-metrics-backup.test.ts` | النسخ/الاستعادة | Vitest | لا |
| `server/tests/p0-hotfix-validation-fifo-isolation.test.ts` | المخزون/FIFO | Vitest | لا |
| `server/tests/password-hash-compatibility.test.ts` | الأمن/الصلاحيات | Vitest | نعم — test job |
| `server/tests/payment-financial-integrity-atomicity.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `server/tests/payment-idempotency-tenant-isolation.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `server/tests/post-sale-tenant-isolation.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `server/tests/prisma-recovery.test.ts` | النسخ/الاستعادة | Vitest | لا |
| `server/tests/purchase-integrity-phase2.test.ts` | المشتريات | Vitest | نعم — test job |
| `server/tests/purchase-lifecycle-financial-integrity.test.ts` | المشتريات | Vitest | لا |
| `server/tests/purchase-phase1-contract-integrity.test.ts` | المشتريات | Vitest | لا |
| `server/tests/purchase-phase2-accounting-integrity.test.ts` | المشتريات | Vitest | لا |
| `server/tests/purchase-phase2-reversal-precision.test.ts` | المشتريات | Vitest | لا |
| `server/tests/purchase-total-enforcement.test.ts` | المشتريات | Vitest | لا |
| `server/tests/sales-lifecycle-financial-integrity.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `server/tests/sales-pricing.service.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `server/tests/sales-server-price-validation.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `server/tests/supplier-payment-financial-integrity.test.ts` | المحاسبة/المالية | Vitest | لا |
| `server/tests/sync-branch-security-hardening.test.ts` | المزامنة | Vitest | نعم — test job |
| `server/tests/sync-cross-tenant-security.test.ts` | المزامنة | Vitest | لا |
| `server/tests/sync-engine-phase6-e2e.test.ts` | المزامنة | Vitest | نعم — test job |
| `server/tests/sync-security-hardening.test.ts` | المزامنة | Vitest | نعم — test job |
| `server/tests/sync.integration.test.ts` | المزامنة | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/tenant-isolation-hardening.test.ts` | الأمن/الصلاحيات | Vitest | نعم — test job |
| `server/tests/tenant-isolation-phase2.test.ts` | الأمن/الصلاحيات | Vitest | نعم — test job |
| `server/tests/voucher-allocation-posting.integration.test.ts` | المحاسبة/المالية | PostgreSQL/HTTP | نعم — PostgreSQL |
| `server/tests/voucher-cancellation-hardening.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `server/tests/voucher-sync-dispatch.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `src/core/integrity/executionGuard.local.test.ts` | النواة/سير العمل | Vitest | نعم — test job |
| `src/core/integrity/idempotencyRegistry.persistence.test.ts` | النواة/سير العمل | Vitest | نعم — test job |
| `src/core/workflow/syncContract.test.ts` | المزامنة | Vitest | نعم — test job |
| `src/core/workflow/workflowContext.branch.test.ts` | الفروع | Vitest | نعم — test job |
| `src/core/workflow/workflowContext.test.ts` | النواة/سير العمل | Vitest | نعم — test job |
| `src/core/workflow/workflowExecution.post-commit.test.ts` | النواة/سير العمل | Vitest | نعم — test job |
| `src/core/workflow/workflowExecution.sales-atomicity.integration.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/database/repositories/SupplierRepository.payment-history.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `src/database/repositories/invoice.repository.p2.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/accounting/services/AccountingEngine.sales-tax.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/accounting/services/AccountingPeriodSyncService.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `src/features/branches/services/activeBranchRegistry.test.ts` | الفروع | Vitest | نعم — test job |
| `src/features/catalog/utils/productApplicationPermission.test.ts` | الأصناف/الكتالوج | Vitest | لا |
| `src/features/catalog/workflows/ProductApplicationWorkflow.test.ts` | الأصناف/الكتالوج | Vitest | نعم — test job |
| `src/features/inventory/services/UnifiedInventoryMutationEngine.purchase-transaction.test.ts` | المشتريات | Vitest | لا |
| `src/features/inventory/services/fifoEngine.transactional.test.ts` | المخزون/FIFO | Vitest | لا |
| `src/features/inventory/services/phase0a-fifo-expiry-safety.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `src/features/inventory/utils/localSyncQueueForensics.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `src/features/inventory/utils/newPurchaseProduct.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/inventory/utils/projectedAutocompleteStock.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `src/features/inventory/workflows/__tests__/InventoryAdjustmentWorkflow.failure-injection.test.ts` | المخزون/FIFO | Vitest | نعم — test job |
| `src/features/purchases/utils/cleanupFailedPurchaseOperation.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/utils/failedPurchaseDraft.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/utils/pendingProducts.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/utils/purchaseFailureDisposition.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/utils/purchaseSaveFailure.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/utils/recoverablePurchaseDraft.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/workflows/PurchaseWorkflow.numbering.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/purchases/workflows/PurchaseWorkflow.sync.test.ts` | المشتريات | Vitest | نعم — test job |
| `src/features/sales/components/itemEntryModalLifecycle.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/components/productLookup.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/components/productRegistrationError.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/hooks/useSales.save-failure.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/services/localSalesPricing.service.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/services/salesDraftRecovery.service.test.ts` | المبيعات/الفواتير | Vitest | لا |
| `src/features/sales/utils/archiveDateFilters.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/utils/saleStockAvailability.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sales/workflows/SalesWorkflow.local-pricing.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sync/saleSyncDto.test.ts` | المبيعات/الفواتير | Vitest | نعم — test job |
| `src/features/sync/sync.engine.transactional-enqueue.test.ts` | المزامنة | Vitest | نعم — test job |
| `src/services/integrity/periodService.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `src/services/reports/reportEngine.refresh.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |
| `src/services/system/DraftService.test.ts` | المسودات | Vitest | نعم — test job |
| `src/services/system/diagnosticLogger.test.ts` | عام/خدمات | Vitest | نعم — test job |
| `src/services/transactions/PeriodLockEngine.test.ts` | المحاسبة/المالية | Vitest | نعم — test job |

## Conventional test/spec files not explicitly included in the current workflow

- `app/applet/server/tests/security-patch-2.test.ts`
- `server/tests/idempotency-middleware-security.test.ts`
- `server/tests/p0-hotfix-inventory-isolation.test.ts`
- `server/tests/p0-hotfix-metrics-backup.test.ts`
- `server/tests/p0-hotfix-validation-fifo-isolation.test.ts`
- `server/tests/prisma-recovery.test.ts`
- `server/tests/purchase-lifecycle-financial-integrity.test.ts`
- `server/tests/purchase-phase1-contract-integrity.test.ts`
- `server/tests/purchase-phase2-accounting-integrity.test.ts`
- `server/tests/purchase-phase2-reversal-precision.test.ts`
- `server/tests/purchase-total-enforcement.test.ts`
- `server/tests/supplier-payment-financial-integrity.test.ts`
- `server/tests/sync-cross-tenant-security.test.ts`
- `src/features/catalog/utils/productApplicationPermission.test.ts`
- `src/features/inventory/services/UnifiedInventoryMutationEngine.purchase-transaction.test.ts`
- `src/features/inventory/services/fifoEngine.transactional.test.ts`
- `src/features/sales/services/salesDraftRecovery.service.test.ts`

These are CI-visibility gaps, not proof that the tests are broken or obsolete. Before adding them to CI, confirm runtime prerequisites, environment isolation, execution time, and whether they test the intended current architecture.

## Standalone test scripts

The repository contains 40 files matching `scripts/test-*.ts`:

- `scripts/test-gate1-direct-write-elimination.ts`
- `scripts/test-gate2-storage-network-boundary.ts`
- `scripts/test-gate3-workflow-boundary.ts`
- `scripts/test-idempotency.ts`
- `scripts/test-integrity-hardening.ts`
- `scripts/test-multi-instance-safety.ts`
- `scripts/test-observability-recovery.ts`
- `scripts/test-ocr-document-parser.ts`
- `scripts/test-phase2-consolidation-engine.ts`
- `scripts/test-phase2.1-universal-parser.ts`
- `scripts/test-phase2.2-batch-processing-center.ts`
- `scripts/test-phase2.3-alias-learning.ts`
- `scripts/test-phase2.4-resolution-ux.ts`
- `scripts/test-phase2.5-confidence-healing.ts`
- `scripts/test-phase2.6-performance-hardening.ts`
- `scripts/test-phase2.7-e2e-certification.ts`
- `scripts/test-phase3-observability.ts`
- `scripts/test-phase3.2-inventory-reconciliation.ts`
- `scripts/test-phase3.2a-subscription-entitlement.ts`
- `scripts/test-phase3.3-inventory-correction.ts`
- `scripts/test-phase4-sync-backup-recovery.ts`
- `scripts/test-phase5-multi-device-conflict.ts`
- `scripts/test-phase6-part2-ai-safe-advisory.ts`
- `scripts/test-phase8.3-sync-security.ts`
- `scripts/test-phase8.4-reporting-engine.ts`
- `scripts/test-phase8.5-reporting-ui.ts`
- `scripts/test-phase8.6-platform-control-plane.ts`
- `scripts/test-product-matching-hardening.ts`
- `scripts/test-purchase-inventory-migration.ts`
- `scripts/test-rbac-consolidation.ts`
- `scripts/test-redis-fallback-hardening.ts`
- `scripts/test-sales-inventory-migration.ts`
- `scripts/test-smart-import-e2e-audit.ts`
- `scripts/test-smart-import-integrity.ts`
- `scripts/test-smart-purchase-import-engine.ts`
- `scripts/test-sync-consolidation.ts`
- `scripts/test-token-flow-consolidation.ts`
- `scripts/test-unified-inventory-engine-foundation.ts`
- `scripts/test-unified-inventory-mutation-e2e.ts`
- `scripts/test-workflow-orchestrator.ts`

Package scripts that expose selected standalone suites:

- `npm run test:sync` → `tsx scripts/test-phase8.3-sync-security.ts`
- `npm run test:inventory-engine` → `tsx scripts/test-unified-inventory-engine-foundation.ts`
- `npm run test:sales-migration` → `tsx scripts/test-sales-inventory-migration.ts`
- `npm run test:purchase-migration` → `tsx scripts/test-purchase-inventory-migration.ts`
- `npm run test:phase5` → `tsx scripts/test-phase5-multi-device-conflict.ts`
- `npm run test:phase6-part2` → `tsx scripts/test-phase6-part2-ai-safe-advisory.ts`

**CI finding:** the current `.github/workflows/run-tests.yml` does not invoke these npm `test:*` scripts or the 40 standalone scripts as a comprehensive script suite. Their status must be tracked separately from Vitest.

## Case-level overlap review

This review compared the actual `describe` / `it` titles and setup/import patterns in the high-risk financial suites inspected. “Overlap” means similar business invariants are asserted; it does not automatically mean duplicate tests.

### Purchase lifecycle cluster

| Files | Observed case coverage | Relationship | Disposition |
|---|---|---|---|
| `purchase-integrity-phase2.test.ts` (7 cases) | Manual invoice identity, supplier balance on edit/change, manual product validation/atomicity, idempotency, transaction abort | Overlaps with phase 1 on invoice identity, manual product atomicity and idempotency; also tests client-side Dexie workflow | Keep; tag shared invariants and retain unique supplier-edit cases |
| `purchase-phase1-contract-integrity.test.ts` (9 cases) | Manual invoice number, ID separation, tenant-scoped uniqueness, edit preservation, adjustments, rollback, idempotency/payload mismatch | Partial overlap with `purchase-integrity-phase2`; both import fake IndexedDB and the local orchestrator | Keep for now; consolidate only after assertion-level equivalence review |
| `purchase-lifecycle-financial-integrity.test.ts` (18 cases) | Invoice totals, cash/credit state, stock, payable, payment allocation, journal, failure injection, idempotency, tenant/branch boundaries | Broad lifecycle suite; overlaps with total-enforcement and other specialized suites | Keep as lifecycle anchor; preserve unique failure stages and boundary cases |
| `purchase-total-enforcement.test.ts` (6 cases) | Reject/accept adjusted total; persisted invoice, supplier balance and FT reflect adjusted total; edit reapplication | Strong partial overlap with purchase lifecycle on totals and financial projections | Candidate for selective consolidation, not file deletion |
| `purchase-phase2-accounting-integrity.test.ts` (5 cases) | Compensating reversal, double-entry balance, non-destructive FT reversal, retry, rollback | Overlaps with reversal-precision on reversal/idempotency/rollback | Keep until each case is mapped; precision suite adds multi-edit chain and isolation |
| `purchase-phase2-reversal-precision.test.ts` (8 cases) | Sequential edits, retry, rollback, FT cycles, triple-edit chain, tenant and branch isolation | Extends phase 2 accounting suite with precision/history and scope cases | Keep unique sequential and isolation cases; identify only exact duplicate assertions |

**Important architecture observation:** these purchase tests are under `server/tests`, but their imports show `fake-indexeddb/auto`, `@/core/db`, and `UnifiedBusinessWorkflowOrchestrator`. They exercise the local Dexie/application workflow, not the PostgreSQL HTTP path. Their directory name should not be used as evidence that they are server/PostgreSQL integration tests.

### Supplier payment cluster

| Files | Observed case coverage | Relationship | Disposition |
|---|---|---|---|
| `supplier-payment-financial-integrity.test.ts` (19 cases) | Positive/negative amount validation, over-allocation, balances, FT/JE, idempotency, six failure stages, cancellation | Same suite title and many of the same invariants as payment atomicity suite | High-priority duplicate-review candidate |
| `payment-financial-integrity-atomicity.test.ts` (13 cases) | Amount validation, over-allocation, paid invoice rejection, balance/paid amount, FT/JE, six rollback stages, retry | Strong overlap in domain, orchestration and repository imports; narrower case set | Do not delete either yet; compare setup and assertions line-by-line, then retain unique cases in one canonical suite |

### Other meaningful overlaps that are not duplicates

- `sales-lifecycle-financial-integrity.test.ts` and purchase lifecycle have mirrored invoice, stock, receivable/payable, accounting, atomicity and tenant/branch patterns; these are separate business flows and must remain separately asserted.
- `fifo-cost-chain.test.ts` validates the purchase/API cost-to-FIFO-to-COGS chain; `fifo-layer-cost-provenance.integration.test.ts` validates persisted layer provenance, FEFO ordering, consumption idempotency and rollback. Related coverage, not duplicates.
- `financial-reconciliation.phase3.integration.test.ts` validates cross-report reconciliation and scoped ledger results; it complements individual report-engine unit tests rather than replacing them.
- `voucher-cancellation-hardening.test.ts` contains extensive cancellation and compensating reversal invariants; payment creation suites overlap only on selected accounting/rollback properties, not the cancellation-specific invariants.

## CI and test-governance findings

1. **17 conventional files are not named in the workflow.** Some are high-risk financial, inventory and security suites (listed above). Treat this as a CI inclusion gap requiring deliberate triage.
2. **Standalone scripts are not part of the same Vitest gate.** Their execution contract, environment requirements, exit codes, and CI schedule need a separate register.
3. **Lockfile reproducibility risk:** the workflow deletes `package-lock.json` and uses `npm install`. This undermines deterministic dependency installation. Recommendation: stop deleting the lockfile and use `npm ci` after validating the committed lockfile and peer-dependency configuration.
4. **Coverage measurement is not configured in the inspected Vitest config.** `vitest.config.ts` sets globals, Node environment, setup file and aliases, but no coverage provider/thresholds. There is no evidence from this config of enforceable line/branch coverage.
5. **No browser E2E runner was found in package dependencies/config names during this inventory.** This is a discovery result, not proof that no external/manual browser testing exists.
6. **Naming/location ambiguity:** several browser/local Dexie workflow suites reside under `server/tests`; label them by actual runtime boundary, not folder name.
7. **Stale result artifact:** `.vitest/json/output.json` is a historical report unless its generating commit and run are recorded. Do not use it as current CI status.

## Phase A/B decisions

- No test files were deleted, renamed, or rewritten.
- No test assertions were changed to make CI pass.
- No production code, accounting logic, FIFO logic, migrations, or workflow behavior was modified.
- The following are **review candidates**, not approved deletions:
  - purchase identity/idempotency overlap: `purchase-integrity-phase2` ↔ `purchase-phase1-contract-integrity`
  - purchase total/projection overlap: `purchase-lifecycle-financial-integrity` ↔ `purchase-total-enforcement`
  - purchase reversal overlap: `purchase-phase2-accounting-integrity` ↔ `purchase-phase2-reversal-precision`
  - supplier-payment overlap: `supplier-payment-financial-integrity` ↔ `payment-financial-integrity-atomicity`
- CI additions should be proposed only after classifying the 17 omitted files by risk and prerequisites; do not bulk-add them blindly.
- Keep the current production branch untouched. This audit is isolated on `audit/test-inventory-phase-a-b`.

## Next engineering gate (Phase C proposal)

1. Build an assertion-level mapping for the four overlap clusters, recording test title, setup/runtime boundary, data stores, assertions and unique invariant.
2. Run the 17 CI-omitted files in an isolated environment and record actual pass/fail/skip outcomes before changing workflow membership.
3. Decide which standalone scripts become CI jobs and give each a deterministic command and timeout.
4. Repair lockfile-based install reproducibility separately.
5. Add coverage reporting only after choosing realistic per-layer thresholds; do not use a single misleading global percentage.

## Reproduction references

- Audited commit: `4d538e70761c9906a72ecebb2a93eba37f965f0e`
- Workflow: `.github/workflows/run-tests.yml`
- Vitest config: `vitest.config.ts`
- Package scripts: `package.json`
- Historical test output: `.vitest/json/output.json`
