// src/features/inventory/services/InventoryCorrectionService.ts
/**
 * PharmaFlow PRO ERP — Phase 3.3: Controlled Inventory Correction Service
 * Enforces human-governed resolution, strict RBAC, multi-tenant isolation,
 * atomic transactions, idempotency, and post-execution reconciliation verification.
 */

import { db, getCurrentUserSession } from '@/core/db';
import { InventoryCorrectionRepository } from '../repositories/InventoryCorrectionRepository';
import { 
  InventoryReconciliationService, 
  ProductReconciliationAudit
} from './InventoryReconciliationService';
import { 
  InventoryCorrectionCase, 
  CorrectionProposal, 
  CorrectionApproval, 
  UserSecurityContext
} from '../types/correction.types';
import { AuditService } from '@/services/system/AuditService';

// Custom Enterprise Domain Errors
export class UnauthorizedCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedCorrectionError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export class DuplicateExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateExecutionError';
  }
}

export class ReconciliationVerificationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationVerificationFailedError';
  }
}

export class MandatoryFieldMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MandatoryFieldMissingError';
  }
}

export class InventoryCorrectionService {

  // =========================================================================
  // RBAC & PERMISSION POLICIES
  // =========================================================================
  
  private static readonly APPROVER_ROLES = new Set([
    'ADMIN', 'ADMINISTRATOR', 'OWNER', 'SUPER_ADMIN', 'SYSTEM_ADMIN'
  ]);

  private static readonly REVIEWER_ROLES = new Set([
    'ADMIN', 'ADMINISTRATOR', 'OWNER', 'SUPER_ADMIN', 'SYSTEM_ADMIN',
    'MANAGER', 'INVENTORY_MANAGER', 'ACCOUNTANT', 'CHIEF_PHARMACIST'
  ]);

  private static normalizeRole(role?: string): string {
    if (!role) return 'EMPLOYEE';
    return role.trim().toUpperCase().replace(/[\s-]/g, '_');
  }

  static canReview(role?: string): boolean {
    const r = this.normalizeRole(role);
    return this.REVIEWER_ROLES.has(r);
  }

  static canPropose(role?: string): boolean {
    const r = this.normalizeRole(role);
    return this.REVIEWER_ROLES.has(r);
  }

  static canApprove(role?: string): boolean {
    const r = this.normalizeRole(role);
    return this.APPROVER_ROLES.has(r);
  }

  static canExecute(role?: string): boolean {
    const r = this.normalizeRole(role);
    return this.APPROVER_ROLES.has(r);
  }

  // =========================================================================
  // 1. CASE CREATION (From Read-Only Reconciliation)
  // Strictly creates OPEN cases for human review. Never auto-fixes.
  // =========================================================================
  static async registerDiscrepancyCases(
    audit: ProductReconciliationAudit,
    context?: Partial<UserSecurityContext>
  ): Promise<InventoryCorrectionCase[]> {
    if (!audit || !audit.discrepancies || audit.discrepancies.length === 0) {
      return [];
    }

    const session = getCurrentUserSession();
    const tenantId = context?.tenantId || audit.tenantId || session.tenantId;
    const branchId = context?.branchId ?? audit.branchId ?? session.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: No valid trusted tenant context available for discrepancy registration.');
    }

    const createdCases: InventoryCorrectionCase[] = [];

    for (const disc of audit.discrepancies) {
      // 1. Check if an active open case already exists to prevent duplication
      const existing = await InventoryCorrectionRepository.findExistingOpenCase(
        audit.productId,
        disc.type,
        tenantId,
        branchId
      );

      if (existing) {
        continue;
      }

      // 2. Build new case in OPEN status
      const caseNumber = await InventoryCorrectionRepository.getNextCaseNumber(tenantId);
      const caseId = `CASE-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const now = new Date().toISOString();

      const newCase: InventoryCorrectionCase = {
        id: caseId,
        caseNumber,
        tenantId,
        branchId,
        productId: audit.productId,
        productName: audit.productName,
        categoryName: audit.categoryName,
        discrepancyType: disc.type,
        severity: disc.severity,
        status: 'OPEN',
        details: {
          expectedQty: disc.expected,
          actualQty: disc.actual,
          variance: disc.difference,
          sourceDocId: disc.documentId,
          diagnosticMessage: disc.reason,
          rawDiscrepancy: disc
        },
        auditTrail: [{
          id: `AUD-${Date.now()}-1`,
          timestamp: now,
          action: 'CASE_OPENED',
          userId: context?.userId || session.userId || 'SYSTEM',
          userName: context?.userName || 'Reconciliation Engine',
          userRole: context?.role || 'SYSTEM',
          previousStatus: 'OPEN',
          newStatus: 'OPEN',
          notes: `تم رصد فرق مخزني (${disc.type}): ${disc.reason}`
        }],
        createdAt: now,
        updatedAt: now
      };

      const saved = await InventoryCorrectionRepository.save(newCase);
      createdCases.push(saved);
    }

    return createdCases;
  }

  // =========================================================================
  // 2. CASE LIFECYCLE: START REVIEW (OPEN -> UNDER_REVIEW)
  // =========================================================================
  static async startReview(
    caseId: string,
    user: UserSecurityContext,
    notes?: string
  ): Promise<InventoryCorrectionCase> {
    if (!this.canReview(user.role)) {
      throw new UnauthorizedCorrectionError(`User role ${user.role} is not authorized to review correction cases.`);
    }

    const currentCase = await InventoryCorrectionRepository.findById(caseId, user.tenantId);
    if (!currentCase) {
      throw new Error(`Correction case ${caseId} not found or tenant mismatch.`);
    }

    if (currentCase.status !== 'OPEN' && currentCase.status !== 'UNDER_REVIEW') {
      throw new InvalidStateTransitionError(
        `Cannot review case in status '${currentCase.status}'. Case must be 'OPEN'.`
      );
    }

    const now = new Date().toISOString();
    currentCase.status = 'UNDER_REVIEW';
    currentCase.assignedTo = user.userId;
    currentCase.reviewedBy = user.userName || user.userId;
    currentCase.reviewedAt = now;
    if (notes) currentCase.reviewNotes = notes;

    currentCase.auditTrail.push({
      id: `AUD-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      timestamp: now,
      action: 'REVIEW_STARTED',
      userId: user.userId,
      userName: user.userName || user.userId,
      userRole: user.role,
      previousStatus: 'OPEN',
      newStatus: 'UNDER_REVIEW',
      notes: notes || 'بدأت عملية مراجعة وتدقيق الفرق المخزني بواسطة المسؤول المختص'
    });

    return await InventoryCorrectionRepository.save(currentCase);
  }

  // =========================================================================
  // 3. CASE LIFECYCLE: SUBMIT PROPOSAL (UNDER_REVIEW / OPEN -> PROPOSED)
  // =========================================================================
  static async submitProposal(
    caseId: string,
    proposal: Omit<CorrectionProposal, 'proposedBy' | 'proposedRole' | 'proposedAt'>,
    user: UserSecurityContext
  ): Promise<InventoryCorrectionCase> {
    if (!this.canPropose(user.role)) {
      throw new UnauthorizedCorrectionError(`User role ${user.role} is not authorized to propose corrections.`);
    }

    if (!proposal.reason || proposal.reason.trim().length < 5) {
      throw new MandatoryFieldMissingError('A detailed reason (minimum 5 characters) is strictly mandatory for any correction proposal.');
    }

    const currentCase = await InventoryCorrectionRepository.findById(caseId, user.tenantId);
    if (!currentCase) {
      throw new Error(`Correction case ${caseId} not found or tenant mismatch.`);
    }

    if (currentCase.status !== 'OPEN' && currentCase.status !== 'UNDER_REVIEW' && currentCase.status !== 'REJECTED') {
      throw new InvalidStateTransitionError(
        `Cannot propose correction for case in status '${currentCase.status}'. Must be 'OPEN' or 'UNDER_REVIEW'.`
      );
    }

    const now = new Date().toISOString();
    const fullProposal: CorrectionProposal = {
      ...proposal,
      targetWarehouseId: proposal.targetWarehouseId || 'WH-MAIN',
      proposedBy: user.userId,
      proposedRole: user.role,
      proposedAt: now
    };

    const prevStatus = currentCase.status;
    currentCase.status = 'PROPOSED';
    currentCase.proposedAction = fullProposal;

    currentCase.auditTrail.push({
      id: `AUD-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      timestamp: now,
      action: 'PROPOSAL_SUBMITTED',
      userId: user.userId,
      userName: user.userName || user.userId,
      userRole: user.role,
      previousStatus: prevStatus,
      newStatus: 'PROPOSED',
      notes: `تم تقديم مقترح تصحيح (${proposal.actionType}): ${proposal.reason}`
    });

    return await InventoryCorrectionRepository.save(currentCase);
  }

  // =========================================================================
  // 4. CASE LIFECYCLE: APPROVE / REJECT (PROPOSED -> APPROVED / REJECTED)
  // Separation of duties: Employee/Manager cannot approve. Only Owner/Admin.
  // =========================================================================
  static async approveCase(
    caseId: string,
    approver: UserSecurityContext,
    notes?: string
  ): Promise<InventoryCorrectionCase> {
    if (!this.canApprove(approver.role)) {
      throw new UnauthorizedCorrectionError(`User role ${approver.role} is not authorized to approve inventory corrections. Admin/Owner authority required.`);
    }

    const currentCase = await InventoryCorrectionRepository.findById(caseId, approver.tenantId);
    if (!currentCase) {
      throw new Error(`Correction case ${caseId} not found or tenant mismatch.`);
    }

    if (currentCase.status !== 'PROPOSED') {
      throw new InvalidStateTransitionError(
        `Cannot approve case in status '${currentCase.status}'. Case must be in 'PROPOSED' state.`
      );
    }

    if (!currentCase.proposedAction) {
      throw new MandatoryFieldMissingError('Cannot approve case without an existing proposed correction action.');
    }

    const now = new Date().toISOString();
    const approval: CorrectionApproval = {
      decision: 'APPROVED',
      approvedBy: approver.userId,
      approvalRole: approver.role,
      approvedAt: now,
      approvalNotes: notes || 'تمت الموافقة الرسمية على مقترح التسوية المخزنية'
    };

    currentCase.status = 'APPROVED';
    currentCase.approval = approval;

    currentCase.auditTrail.push({
      id: `AUD-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      timestamp: now,
      action: 'CASE_APPROVED',
      userId: approver.userId,
      userName: approver.userName || approver.userId,
      userRole: approver.role,
      previousStatus: 'PROPOSED',
      newStatus: 'APPROVED',
      notes: notes || 'تم اعتماد مقترح التصحيح من صاحب الصلاحية'
    });

    return await InventoryCorrectionRepository.save(currentCase);
  }

  static async rejectCase(
    caseId: string,
    approver: UserSecurityContext,
    rejectionReason: string
  ): Promise<InventoryCorrectionCase> {
    if (!this.canApprove(approver.role) && !this.canReview(approver.role)) {
      throw new UnauthorizedCorrectionError(`User role ${approver.role} is not authorized to reject correction cases.`);
    }

    if (!rejectionReason || rejectionReason.trim().length < 5) {
      throw new MandatoryFieldMissingError('A valid rejection reason (minimum 5 characters) is required.');
    }

    const currentCase = await InventoryCorrectionRepository.findById(caseId, approver.tenantId);
    if (!currentCase) {
      throw new Error(`Correction case ${caseId} not found or tenant mismatch.`);
    }

    if (currentCase.status !== 'PROPOSED' && currentCase.status !== 'UNDER_REVIEW') {
      throw new InvalidStateTransitionError(
        `Cannot reject case in status '${currentCase.status}'. Must be in 'PROPOSED' or 'UNDER_REVIEW'.`
      );
    }

    const now = new Date().toISOString();
    const approval: CorrectionApproval = {
      decision: 'REJECTED',
      approvedBy: approver.userId,
      approvalRole: approver.role,
      approvedAt: now,
      approvalNotes: rejectionReason
    };

    const prevStatus = currentCase.status;
    currentCase.status = 'REJECTED';
    currentCase.approval = approval;

    currentCase.auditTrail.push({
      id: `AUD-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      timestamp: now,
      action: 'CASE_REJECTED',
      userId: approver.userId,
      userName: approver.userName || approver.userId,
      userRole: approver.role,
      previousStatus: prevStatus,
      newStatus: 'REJECTED',
      notes: `تم رفض مقترح التصحيح: ${rejectionReason}`
    });

    return await InventoryCorrectionRepository.save(currentCase);
  }

  // =========================================================================
  // 5. ATOMIC EXECUTION & POST-RECONCILIATION VERIFICATION
  // (APPROVED -> EXECUTED -> RECONCILED)
  // Ensures:
  // - Atomic Transaction (Rollback on failure)
  // - Idempotency
  // - Tenant/Branch Scoping
  // - Post-execution automatic reconciliation confirmation
  // =========================================================================
  static async executeCorrection(
    caseId: string,
    executor: UserSecurityContext,
    idempotencyKey?: string
  ): Promise<InventoryCorrectionCase> {
    // 1. RBAC Guard
    if (!this.canExecute(executor.role)) {
      throw new UnauthorizedCorrectionError(`User role ${executor.role} is not authorized to execute inventory corrections.`);
    }

    // 2. Fetch and Validate Case
    const currentCase = await InventoryCorrectionRepository.findById(caseId, executor.tenantId);
    if (!currentCase) {
      throw new Error(`Correction case ${caseId} not found or tenant mismatch.`);
    }

    // 3. Strict State Transition Guard: Must be APPROVED
    if (currentCase.status !== 'APPROVED') {
      throw new InvalidStateTransitionError(
        `Cannot execute case in status '${currentCase.status}'. Case MUST be explicitly 'APPROVED' by an authorized admin first.`
      );
    }

    // 4. Idempotency Guard
    const finalIdempotencyKey = idempotencyKey || `IDEMP-CORR-${caseId}`;
    if (currentCase.execution?.idempotencyKey === finalIdempotencyKey && (currentCase.status as string) === 'RECONCILED') {
      throw new DuplicateExecutionError(`Correction case ${caseId} has already been successfully executed and reconciled.`);
    }

    const proposal = currentCase.proposedAction;
    if (!proposal) {
      throw new MandatoryFieldMissingError('Missing proposed action details on approved case.');
    }

    const tenantId = currentCase.tenantId || executor.tenantId;
    const branchId = currentCase.branchId || executor.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: No valid trusted tenant context available for correction execution.');
    }
    const refId = `CORR-REF-${Date.now()}`;
    const now = new Date().toISOString();

    // 5. Capture BEFORE snapshot for comprehensive audit trail
    const beforeProduct = await db.products.get(currentCase.productId);
    const beforeStock = Number(beforeProduct?.stock ?? beforeProduct?.StockQuantity ?? 0);
    const beforeLayers = await db.inventory_layers.where('item_id').equals(currentCase.productId).toArray().catch(() => []);

    let generatedJournalEntryId: string | undefined;
    let generatedStockMovementId: string | undefined;
    let generatedInventoryTransactionId: string | undefined;

    // 6. Execute inside Atomic Transaction
    const txTables = [
      'products', 'inventoryTransactions', 'journalEntries', 
      'stock_movements', 'warehouseStock', 'inventory_layers', 
      'invoices', 'sales', 'purchases', 'inventoryCorrectionCases',
      'medicineBatches', 'Audit_Log', 'auditLogs'
    ];

    try {
      await db.safeTransaction('rw', txTables, async () => {
        // --- STEP A: Perform Specific Correction Action ---
        const engine = (await import('./UnifiedInventoryMutationEngine')).unifiedInventoryMutationEngine;

        switch (proposal.actionType) {
          case 'PHYSICAL_COUNT_ADJUSTMENT':
          case 'RESOLVE_NEGATIVE_STOCK': {
            const targetQty = Number(proposal.proposedQty);
            
            const mutationResult = await engine.executeCorrection({
              caseId: currentCase.id,
              productId: currentCase.productId,
              warehouseId: proposal.targetWarehouseId || 'WH-MAIN',
              proposedQty: targetQty,
              reason: proposal.reason,
              approverId: executor.userId,
              userId: executor.userId,
              tenantId: tenantId,
              branchId: branchId || undefined,
              transactionUuid: finalIdempotencyKey,
              notes: proposal.reason
            });

            generatedInventoryTransactionId = mutationResult.transactionId;
            break;
          }

          case 'ALIGN_LAYERS_ADJUSTMENT':
          case 'QUARANTINE_EXPIRED_BATCH':
          case 'BATCH_EXPIRY_REHABILITATION':
          case 'MANUAL_LEDGER_SYNC':
          case 'LINK_ORPHAN_DOCUMENT':
          case 'RECONCILE_UNLINKED_RETURN': {
            const targetQty = proposal.proposedQty !== undefined ? Number(proposal.proposedQty) : beforeStock;
            
            const mutationResult = await engine.executeCorrection({
              caseId: currentCase.id,
              productId: currentCase.productId,
              warehouseId: proposal.targetWarehouseId || 'WH-MAIN',
              proposedQty: targetQty,
              reason: proposal.reason,
              approverId: executor.userId,
              userId: executor.userId,
              tenantId: tenantId,
              branchId: branchId || undefined,
              transactionUuid: finalIdempotencyKey,
              notes: proposal.reason
            });

            generatedInventoryTransactionId = mutationResult.transactionId;
            break;
          }
        }

        // --- STEP B: Post-Execution Automatic Reconciliation Verification ---
        // Verify that the target discrepancy is resolved.
        const postAudit = await InventoryReconciliationService.auditProduct(
          currentCase.productId,
          { tenantId, branchId: branchId || undefined }
        );

        // Check if discrepancy of this specific type is resolved
        const remainingSpecificDisc = postAudit.discrepancies.filter(d => d.type === currentCase.discrepancyType);

        if (remainingSpecificDisc.length > 0) {
          // Discrepancy was NOT resolved! Throw error to trigger full atomic rollback.
          throw new ReconciliationVerificationFailedError(
            `Post-correction reconciliation failed! Discrepancy '${currentCase.discrepancyType}' remains unresolved with variance: ${remainingSpecificDisc[0]?.difference ?? 'unknown'}. Triggering full atomic rollback.`
          );
        }
      });
    } catch (txError: any) {
      // Transaction failed or rolled back
      console.error(`[InventoryCorrectionService] Transaction aborted and rolled back:`, txError);

      currentCase.status = 'ROLLBACK_FAILED';
      currentCase.auditTrail.push({
        id: `AUD-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
        timestamp: now,
        action: 'EXECUTION_ROLLED_BACK',
        userId: executor.userId,
        userName: executor.userName || executor.userId,
        userRole: executor.role,
        previousStatus: 'APPROVED',
        newStatus: 'ROLLBACK_FAILED',
        notes: `فشل تنفيذ وتدقيق التسوية وتم التراجع عن كافة التغييرات: ${txError.message || String(txError)}`
      });

      await InventoryCorrectionRepository.save(currentCase);
      throw txError;
    }

    // --- STEP C: Finalize Case Success Status ---
    const finalPostAudit = await InventoryReconciliationService.auditProduct(
      currentCase.productId,
      { tenantId, branchId: branchId || undefined }
    );

    currentCase.status = 'RECONCILED';
    currentCase.execution = {
      executedBy: executor.userId,
      executionRole: executor.role,
      executedAt: now,
      idempotencyKey: finalIdempotencyKey,
      refId,
      journalEntryId: generatedJournalEntryId,
      stockMovementId: generatedStockMovementId,
      inventoryTransactionId: generatedInventoryTransactionId,
      reconciliationResult: {
        isReconciled: true,
        postAuditStatus: finalPostAudit.status,
        remainingDiscrepanciesCount: finalPostAudit.discrepancies.length,
        verifiedAt: now
      }
    };

    currentCase.auditTrail.push({
      id: `AUD-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      timestamp: now,
      action: 'CORRECTION_RECONCILED',
      userId: executor.userId,
      userName: executor.userName || executor.userId,
      userRole: executor.role,
      previousStatus: 'APPROVED',
      newStatus: 'RECONCILED',
      notes: `تم تنفيذ التسوية بنجاح واجتياز فحص المطابقة الدفترية الآلية. المعرف: ${refId}`
    });

    const saved = await InventoryCorrectionRepository.save(currentCase);

    // Write system-level audit
    await AuditService.log({
      action: 'EDIT',
      module: 'INVENTORY_CORRECTION',
      transactionUuid: refId,
      before: { stock: beforeStock, layersCount: beforeLayers.length },
      after: { stock: proposal.proposedQty, status: 'RECONCILED' },
      recordId: currentCase.id
    });

    return saved;
  }
}
