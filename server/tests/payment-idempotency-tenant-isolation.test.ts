import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedBusinessWorkflowOrchestrator } from '@/services/orchestration/UnifiedBusinessWorkflowOrchestrator';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { WorkflowOrchestrator } from '@/core/workflow';
import { voucherWorkflow } from '@/features/accounting/workflows/VoucherWorkflow';
import { useAuthStore } from '@/store/authStore';
import { authService } from '@/features/auth/services/authService';
import { db } from '@/core/db';
import { PurchaseRepository } from '@/database/repositories/PurchaseRepository';

describe('Supplier Payment: Idempotency & Tenant Isolation Hardening Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    IdempotencyRegistry.clearInMemory();
    useAuthStore.setState({
      user: null,
      tenantId: null,
      branchId: null,
      roles: [],
      permissions: [],
      isAuthenticated: false
    });
  });

  // =========================================================================
  // 1. acquireIdempotencyKey & Fail-Closed Tenant / Branch Context
  // =========================================================================
  describe('1. acquireIdempotencyKey: Fail-Closed Context & Fallback Prevention', () => {
    it('NEGATIVE: rejects when tenantId is missing or null', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', undefined, 'BRH-01')
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Tenant Context Required/i);
    });

    it('NEGATIVE: rejects when tenantId is "default" or "default-tenant" or "main"', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'default', 'BRH-01')
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Tenant Context Required/i);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'default-tenant', 'BRH-01')
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Tenant Context Required/i);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'main', 'BRH-01')
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Tenant Context Required/i);
    });

    it('NEGATIVE: rejects when branchId is missing or hardcoded fallback ("main", "default", "BRH-DEFAULT")', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'TEN-REAL-01', undefined)
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Branch Context Required/i);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'TEN-REAL-01', 'main')
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Branch Context Required/i);

      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'TEN-REAL-01', 'BRH-DEFAULT')
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Branch Context Required/i);
    });

    it('POSITIVE: successfully acquires key with trusted tenant and branch', async () => {
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey('KEY-001', 'TEN-PHARMA-100', 'BRH-NORTH-01')
      ).resolves.not.toThrow();

      const record = await IdempotencyRegistry.get('KEY-001', 'TEN-PHARMA-100');
      expect(record).not.toBeNull();
      expect(record?.status).toBe('PROCESSING');
      expect(record?.tenantId).toBe('TEN-PHARMA-100');
      expect(record?.branchId).toBe('BRH-NORTH-01');
    });
  });

  // =========================================================================
  // 2. Idempotency Key Scoping across Tenants (Tenant A vs Tenant B)
  // =========================================================================
  describe('2. Idempotency Key Scoping: Cross-Tenant Isolation', () => {
    it('Tenant A and Tenant B using the EXACT SAME key are isolated without collisions or cross-tenant leaks', async () => {
      const sharedKey = 'PAYMENT-OP-IDENTICAL-KEY';

      // Tenant A acquires the key
      await UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey(sharedKey, 'TENANT-A', 'BRH-A1');
      await IdempotencyRegistry.updateStatus(sharedKey, 'COMMITTED', { resultId: 'A-SUCCESS' }, undefined, 'TENANT-A');

      // Tenant B queries the same key under Tenant B context -> MUST be null (isolated!)
      const tenantBCheck = await IdempotencyRegistry.get(sharedKey, 'TENANT-B');
      expect(tenantBCheck).toBeNull();

      // Tenant B can acquire the exact same key without collision
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey(sharedKey, 'TENANT-B', 'BRH-B1')
      ).resolves.not.toThrow();

      const tenantBRecord = await IdempotencyRegistry.get(sharedKey, 'TENANT-B');
      expect(tenantBRecord).not.toBeNull();
      expect(tenantBRecord?.tenantId).toBe('TENANT-B');

      // Tenant A record remains untouched
      const tenantARecord = await IdempotencyRegistry.get(sharedKey, 'TENANT-A');
      expect(tenantARecord?.result?.resultId).toBe('A-SUCCESS');
    });
  });

  // =========================================================================
  // 3. Retry, Concurrency & Payload Mismatch Safety
  // =========================================================================
  describe('3. Concurrency & Retry Behavior', () => {
    it('Concurrent requests with the same key in PROCESSING state are rejected', async () => {
      const key = 'CONCURRENT-TX-001';
      await UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey(key, 'TENANT-TEST', 'BRH-01');

      // Second simultaneous request with same key while first is PROCESSING throws
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey(key, 'TENANT-TEST', 'BRH-01')
      ).rejects.toThrow(/العملية قيد المعالجة حالياً/);
    });

    it('Duplicate retry of already COMMITTED request succeeds idempotently', async () => {
      const key = 'RETRY-TX-001';
      await UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey(key, 'TENANT-TEST', 'BRH-01');
      await IdempotencyRegistry.updateStatus(key, 'COMMITTED', { amount: 500 }, undefined, 'TENANT-TEST');

      // Retry does not throw and does not re-process
      await expect(
        UnifiedBusinessWorkflowOrchestrator.acquireIdempotencyKey(key, 'TENANT-TEST', 'BRH-01')
      ).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // 4. processSupplierPayment Execution & Cross-Tenant Protection
  // =========================================================================
  describe('4. processSupplierPayment: Workflow Execution & Tenant Isolation', () => {
    it('NEGATIVE: processSupplierPayment fails closed if tenant context is missing', async () => {
      useAuthStore.setState({
        user: null,
        tenantId: null,
        branchId: null,
        isAuthenticated: false
      });

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-001',
          amount: 250
        })
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Tenant Context Required/i);
    });

    it('NEGATIVE: processSupplierPayment fails closed if branch context is missing or fallback', async () => {
      useAuthStore.setState({
        user: { id: 'usr-1', tenantId: 'TENANT-A', branchId: 'main' } as any,
        tenantId: 'TENANT-A',
        branchId: 'main', // Hardcoded 'main' is rejected
        isAuthenticated: true
      });

      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-001',
          amount: 250
        })
      ).rejects.toThrow(/FAIL_CLOSED.*Trusted Branch Context Required/i);
    });

    it('NEGATIVE: Tenant A cannot allocate payment to invoice belonging to Tenant B', async () => {
      const mockInvoice = {
        id: 'INV-TENANT-B-001',
        tenantId: 'TENANT-B',
        partnerId: 'SUP-001',
        totalAmount: 1000,
        paidAmount: 0,
        type: 'PURCHASE'
      };

      await db.invoices.put(mockInvoice as any);

      // Attempt to update paid amount as Tenant A
      await expect(
        PurchaseRepository.updatePaidAmount('INV-TENANT-B-001', 200, 'TENANT-A')
      ).rejects.toThrow(/CROSS_TENANT_INVOICE_FORBIDDEN/i);
    });

    it('NEGATIVE: VoucherWorkflow validation rejects supplier belonging to another tenant', async () => {
      const mockSupplier = {
        id: 'SUP-FOREIGN-99',
        tenantId: 'TENANT-OTHER',
        Supplier_Name: 'Foreign Supplier',
        balance: 500
      };

      await db.suppliers.put(mockSupplier as any);

      const ctx: any = {
        tenantId: 'TENANT-A',
        branchId: 'BRH-A1',
        userId: 'usr-1'
      };

      await expect(
        voucherWorkflow.validateBusinessRules(
          {
            type: 'PAYMENT',
            partnerId: 'SUP-FOREIGN-99',
            amount: 150
          },
          ctx
        )
      ).rejects.toThrow(/CROSS_TENANT_SUPPLIER_FORBIDDEN/i);
    });

    it('POSITIVE: Replaying duplicate payment request with same key returns cached result', async () => {
      const key = 'IDEMP-REPLAY-SUCCESS-01';
      const tenantId = 'TENANT-ALPHA';
      const branchId = 'BRH-ALPHA-1';

      // Pre-commit an idempotency record for this key
      const cachedPaymentResult = {
        id: 'PYMT-001',
        voucher: { id: 'PYMT-001', amount: 300 },
        document: { id: 'PYMT-001', amount: 300, supplier_id: 'SUP-01' }
      };

      await IdempotencyRegistry.save({
        key,
        status: 'COMMITTED',
        tenantId,
        branchId,
        operationType: 'VOUCHER',
        entityType: 'ACCOUNTING.VOUCHER.PROCESS',
        fingerprint: JSON.stringify({
          type: 'PAYMENT',
          partnerId: 'SUP-01',
          amount: 300,
          notes: undefined,
          date: undefined,
          paymentMethod: undefined,
          allocations: undefined
        }),
        createdAt: new Date().toISOString(),
        result: cachedPaymentResult,
        responseData: cachedPaymentResult
      });

      // Ensure supplier exists in DB
      await db.suppliers.put({
        id: 'SUP-01',
        tenantId,
        Supplier_Name: 'Alpha Supplier',
        balance: 1000
      } as any);

      // Set auth context
      useAuthStore.setState({
        user: { id: 'usr-alpha', tenantId, branchId, role: 'accountant', roles: ['accountant'], permissions: ['accounting.voucher.create', 'vouchers.create'] } as any,
        tenantId,
        branchId,
        roles: ['accountant'],
        permissions: ['accounting.voucher.create', 'vouchers.create'],
        isAuthenticated: true
      });

      const replayResult = await UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
        partnerId: 'SUP-01',
        amount: 300,
        idempotencyKey: key
      });

      expect(replayResult.success).toBe(true);
      expect(replayResult.payment.id).toBe('PYMT-001');
      expect(replayResult.payment.amount).toBe(300);
    });

    it('NEGATIVE: Same idempotency key with DIFFERENT payload throws IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
      const key = 'IDEMP-MISMATCH-TEST-01';
      const tenantId = 'TENANT-ALPHA';
      const branchId = 'BRH-ALPHA-1';

      // Pre-commit with payload amount: 300
      await IdempotencyRegistry.save({
        key,
        status: 'COMMITTED',
        tenantId,
        branchId,
        operationType: 'VOUCHER',
        entityType: 'ACCOUNTING.VOUCHER.PROCESS',
        fingerprint: JSON.stringify({
          type: 'PAYMENT',
          partnerId: 'SUP-01',
          amount: 300
        }),
        createdAt: new Date().toISOString(),
        result: { id: 'PYMT-001' }
      });

      // Ensure supplier exists in DB
      await db.suppliers.put({
        id: 'SUP-01',
        tenantId,
        Supplier_Name: 'Alpha Supplier',
        balance: 1000
      } as any);

      useAuthStore.setState({
        user: { id: 'usr-alpha', tenantId, branchId, role: 'accountant', roles: ['accountant'], permissions: ['accounting.voucher.create', 'vouchers.create'] } as any,
        tenantId,
        branchId,
        roles: ['accountant'],
        permissions: ['accounting.voucher.create', 'vouchers.create'],
        isAuthenticated: true
      });

      // Attempt same key with DIFFERENT payload amount: 999
      await expect(
        UnifiedBusinessWorkflowOrchestrator.processSupplierPayment({
          partnerId: 'SUP-01',
          amount: 999,
          idempotencyKey: key
        })
      ).rejects.toThrow(/IDEMPOTENCY_PAYLOAD_MISMATCH/i);
    });
  });
});
