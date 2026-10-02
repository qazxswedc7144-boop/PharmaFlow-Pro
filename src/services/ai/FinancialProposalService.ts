/**
 * PharmaFlow ERP - Safe Financial Advisory Pipeline & Unposted Proposal Service
 * 
 * CORE ARCHITECTURAL INVARIANT:
 * AI CANNOT POST TO THE LEDGER DIRECTLY.
 * 
 * Flow:
 * AI Analysis
 *   ↓
 * Financial Recommendation
 *   ↓
 * Unposted Proposal (Draft only, no ledger effect, no balance change, no inventory change)
 *   ↓
 * Validation (tenantId, auth, account validity, Debit = Credit, FinancialMath, positive numbers)
 *   ↓
 * Human Review (Accountant / Admin explicit approval)
 *   ↓
 * Existing PostingEngine / JournalPostingWorkflow
 *   ↓
 * FinancialMath & Double-Entry Ledger
 *   ↓
 * Audit Trail
 */

import { FinancialMath } from '@/core/financial-math';
import { AIUserContext } from './types';
import { JournalPostingWorkflow } from '@/features/accounting/workflows/JournalPostingWorkflow';
import { WorkflowContextFactory } from '@/core/workflow/workflowContext';

export type ProposalType = 'JOURNAL_ENTRY' | 'ADJUSTMENT' | 'CORRECTION' | 'RECLASSIFICATION';
export type ProposalStatus = 'DRAFT_PENDING_REVIEW' | 'REJECTED' | 'APPROVED' | 'POSTED';

export interface ProposedJournalLine {
  lineId: string;
  accountId: string;
  accountCode?: string;
  accountName?: string;
  debit: number;
  credit: number;
  memo?: string;
}

export interface ProposalValidationResult {
  isValid: boolean;
  errors: string[];
  validatedAt: string;
  totalDebit: number;
  totalCredit: number;
  discrepancy: number;
}

export interface UnpostedFinancialProposal {
  id: string;
  tenantId: string;
  branchId: string;
  correlationId: string;
  proposalType: ProposalType;
  title: string;
  description: string;
  reasoning: string;
  proposedDate: string;
  lines: ProposedJournalLine[];
  status: ProposalStatus;
  validation: ProposalValidationResult;
  sourceData?: {
    anomalyType?: string;
    sourceDocumentId?: string;
    originalAmount?: number;
    suggestedAdjustment?: number;
  };
  humanReview?: {
    reviewedBy?: string;
    reviewerRole?: string;
    reviewedAt?: string;
    decision?: 'APPROVED' | 'REJECTED';
    notes?: string;
  };
  postedJournalId?: string;
  createdAt: string;
  updatedAt: string;
}

export class FinancialProposalService {
  // In-memory isolated store for unposted proposals (per tenant)
  private static proposals: Map<string, UnpostedFinancialProposal> = new Map();

  /**
   * Creates an unposted proposal draft from an AI recommendation.
   * STRICT GUARANTEE: Does NOT write to ledger, does NOT affect accounts or inventory.
   */
  public static async createProposalFromAI(
    creatorContext: AIUserContext,
    params: {
      proposalType: ProposalType;
      title: string;
      description: string;
      reasoning: string;
      proposedDate?: string;
      lines: Array<{
        accountId: string;
        accountCode?: string;
        accountName?: string;
        debit: number;
        credit: number;
        memo?: string;
      }>;
      sourceData?: UnpostedFinancialProposal['sourceData'];
      correlationId?: string;
    }
  ): Promise<UnpostedFinancialProposal> {
    const correlationId = params.correlationId || `corr_ai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const proposalId = `prop_ai_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const proposedDate = params.proposedDate || new Date().toISOString().substring(0, 10);

    const mappedLines: ProposedJournalLine[] = params.lines.map((l, idx) => ({
      lineId: `${proposalId}_line_${idx + 1}`,
      accountId: l.accountId,
      accountCode: l.accountCode || l.accountId,
      accountName: l.accountName || '',
      debit: FinancialMath.round2(l.debit || 0),
      credit: FinancialMath.round2(l.credit || 0),
      memo: l.memo || params.description,
    }));

    // Perform initial validation
    const validation = await this.validateProposalData({
      tenantId: creatorContext.tenantId,
      userRole: creatorContext.userRole,
      correlationId,
      lines: mappedLines,
    });

    const proposal: UnpostedFinancialProposal = {
      id: proposalId,
      tenantId: creatorContext.tenantId,
      branchId: creatorContext.branchId || 'MAIN_BRANCH',
      correlationId,
      proposalType: params.proposalType,
      title: params.title,
      description: params.description,
      reasoning: params.reasoning,
      proposedDate,
      lines: mappedLines,
      status: validation.isValid ? 'DRAFT_PENDING_REVIEW' : 'REJECTED',
      validation,
      sourceData: params.sourceData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Validates all financial, authorization, and double-entry invariants of a proposal.
   */
  public static async validateProposalData(params: {
    tenantId: string;
    userRole: string;
    correlationId: string;
    lines: ProposedJournalLine[];
    expectedTenantId?: string;
  }): Promise<ProposalValidationResult> {
    const errors: string[] = [];
    const validatedAt = new Date().toISOString();

    // 1. Tenant Verification
    if (!params.tenantId || typeof params.tenantId !== 'string') {
      errors.push('معرف المنشأة (tenantId) مفقود أو غير صالح.');
    } else if (params.expectedTenantId && params.tenantId !== params.expectedTenantId) {
      errors.push('تعارض أمني: عدم تطابق معرف المنشأة (TENANT_MISMATCH).');
    }

    // 2. Correlation ID Check
    if (!params.correlationId) {
      errors.push('معرف التتبع والترابط (correlationId) إلزامي للتدقيق المالي.');
    }

    // 3. User Role Authorization Check
    const authorizedRoles = ['admin', 'accountant', 'manager'];
    if (!authorizedRoles.includes(params.userRole)) {
      errors.push('المستخدم غير مصرح له بإنشاء أو مراجعة توصيات محاسبية.');
    }

    // 4. Lines presence and minimum requirement (at least 2 sides)
    if (!params.lines || params.lines.length < 2) {
      errors.push('القيد المحاسبي المقترح يجب أن يتضمن طرفين على الأقل (طرف مدين وطرف دائن).');
    }

    let totalDebit = 0;
    let totalCredit = 0;

    // 5. Lines Inspection: valid accounts, non-negative values, at least one positive
    for (const [idx, line] of (params.lines || []).entries()) {
      if (!line.accountId || line.accountId.trim() === '') {
        errors.push(`السطر رقم ${idx + 1}: يجب تحديد حساب محاسبي صالح.`);
      }

      if (line.debit < 0 || line.credit < 0) {
        errors.push(`السطر رقم ${idx + 1}: المبالغ المالية يجب أن تكون أرقاماً موجبة (لا يُقبل المدين أو الدائن السالب).`);
      }

      if (line.debit === 0 && line.credit === 0) {
        errors.push(`السطر رقم ${idx + 1}: يجب أن يحتوي السطر على قيمة في المدين أو الدائن.`);
      }

      if (line.debit > 0 && line.credit > 0) {
        errors.push(`السطر رقم ${idx + 1}: لا يمكن أن يكون السطر الواحد مديناً ودائناً في نفس الوقت.`);
      }

      totalDebit = FinancialMath.add(totalDebit, line.debit);
      totalCredit = FinancialMath.add(totalCredit, line.credit);
    }

    // 6. Double-Entry Balance: Debit = Credit
    const isBalanced = FinancialMath.isBalanced(totalDebit, totalCredit, 0.001);
    const discrepancy = FinancialMath.discrepancy(totalDebit, totalCredit);

    if (!isBalanced) {
      errors.push(
        `القيد المقترح غير متزن محاسبياً وغير متزنة أطرافه! مجموع المدين (${totalDebit.toFixed(2)}) لا يساوي مجموع الدائن (${totalCredit.toFixed(2)}). الفارق: ${discrepancy.toFixed(2)}.`
      );
    }

    if (totalDebit <= 0 || totalCredit <= 0) {
      errors.push('إجمالي قيمة القيد يجب أن يكون أكبر من الصفر.');
    }

    return {
      isValid: errors.length === 0,
      errors,
      validatedAt,
      totalDebit,
      totalCredit,
      discrepancy,
    };
  }

  /**
   * Human Review & Posting Gate.
   * Strictly requires human authorization before invoking PostingEngine / JournalPostingWorkflow.
   */
  public static async approveAndPostProposal(
    proposalId: string,
    reviewerContext: AIUserContext,
    reviewDecision: 'APPROVED' | 'REJECTED',
    reviewNotes?: string
  ): Promise<{ success: boolean; proposal: UnpostedFinancialProposal; journalId?: string; error?: string }> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return {
        success: false,
        proposal: null as any,
        error: `المقترح المحاسبي غير موجود: ${proposalId}`,
      };
    }

    // Tenant Isolation Check
    if (reviewerContext.tenantId !== proposal.tenantId) {
      return {
        success: false,
        proposal,
        error: 'رفض أمني: معرف المنشأة للمراجع لا يطابق المنشأة المالكة للمقترح (TENANT_MISMATCH).',
      };
    }

    // Role Verification for Approver
    if (!['admin', 'accountant'].includes(reviewerContext.userRole)) {
      return {
        success: false,
        proposal,
        error: 'المستخدم غير مفوض بالموافقة على القيود المحاسبية وترحيلها (مطلوب محاسب أو مدير نظام).',
      };
    }

    // If human reviewer rejects
    if (reviewDecision === 'REJECTED') {
      proposal.status = 'REJECTED';
      proposal.humanReview = {
        reviewedBy: reviewerContext.userId,
        reviewerRole: reviewerContext.userRole,
        reviewedAt: new Date().toISOString(),
        decision: 'REJECTED',
        notes: reviewNotes || 'تم رفض المقترح من قبل المراجع البشري.',
      };
      proposal.updatedAt = new Date().toISOString();
      this.proposals.set(proposal.id, proposal);
      return { success: true, proposal };
    }

    // Re-verify validation before posting to PostingEngine
    const validationCheck = await this.validateProposalData({
      tenantId: reviewerContext.tenantId,
      userRole: reviewerContext.userRole,
      correlationId: proposal.correlationId,
      lines: proposal.lines,
      expectedTenantId: proposal.tenantId,
    });

    if (!validationCheck.isValid) {
      proposal.status = 'REJECTED';
      proposal.validation = validationCheck;
      proposal.updatedAt = new Date().toISOString();
      this.proposals.set(proposal.id, proposal);
      return {
        success: false,
        proposal,
        error: `فشل التحقق المحاسبي قبل الترحيل: ${validationCheck.errors.join(' | ')}`,
      };
    }

    // Approved by Human -> Delegate to Existing JournalPostingWorkflow / PostingEngine
    try {
      const workflow = new JournalPostingWorkflow();
      const postingResult = await workflow.executeDomainSteps(
        {
          date: proposal.proposedDate,
          description: `[ترحيل معتمد من توصية AI] ${proposal.title} - ${proposal.description}`,
          reference: proposal.correlationId,
          lines: proposal.lines.map((l) => ({
            accountId: l.accountId,
            accountCode: l.accountCode,
            accountName: l.accountName,
            debit: l.debit,
            credit: l.credit,
            memo: l.memo,
          })),
        },
        WorkflowContextFactory.create('JOURNAL_POSTING', {
          workflowId: workflow.id,
          idempotencyKey: proposal.correlationId,
          userId: reviewerContext.userId,
          tenantId: reviewerContext.tenantId,
          branchId: reviewerContext.branchId,
          correlationId: proposal.correlationId,
        })
      );

      proposal.status = 'POSTED';
      proposal.postedJournalId = postingResult.journalId;
      proposal.humanReview = {
        reviewedBy: reviewerContext.userId,
        reviewerRole: reviewerContext.userRole,
        reviewedAt: new Date().toISOString(),
        decision: 'APPROVED',
        notes: reviewNotes || 'تمت المراجعة والاعتماد والموافقة على الترحيل.',
      };
      proposal.updatedAt = new Date().toISOString();
      this.proposals.set(proposal.id, proposal);

      return {
        success: true,
        proposal,
        journalId: postingResult.journalId,
      };
    } catch (err: any) {
      return {
        success: false,
        proposal,
        error: `فشل ترحيل القيد عبر المحرك المحاسبي: ${err.message}`,
      };
    }
  }

  /**
   * High-level review and decision wrapper for proposals. Throws descriptive errors
   * on security violations or attempts to approve invalid/unbalanced proposals.
   */
  public static async reviewProposal(
    proposalId: string,
    reviewerContext: AIUserContext,
    decision: 'APPROVED' | 'REJECTED',
    notes?: string
  ): Promise<UnpostedFinancialProposal> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`المقترح المحاسبي غير موجود: ${proposalId}`);
    }

    if (reviewerContext.tenantId !== proposal.tenantId) {
      throw new Error('المستخدم لا يملك صلاحية المراجعة لحساب منشأة مختلفة (TENANT_MISMATCH)');
    }

    if (decision === 'APPROVED') {
      if (!proposal.validation.isValid || proposal.status === 'REJECTED') {
        throw new Error('لا يمكن اعتماد مقترح غير صالح أو غير متزن محاسبياً.');
      }
    }

    const res = await this.approveAndPostProposal(proposalId, reviewerContext, decision, notes);
    if (!res.success) {
      throw new Error(res.error || 'فشلت عملية مراجعة واعتماد المقترح.');
    }

    return res.proposal;
  }

  /**
   * Retrieves an unposted proposal by ID with strict tenant isolation.
   */
  public static getProposalById(proposalId: string, tenantId: string): UnpostedFinancialProposal | null {
    const prop = this.proposals.get(proposalId);
    if (!prop || prop.tenantId !== tenantId) {
      return null;
    }
    return prop;
  }

  /**
   * Lists unposted proposals for a specific tenant.
   */
  public static listProposals(tenantId: string, status?: ProposalStatus): UnpostedFinancialProposal[] {
    const list: UnpostedFinancialProposal[] = [];
    for (const prop of this.proposals.values()) {
      if (prop.tenantId === tenantId) {
        if (!status || prop.status === status) {
          list.push(prop);
        }
      }
    }
    return list;
  }

  /**
   * Clears the in-memory proposal map (used exclusively for isolated automated testing).
   */
  public static _clearForTesting(): void {
    this.proposals.clear();
  }
}
