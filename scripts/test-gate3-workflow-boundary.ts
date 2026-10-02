/**
 * PharmaFlow PRO ERP — Sovereign Enterprise Edition
 * Phase 3.4.8 Gate 3 Verification Test Suite: Core Business Workflow Orchestration
 * Unified Business Execution Boundary & Cross-Domain Transaction Orchestration
 * 
 * Verifies all 22 Architectural & Operational Constraints (Tests A through V)
 */

import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import { db } from '../src/core/db';
import { WorkflowOrchestrator } from '../src/core/workflow/workflowOrchestrator';
import { workflowRegistry } from '../src/core/workflow/workflowRegistry';
import { WorkflowContextFactory } from '../src/core/workflow/workflowContext';
import { purchaseWorkflow } from '../src/features/purchases/workflows/PurchaseWorkflow';
import { salesWorkflow } from '../src/features/sales/workflows/SalesWorkflow';
import { salesReturnWorkflow } from '../src/features/returns/workflows/SalesReturnWorkflow';
import { purchaseReturnWorkflow } from '../src/features/returns/workflows/PurchaseReturnWorkflow';
import { inventoryAdjustmentWorkflow } from '../src/features/inventory/workflows/InventoryAdjustmentWorkflow';
import { inventoryTransferWorkflow } from '../src/features/inventory/workflows/InventoryTransferWorkflow';
import { journalPostingWorkflow } from '../src/features/accounting/workflows/JournalPostingWorkflow';
import { voucherWorkflow } from '../src/features/accounting/workflows/VoucherWorkflow';
import { voucherCancellationWorkflow } from '../src/features/accounting/workflows/VoucherCancellationWorkflow';
import { salesCancellationWorkflow } from '../src/features/sales/workflows/SalesCancellationWorkflow';
import { productApplicationWorkflow } from '../src/features/catalog/workflows/ProductApplicationWorkflow';
import { IdempotencyRegistry } from '../src/core/integrity/idempotencyRegistry';
import { TokenProvider } from '../src/services/auth/tokenProvider';
import { useAuthStore } from '../src/store/authStore';
import { UnifiedBusinessWorkflowOrchestrator } from '../src/services/orchestration/UnifiedBusinessWorkflowOrchestrator';

async function runGate3TestSuite() {
  console.log('================================================================');
  console.log('🧪 PHARMAFLOW PRO ERP — GATE 3: CORE BUSINESS WORKFLOW ORCHESTRATION');
  console.log('   UNIFIED BUSINESS EXECUTION PIPELINE VERIFICATION (TESTS A - V)');
  console.log('================================================================\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${detail ? `- ${detail}` : ''}`);
      failedTests++;
    }
  }

  const setAuthUser = (
    role: string = 'SuperAdmin',
    permissions: string[] = ['ALL', 'purchases.create', 'purchases.edit', 'sales.create', 'sales.edit', 'returns.create', 'returns.process', 'inventory.adjust', 'inventory.manage', 'inventory.transfer', 'accounting.journal.create', 'accounting.voucher.create', 'accounting.voucher.cancel', 'sales.cancel', 'products.edit', 'products.manage'],
    tenantId: string = 'tenant-default'
  ) => {
    const userObj = {
      id: 'usr-admin-gate3',
      user_id: 'usr-admin-gate3',
      User_Name: 'Gate3 Enterprise Admin',
      User_Email: 'admin@gate3.pharmaflow',
      Role: role,
      User_Role: role,
      tenantId,
      tenant_id: tenantId,
      branchId: 'main',
      branch_id: 'main',
      permissions
    };
    TokenProvider.setSession(userObj as any, 'mock-jwt-token-gate3', 'mock-refresh-token-gate3');
    useAuthStore.setState({
      user: userObj as any,
      token: 'mock-jwt-token-gate3',
      tenantId,
      branchId: 'main',
      roles: [role],
      permissions,
      isAuthenticated: true,
      hasPermission: (perm: string) => permissions.includes('ALL') || permissions.includes(perm)
    });
  };

  const clearAuthentication = () => {
    TokenProvider.clearSession();
    useAuthStore.setState({
      user: null,
      token: null,
      tenantId: null,
      branchId: null,
      roles: [],
      permissions: [],
      isAuthenticated: false,
      hasPermission: () => false
    });
  };

  // Pre-seed mock database records
  await db.products.put({
    id: 'PRD-GATE3-1',
    productId: 'PRD-GATE3-1',
    name: 'Amoxicillin 500mg',
    Name: 'Amoxicillin 500mg',
    barcode: '628100099001',
    stock: 500,
    StockQuantity: 500,
    quantity: 500,
    price: 30,
    cost: 20,
    is_active: true,
    isActive: true,
    status: 'ACTIVE'
  });

  await db.warehouseStock.put({
    id: 'WHS-WH-MAIN-PRD-GATE3-1',
    warehouseId: 'WH-MAIN',
    productId: 'PRD-GATE3-1',
    quantity: 500,
    lastUpdated: new Date().toISOString()
  });

  await db.warehouseStock.put({
    id: 'WHS-MAIN-PRD-GATE3-1',
    warehouseId: 'MAIN',
    productId: 'PRD-GATE3-1',
    quantity: 500,
    lastUpdated: new Date().toISOString()
  });

  await db.customers.put({
    id: 'CUST-GATE3-1',
    name: 'Al-Amal Pharmacy Customer',
    Name: 'Al-Amal Pharmacy Customer',
    balance: 0,
    is_active: true
  });

  await db.suppliers.put({
    id: 'SUPP-GATE3-1',
    name: 'Pharma Med Supplies',
    Name: 'Pharma Med Supplies',
    balance: 0,
    is_active: true
  });

  // Set Default Authenticated Context
  setAuthUser();

  // -------------------------------------------------------------------------
  // TEST A: UI Direct Write Boundary & Static AST/Pattern Scan
  // -------------------------------------------------------------------------
  console.log('--- TEST A: UI Direct Write Boundary Scan ---');
  try {
    const srcDir = path.resolve(process.cwd(), 'src');
    const uiDirs = ['components', 'features', 'pages'];
    let forbiddenDirectMutations = 0;

    function scanDir(dir: string) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && /\.(tsx|jsx)$/.test(entry.name)) {
          const rel = path.relative(srcDir, fullPath);
          const isUi = uiDirs.some(d => rel.startsWith(d));
          if (!isUi) continue;

          const content = fs.readFileSync(fullPath, 'utf8');
          // Check for forbidden raw db mutations directly inside UI components without going through workflow/service/repo
          const rawDbWrites = content.match(/\bdb\.(sales|purchases|invoices|vouchers|journalEntries)\.(add|put|delete)\s*\(/g);
          if (rawDbWrites) {
            forbiddenDirectMutations += rawDbWrites.length;
          }
        }
      }
    }
    scanDir(srcDir);

    assert(
      forbiddenDirectMutations === 0,
      'TEST A: UI Direct Write Boundary Enforcement',
      `Found ${forbiddenDirectMutations} direct mutations in UI components`
    );
  } catch (err: any) {
    assert(false, 'TEST A: UI Direct Write Boundary Enforcement', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST B: Centralized Workflow Registry Completeness
  // -------------------------------------------------------------------------
  console.log('--- TEST B: Centralized Workflow Registry Completeness ---');
  try {
    const registered = workflowRegistry.getAll();
    const requiredWorkflowIds = [
      'purchases.invoice.process',
      'SALE',
      'returns.sales.process',
      'returns.purchase.process',
      'inventory.adjustment.process',
      'inventory.transfer.create',
      'accounting.journal.post',
      'accounting.voucher.process',
      'accounting.voucher.cancel',
      'sales.invoice.cancel',
      'catalog.product.save'
    ];

    const missing = requiredWorkflowIds.filter(id => !workflowRegistry.has(id));
    assert(
      missing.length === 0 && registered.length >= 10,
      'TEST B: Centralized Workflow Registry Completeness',
      `Missing workflows: ${missing.join(', ')}`
    );
  } catch (err: any) {
    assert(false, 'TEST B: Centralized Workflow Registry Completeness', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST C: Input Validation & Sanitization Pipeline
  // -------------------------------------------------------------------------
  console.log('--- TEST C: Input Validation & Sanitization Pipeline ---');
  try {
    setAuthUser();
    // 1. Empty items in sales
    const resEmptyItems = await WorkflowOrchestrator.execute(salesWorkflow, {
      customerId: 'CUST-GATE3-1',
      items: [],
      total: 0
    });
    // 2. Negative total in purchase
    const resNegativeTotal = await WorkflowOrchestrator.execute(purchaseWorkflow, {
      supplierId: 'SUPP-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', name: 'Item', quantity: 1, unitPrice: 10, total: 10 }],
      total: -50
    });

    assert(
      !resEmptyItems.success && !resNegativeTotal.success,
      'TEST C: Input Validation & Sanitization Pipeline',
      'Invalid inputs must be rejected at validation step'
    );
  } catch (err: any) {
    assert(false, 'TEST C: Input Validation & Sanitization Pipeline', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST D: Business Rule & Constraint Verification
  // -------------------------------------------------------------------------
  console.log('--- TEST D: Business Rule & Constraint Verification ---');
  try {
    setAuthUser();
    // Non-existent product adjustment
    const resNonExistent = await WorkflowOrchestrator.execute(inventoryAdjustmentWorkflow, {
      productId: 'NON_EXISTENT_PROD_XYZ',
      warehouseId: 'MAIN',
      actualQty: 10,
      userId: 'usr-admin-gate3'
    });

    assert(
      !resNonExistent.success && resNonExistent.error?.code === 'BUSINESS_RULE_FAILED',
      'TEST D: Business Rule & Constraint Verification',
      'Business rule failure should return BUSINESS_RULE_FAILED error code'
    );
  } catch (err: any) {
    assert(false, 'TEST D: Business Rule & Constraint Verification', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST E: Unified Authorization & RBAC Enforcement
  // -------------------------------------------------------------------------
  console.log('--- TEST E: Unified Authorization & RBAC Enforcement ---');
  try {
    // 1. Unauthenticated context
    clearAuthentication();
    const resUnauth = await WorkflowOrchestrator.execute(purchaseWorkflow, {
      supplierId: 'SUPP-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', name: 'Item', quantity: 1, unitPrice: 10, total: 10 }],
      total: 10
    });

    // 2. Insufficient permissions (Cashier trying to post journal entry)
    setAuthUser('Cashier', ['sales.create']);
    const resForbidden = await WorkflowOrchestrator.execute(journalPostingWorkflow, {
      description: 'Unauthorized Journal Entry',
      lines: [
        { accountId: 'acc-cash', debit: 100, credit: 0 },
        { accountId: 'acc-sales', debit: 0, credit: 100 }
      ]
    });

    setAuthUser();
    assert(
      !resUnauth.success && !resForbidden.success && resForbidden.error?.code === 'AUTHORIZATION_DENIED',
      'TEST E: Unified Authorization & RBAC Enforcement',
      'Unauthorized or forbidden requests must be blocked'
    );
  } catch (err: any) {
    assert(false, 'TEST E: Unified Authorization & RBAC Enforcement', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST F: Multi-Tenant & Branch Isolation
  // -------------------------------------------------------------------------
  console.log('--- TEST F: Multi-Tenant & Branch Isolation ---');
  try {
    setAuthUser('Admin', ['ALL'], 'tenant-alpha');
    const resCrossTenant = await WorkflowOrchestrator.execute(
      salesWorkflow,
      {
        customerId: 'CUST-GATE3-1',
        items: [{ id: 'PRD-GATE3-1', name: 'Item', quantity: 1, unitPrice: 30, total: 30 }],
        total: 30
      },
      { tenantId: 'tenant-beta' }
    );

    setAuthUser();
    assert(
      !resCrossTenant.success && resCrossTenant.error?.message.includes('مستأجر'),
      'TEST F: Multi-Tenant & Branch Isolation',
      'Cross-tenant execution mismatch must be strictly rejected'
    );
  } catch (err: any) {
    assert(false, 'TEST F: Multi-Tenant & Branch Isolation', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST G: Distributed Idempotency Key & Deduplication
  // -------------------------------------------------------------------------
  console.log('--- TEST G: Distributed Idempotency Key & Deduplication ---');
  try {
    setAuthUser();
    const idempotencyKey = `GATE3_IDEMPOTENCY_${Date.now()}`;

    const res1 = await WorkflowOrchestrator.execute(
      voucherWorkflow,
      {
        type: 'PAYMENT',
        partnerId: 'SUPP-GATE3-1',
        amount: 150,
        notes: 'Idempotency Gate3 Test'
      },
      { idempotencyKey }
    );

    const res2 = await WorkflowOrchestrator.execute(
      voucherWorkflow,
      {
        type: 'PAYMENT',
        partnerId: 'SUPP-GATE3-1',
        amount: 150,
        notes: 'Idempotency Gate3 Test'
      },
      { idempotencyKey }
    );

    assert(
      res1.success && res2.success,
      'TEST G: Distributed Idempotency Key & Deduplication',
      'Duplicate execution with same key should return idempotent success'
    );
  } catch (err: any) {
    assert(false, 'TEST G: Distributed Idempotency Key & Deduplication', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST H: ExecutionGuard Concurrency Lock
  // -------------------------------------------------------------------------
  console.log('--- TEST H: ExecutionGuard Concurrency Lock ---');
  try {
    setAuthUser();
    const lockKey = `CONCURRENCY_LOCK_GATE3_${Date.now()}`;

    const p1 = WorkflowOrchestrator.execute(
      inventoryAdjustmentWorkflow,
      { productId: 'PRD-GATE3-1', warehouseId: 'MAIN', actualQty: 480, userId: 'usr-admin-gate3' },
      { idempotencyKey: lockKey }
    );

    const p2 = WorkflowOrchestrator.execute(
      inventoryAdjustmentWorkflow,
      { productId: 'PRD-GATE3-1', warehouseId: 'MAIN', actualQty: 480, userId: 'usr-admin-gate3' },
      { idempotencyKey: lockKey }
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    assert(
      (r1.success || r2.success) && !(r1.success && r2.success && (r1.data as any)?.adjustmentId !== (r2.data as any)?.adjustmentId),
      'TEST H: ExecutionGuard Concurrency Lock',
      'Concurrent executions must be serialized and locked'
    );
  } catch (err: any) {
    assert(false, 'TEST H: ExecutionGuard Concurrency Lock', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST I: Atomic Transaction Boundary & All-or-Nothing Rollback
  // -------------------------------------------------------------------------
  console.log('--- TEST I: Atomic Transaction Boundary & Rollback ---');
  try {
    setAuthUser();
    const rollbackKey = `ROLLBACK_TEST_GATE3_${Date.now()}`;

    const resRollback = await WorkflowOrchestrator.execute(
      salesWorkflow,
      {
        customerId: 'CUST-GATE3-1',
        items: [{ id: 'PRD-GATE3-1', name: 'Item', quantity: -10, unitPrice: 30, total: -300 }],
        total: -300
      },
      { idempotencyKey: rollbackKey }
    );

    // Verify idempotency record is not marked as COMMITTED
    const idemRecord = await IdempotencyRegistry.get(rollbackKey);

    assert(
      !resRollback.success && (!idemRecord || idemRecord.status !== 'COMMITTED'),
      'TEST I: Atomic Transaction Boundary & Rollback',
      'Failed transactions must rollback all states cleanly'
    );
  } catch (err: any) {
    assert(false, 'TEST I: Atomic Transaction Boundary & Rollback', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST J: Offline-First Local Execution & Sync Outbox Enqueue
  // -------------------------------------------------------------------------
  console.log('--- TEST J: Offline-First Local Execution ---');
  try {
    setAuthUser();
    const resOffline = await WorkflowOrchestrator.execute(
      salesWorkflow,
      {
        customerId: 'CUST-GATE3-1',
        items: [{ id: 'PRD-GATE3-1', productId: 'PRD-GATE3-1', name: 'Amoxicillin 500mg', quantity: 2, unitPrice: 30, total: 60 }],
        total: 60,
        isCash: true
      },
      { offlineMode: true }
    );

    assert(
      resOffline.success && (resOffline.syncStatus === 'ENQUEUED' || resOffline.metadata?.syncStatus === 'ENQUEUED' || resOffline.data?.syncStatus === 'ENQUEUED'),
      'TEST J: Offline-First Local Execution & Sync Outbox Enqueue',
      'Offline execution must complete locally and enqueue for sync'
    );
  } catch (err: any) {
    assert(false, 'TEST J: Offline-First Local Execution & Sync Outbox Enqueue', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST K: Cross-Domain Sales Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST K: Cross-Domain Sales Workflow Orchestration ---');
  try {
    setAuthUser();
    const saleResult = await WorkflowOrchestrator.execute(salesWorkflow, {
      customerId: 'CUST-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', productId: 'PRD-GATE3-1', name: 'Amoxicillin 500mg', quantity: 5, unitPrice: 30, total: 150 }],
      total: 150,
      isCash: false
    });

    assert(
      saleResult.success && !!(saleResult.data?.invoiceId || (saleResult.data as any)?.refId || (saleResult.data as any)?.id),
      'TEST K: Cross-Domain Sales Workflow Orchestration',
      'Sales workflow must coordinate inventory, accounting, and balance'
    );
  } catch (err: any) {
    assert(false, 'TEST K: Cross-Domain Sales Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST L: Cross-Domain Purchase Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST L: Cross-Domain Purchase Workflow Orchestration ---');
  try {
    setAuthUser();
    const purchaseResult = await WorkflowOrchestrator.execute(purchaseWorkflow, {
      supplierId: 'SUPP-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', productId: 'PRD-GATE3-1', name: 'Amoxicillin 500mg', quantity: 20, unitPrice: 20, total: 400 }],
      total: 400,
      isCash: true
    });

    assert(
      purchaseResult.success && !!purchaseResult.data?.refId,
      'TEST L: Cross-Domain Purchase Workflow Orchestration',
      'Purchase workflow must coordinate layers, ledger, and supplier status'
    );
  } catch (err: any) {
    assert(false, 'TEST L: Cross-Domain Purchase Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST M: Cross-Domain Sales Return Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST M: Cross-Domain Sales Return Workflow Orchestration ---');
  try {
    setAuthUser();
    const salesReturnResult = await WorkflowOrchestrator.execute(salesReturnWorkflow, {
      originalSaleId: 'SALE-GATE3-REF',
      customerId: 'CUST-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', productId: 'PRD-GATE3-1', name: 'Amoxicillin 500mg', quantity: 1, unitPrice: 30, total: 30 }],
      total: 30,
      reason: 'Customer returned sealed box'
    });

    assert(
      salesReturnResult.success && !!salesReturnResult.data?.refId,
      'TEST M: Cross-Domain Sales Return Workflow Orchestration',
      'Sales return workflow must restore inventory and reverse financial entries'
    );
  } catch (err: any) {
    assert(false, 'TEST M: Cross-Domain Sales Return Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST N: Cross-Domain Purchase Return Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST N: Cross-Domain Purchase Return Workflow Orchestration ---');
  try {
    setAuthUser();
    const purchaseReturnResult = await WorkflowOrchestrator.execute(purchaseReturnWorkflow, {
      originalPurchaseId: 'PUR-GATE3-REF',
      supplierId: 'SUPP-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', productId: 'PRD-GATE3-1', name: 'Amoxicillin 500mg', quantity: 2, unitPrice: 20, total: 40 }],
      total: 40,
      reason: 'Damaged packaging from distributor'
    });

    assert(
      purchaseReturnResult.success && !!purchaseReturnResult.data?.refId,
      'TEST N: Cross-Domain Purchase Return Workflow Orchestration',
      'Purchase return workflow must reduce stock and adjust supplier debit'
    );
  } catch (err: any) {
    assert(false, 'TEST N: Cross-Domain Purchase Return Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST O: Inventory Adjustment Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST O: Inventory Adjustment Workflow Orchestration ---');
  try {
    setAuthUser();
    const adjResult = await WorkflowOrchestrator.execute(inventoryAdjustmentWorkflow, {
      productId: 'PRD-GATE3-1',
      warehouseId: 'MAIN',
      actualQty: 520,
      userId: 'usr-admin-gate3',
      notes: 'Physical audit correction'
    });

    assert(
      adjResult.success && !!adjResult.data?.adjustmentId,
      'TEST O: Inventory Adjustment Workflow Orchestration',
      'Adjustment workflow must update physical quantities and record delta'
    );
  } catch (err: any) {
    assert(false, 'TEST O: Inventory Adjustment Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST P: Inventory Transfer Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST P: Inventory Transfer Workflow Orchestration ---');
  try {
    setAuthUser();
    const transferResult = await WorkflowOrchestrator.execute(inventoryTransferWorkflow, {
      sourceBranchId: 'BRANCH-MAIN',
      targetBranchId: 'BRANCH-EAST',
      items: [{ productId: 'PRD-GATE3-1', qty: 10 }],
      notes: 'Branch transfer requisition'
    });

    assert(
      transferResult.success && !!transferResult.data?.transferId,
      'TEST P: Inventory Transfer Workflow Orchestration',
      'Transfer workflow must initiate multi-branch inventory movements'
    );
  } catch (err: any) {
    assert(false, 'TEST P: Inventory Transfer Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST Q: Accounting Voucher Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST Q: Accounting Voucher Workflow Orchestration ---');
  try {
    setAuthUser();
    const voucherResult = await WorkflowOrchestrator.execute(voucherWorkflow, {
      type: 'RECEIPT',
      partnerId: 'CUST-GATE3-1',
      amount: 250,
      notes: 'Customer payment receipt'
    });

    assert(
      voucherResult.success && !!(voucherResult.data?.id || voucherResult.data?.voucher),
      'TEST Q: Accounting Voucher Workflow Orchestration',
      'Voucher workflow must record receipts and payments with accounting lines'
    );
  } catch (err: any) {
    assert(false, 'TEST Q: Accounting Voucher Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST R: Accounting Journal Posting Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST R: Accounting Journal Posting Workflow Orchestration ---');
  try {
    setAuthUser();
    const journalResult = await WorkflowOrchestrator.execute(journalPostingWorkflow, {
      description: 'End of period adjustment',
      lines: [
        { accountId: 'acc-cash', debit: 500, credit: 0 },
        { accountId: 'acc-sales', debit: 0, credit: 500 }
      ]
    });

    assert(
      journalResult.success && !!(journalResult.data?.journalId || journalResult.data?.entry),
      'TEST R: Accounting Journal Posting Workflow Orchestration',
      'Journal posting workflow must validate debit-credit equality and create lines'
    );
  } catch (err: any) {
    assert(false, 'TEST R: Accounting Journal Posting Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST S: Sales & Voucher Cancellation Workflow Orchestration
  // -------------------------------------------------------------------------
  console.log('--- TEST S: Sales & Voucher Cancellation Workflow Orchestration ---');
  try {
    setAuthUser();
    const seedVoucher = {
      id: 'VOUCHER-GATE3-CANCEL',
      type: 'PAYMENT' as const,
      partnerId: 'SUPP-GATE3-1',
      amount: 100,
      paymentMethod: 'CASH' as const,
      date: new Date().toISOString()
    };
    await db.vouchers.put(seedVoucher);

    const seedSale = {
      id: 'SALE-GATE3-CANCEL',
      invoiceNumber: 'INV-CANCEL-1',
      date: new Date().toISOString(),
      partnerId: 'CUST-GATE3-1',
      type: 'SALE',
      subtotal: 50,
      finalTotal: 50,
      items: [{ productId: 'PRD-GATE3-1', name: 'Amox', quantity: 1, unitPrice: 50, total: 50 }],
      InvoiceStatus: 'POSTED',
      documentStatus: 'POSTED'
    };
    await db.invoices.put(seedSale as any);
    await db.sales.put(seedSale as any);

    const cancelVoucherResult = await WorkflowOrchestrator.execute(voucherCancellationWorkflow, {
      id: 'VOUCHER-GATE3-CANCEL',
      type: 'PAYMENT',
      partnerId: 'SUPP-GATE3-1',
      amount: 100,
      reason: 'Entered duplicate payment by mistake'
    });

    const cancelSaleResult = await WorkflowOrchestrator.execute(salesCancellationWorkflow, {
      invoiceId: 'SALE-GATE3-CANCEL',
      reason: 'Order cancelled before delivery'
    });

    assert(
      cancelVoucherResult.success && cancelSaleResult.success,
      'TEST S: Sales & Voucher Cancellation Workflow Orchestration',
      'Cancellation workflows must handle reversal and status change'
    );
  } catch (err: any) {
    assert(false, 'TEST S: Sales & Voucher Cancellation Workflow Orchestration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST T: Centralized Audit Trail & Context Traceability
  // -------------------------------------------------------------------------
  console.log('--- TEST T: Centralized Audit Trail & Traceability ---');
  try {
    setAuthUser();
    const correlationId = `CORR_GATE3_TRACE_${Date.now()}`;
    const productResult = await WorkflowOrchestrator.execute(
      productApplicationWorkflow,
      {
        product: {
          id: 'PRD-TRACE-1',
          name: 'Paracetamol 500mg',
          stock: 100,
          price: 15
        } as any,
        isNew: true
      },
      { correlationId }
    );

    assert(
      productResult.success && productResult.metadata?.correlationId === correlationId,
      'TEST T: Centralized Audit Trail & Context Traceability',
      'Context traceability must carry correlation ID and log audit details'
    );
  } catch (err: any) {
    assert(false, 'TEST T: Centralized Audit Trail & Context Traceability', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST U: Enterprise Observability & Diagnostics Integration
  // -------------------------------------------------------------------------
  console.log('--- TEST U: Enterprise Observability & Diagnostics ---');
  try {
    setAuthUser();
    // Test that failed workflow registers incident in recovery
    const failRes = await WorkflowOrchestrator.execute(salesWorkflow, {
      customerId: 'CUST-GATE3-1',
      items: [],
      total: -1
    });

    assert(
      !failRes.success && (typeof failRes.auditReference === 'string' || typeof failRes.metadata?.auditReference === 'string'),
      'TEST U: Enterprise Observability & Diagnostics Integration',
      'Observability and IncidentRecovery must register failure references'
    );
  } catch (err: any) {
    assert(false, 'TEST U: Enterprise Observability & Diagnostics Integration', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST V: Complete 15-Step E2E Lifecycle Execution
  // -------------------------------------------------------------------------
  console.log('--- TEST V: Complete 15-Step E2E Lifecycle Execution ---');
  try {
    setAuthUser();
    const e2eResult = await UnifiedBusinessWorkflowOrchestrator.processPurchase({
      supplierId: 'SUPP-GATE3-1',
      items: [{ id: 'PRD-GATE3-1', name: 'Amoxicillin 500mg', quantity: 15, unitPrice: 20, total: 300 }],
      total: 300,
      notes: 'Full Enterprise 15-Step Pipeline'
    }, { isCash: true });

    assert(
      e2eResult.success && !!e2eResult.refId,
      'TEST V: Complete 15-Step E2E Lifecycle Execution',
      'Complete end-to-end execution pipeline succeeded without errors'
    );
  } catch (err: any) {
    assert(false, 'TEST V: Complete 15-Step E2E Lifecycle Execution', err.message);
  }

  console.log('\n================================================================');
  console.log(`📊 GATE 3 VERIFICATION SUMMARY:`);
  console.log(`   TOTAL TESTS:  ${passedTests + failedTests}`);
  console.log(`   PASSED TESTS: ${passedTests}`);
  console.log(`   FAILED TESTS: ${failedTests}`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runGate3TestSuite().catch(err => {
  console.error('Fatal error in Gate 3 test suite runner:', err);
  process.exit(1);
});
