// server/modules/consolidation/consolidation.integrity.ts
// Enterprise Financial Integrity Verification & Imbalance Observability

import { FinancialMath } from "./financial-math.js";
import { ConsolidatedBalanceSheet, ConsolidatedTrialBalance, ConsolidatedCashFlow } from "./consolidation.types.js";
import { ConsolidationLogger } from "./consolidation.logger.js";
import { ConsolidationMetrics } from "./consolidation.metrics.js";

export interface IntegrityCheckResult {
  isBalanced: boolean;
  checkType: "BALANCE_SHEET" | "TRIAL_BALANCE" | "CASH_FLOW";
  discrepancy: number;
  expectedValue: number;
  actualValue: number;
  message: string;
  diagnostics?: Record<string, any>;
}

export class ConsolidationIntegrityMonitor {
  /**
   * Verifies the fundamental accounting equation: Assets = Liabilities + Equity
   * Without modifying, plugging, or masking any numbers.
   */
  public static verifyBalanceSheet(
    balanceSheet: ConsolidatedBalanceSheet,
    tenantId: string,
    correlationId?: string
  ): IntegrityCheckResult {
    const assets = balanceSheet.assets.totalAssets;
    const liabilitiesAndEquity = FinancialMath.add(
      balanceSheet.liabilities.totalLiabilities,
      balanceSheet.equity.totalEquity
    );
    const discrepancy = FinancialMath.sub(assets, liabilitiesAndEquity);
    const isBalanced = FinancialMath.equals(assets, liabilitiesAndEquity, 0.01);

    const result: IntegrityCheckResult = {
      isBalanced,
      checkType: "BALANCE_SHEET",
      discrepancy,
      expectedValue: assets,
      actualValue: liabilitiesAndEquity,
      message: isBalanced
        ? "Consolidated Balance Sheet is in exact mathematical equilibrium."
        : `Consolidated Balance Sheet imbalance detected: Assets ($${assets.toFixed(2)}) != Liabilities + Equity ($${liabilitiesAndEquity.toFixed(2)}). Discrepancy: $${discrepancy.toFixed(2)}`,
      diagnostics: {
        totalAssets: assets,
        totalLiabilities: balanceSheet.liabilities.totalLiabilities,
        totalEquity: balanceSheet.equity.totalEquity,
        cash: balanceSheet.assets.cashAndCashEquivalents,
        ar: balanceSheet.assets.accountsReceivable,
        inventory: balanceSheet.assets.inventoryValue,
        ap: balanceSheet.liabilities.accountsPayable,
        retainedEarnings: balanceSheet.equity.retainedEarnings,
      },
    };

    if (!isBalanced) {
      ConsolidationMetrics.recordImbalance("BALANCE_SHEET", tenantId);
      ConsolidationLogger.warn(
        `[FINANCIAL INTEGRITY WARNING] Balance sheet discrepancy detected: $${discrepancy.toFixed(2)}`,
        {
          tenantId,
          correlationId,
          component: "ConsolidationIntegrityMonitor",
          context: result.diagnostics,
        }
      );
    }

    return result;
  }

  /**
   * Verifies the Trial Balance equality invariant: Sum(Debits) === Sum(Credits)
   */
  public static verifyTrialBalance(
    trialBalance: ConsolidatedTrialBalance,
    tenantId: string,
    correlationId?: string
  ): IntegrityCheckResult {
    const debits = trialBalance.totalDebit;
    const credits = trialBalance.totalCredit;
    const discrepancy = FinancialMath.sub(debits, credits);
    const isBalanced = FinancialMath.equals(debits, credits, 0.01);

    const result: IntegrityCheckResult = {
      isBalanced,
      checkType: "TRIAL_BALANCE",
      discrepancy,
      expectedValue: debits,
      actualValue: credits,
      message: isBalanced
        ? "Consolidated Trial Balance is in exact mathematical equilibrium."
        : `Consolidated Trial Balance imbalance detected: Total Debits ($${debits.toFixed(2)}) != Total Credits ($${credits.toFixed(2)}). Discrepancy: $${discrepancy.toFixed(2)}`,
      diagnostics: {
        totalDebit: debits,
        totalCredit: credits,
        rowCount: trialBalance.rows.length,
      },
    };

    if (!isBalanced) {
      ConsolidationMetrics.recordImbalance("TRIAL_BALANCE", tenantId);
      ConsolidationLogger.warn(
        `[FINANCIAL INTEGRITY WARNING] Trial balance discrepancy detected: $${discrepancy.toFixed(2)}`,
        {
          tenantId,
          correlationId,
          component: "ConsolidationIntegrityMonitor",
          context: result.diagnostics,
        }
      );
    }

    return result;
  }

  /**
   * Verifies Cash Flow Statement reconciliation with the Balance Sheet cash account.
   */
  public static verifyCashFlow(
    cashFlow: ConsolidatedCashFlow,
    balanceSheetCash: number,
    tenantId: string,
    correlationId?: string
  ): IntegrityCheckResult {
    const calculatedEnding = FinancialMath.add(cashFlow.beginningCashBalance, cashFlow.netChangeInCash);
    const cashReconcilesWithBS = FinancialMath.equals(cashFlow.endingCashBalance, balanceSheetCash, 0.01);
    const internalReconciliation = FinancialMath.equals(cashFlow.endingCashBalance, calculatedEnding, 0.01);

    const isBalanced = cashReconcilesWithBS && internalReconciliation;
    const discrepancy = FinancialMath.sub(cashFlow.endingCashBalance, balanceSheetCash);

    const result: IntegrityCheckResult = {
      isBalanced,
      checkType: "CASH_FLOW",
      discrepancy,
      expectedValue: balanceSheetCash,
      actualValue: cashFlow.endingCashBalance,
      message: isBalanced
        ? "Consolidated Cash Flow reconciles with Balance Sheet Cash."
        : `Consolidated Cash Flow discrepancy: Statement Ending Cash ($${cashFlow.endingCashBalance.toFixed(2)}) does not match Balance Sheet Cash ($${balanceSheetCash.toFixed(2)}). Discrepancy: $${discrepancy.toFixed(2)}`,
      diagnostics: {
        endingCashBalance: cashFlow.endingCashBalance,
        balanceSheetCash,
        beginningCashBalance: cashFlow.beginningCashBalance,
        netChangeInCash: cashFlow.netChangeInCash,
        netOperatingCash: cashFlow.operatingActivities.netOperatingCash,
        netInvestingCash: cashFlow.investingActivities.netInvestingCash,
        netFinancingCash: cashFlow.financingActivities.netFinancingCash,
      },
    };

    if (!isBalanced) {
      ConsolidationMetrics.recordImbalance("CASH_FLOW", tenantId);
      ConsolidationLogger.warn(
        `[FINANCIAL INTEGRITY WARNING] Cash flow reconciliation discrepancy: $${discrepancy.toFixed(2)}`,
        {
          tenantId,
          correlationId,
          component: "ConsolidationIntegrityMonitor",
          context: result.diagnostics,
        }
      );
    }

    return result;
  }
}
