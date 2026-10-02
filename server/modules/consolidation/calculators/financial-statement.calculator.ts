// server/modules/consolidation/calculators/financial-statement.calculator.ts
// Deterministic Financial Statements (Zero Multipliers, Zero Retrofit Plugs)

import { FinancialMath } from "../financial-math.js";
import { AggregatedLedgerState } from "./ledger-balance.calculator.js";
import {
  ConsolidatedBalanceSheet,
  ConsolidatedIncomeStatement,
  EliminationRecord,
} from "../consolidation.types.js";

export class FinancialStatementCalculator {
  /**
   * Generates a deterministic Consolidated Income Statement derived purely from General Ledger
   * and real inter-branch invoices (Zero 0.1 or 0.90 multipliers).
   */
  public static calculateIncomeStatement(
    ledgerState: AggregatedLedgerState,
    branches: Array<{ id: string; name: string }>,
    invoices: any[] = [],
    products: any[] = []
  ): ConsolidatedIncomeStatement {
    const branchIds = new Set(branches.map(b => b.id));
    const productCostMap = new Map<string, number>(
      products.map(p => [p.id, FinancialMath.safeNum(p.cost)])
    );

    // Identify actual inter-branch internal invoices between branches of the same tenant
    let eliminatedSales = 0;
    let eliminatedInternalCOGS = 0;
    const eliminations: EliminationRecord[] = [];

    for (const inv of invoices) {
      if (inv.partnerId && branchIds.has(inv.partnerId) && inv.branchId !== inv.partnerId) {
        const invTotal = FinancialMath.safeNum(inv.totalAmount);
        eliminatedSales = FinancialMath.add(eliminatedSales, invTotal);

        let invCost = 0;
        for (const item of (inv.items || [])) {
          const itemCost = item.cost != null
            ? FinancialMath.safeNum(item.cost)
            : (productCostMap.get(item.productId) || 0);
          const itemQty = Number(item.qty) || 0;
          invCost = FinancialMath.add(invCost, FinancialMath.mul(itemQty, itemCost));
        }

        eliminatedInternalCOGS = FinancialMath.add(eliminatedInternalCOGS, invCost);

        eliminations.push({
          id: `elim-inv-${inv.id}`,
          sourceId: inv.branchId || undefined,
          targetId: inv.partnerId,
          type: "INTERNAL_SALE",
          amount: invTotal,
          referenceId: inv.invoiceNumber,
          description: `استبعاد مبيعات داخلية بين الفروع - فاتورة رقم ${inv.invoiceNumber}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const consolidatedRevenue = Math.max(0, FinancialMath.sub(ledgerState.rawRevenue, eliminatedSales));
    const consolidatedCOGS = Math.max(0, FinancialMath.sub(ledgerState.rawCOGS, eliminatedInternalCOGS));
    const grossProfit = FinancialMath.sub(consolidatedRevenue, consolidatedCOGS);

    const operatingExpenses = {
      salary: ledgerState.salaryExpense,
      rent: ledgerState.rentExpense,
      utilities: ledgerState.utilitiesExpense,
      marketing: ledgerState.marketingExpense,
      other: ledgerState.otherExpense,
      totalOPEX: ledgerState.totalOPEX,
    };

    const operatingProfit = FinancialMath.sub(grossProfit, ledgerState.totalOPEX);
    const netIncome = FinancialMath.sub(operatingProfit, ledgerState.taxExpense);

    // Compute branch breakdown from real ledger branch data
    const branchBreakdown: ConsolidatedIncomeStatement["branchBreakdown"] = {};
    for (const [bId, br] of Object.entries(ledgerState.branchBreakdown)) {
      const brGross = FinancialMath.sub(br.revenue, br.cogs);
      branchBreakdown[bId] = {
        branchName: br.branchName,
        revenue: br.revenue,
        cogs: br.cogs,
        grossProfit: brGross,
        opex: br.opex,
        netIncome: br.netIncome,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      revenue: consolidatedRevenue,
      costOfGoodsSold: consolidatedCOGS,
      grossProfit,
      operatingExpenses,
      operatingProfit,
      tax: ledgerState.taxExpense,
      netIncome,
      branchBreakdown,
      eliminations,
    };
  }

  /**
   * Generates a deterministic Consolidated Balance Sheet derived purely from General Ledger
   * and physical inventory valuation (Zero 15 multipliers, Zero balancing plugs).
   */
  public static calculateBalanceSheet(
    ledgerState: AggregatedLedgerState,
    inventoryValuationTotal: number,
    _branches: Array<{ id: string; name: string }>,
    completedTransfers: any[] = [],
    products: any[] = [],
    currentPeriodNetIncome: number = 0
  ): ConsolidatedBalanceSheet {
    const productCostMap = new Map<string, number>(
      products.map(p => [p.id, FinancialMath.safeNum(p.cost)])
    );

    // Calculate real completed inter-branch transfer costs (Zero * 15 fake multiplier!)
    let actualTransferValue = 0;
    const eliminations: EliminationRecord[] = [];

    for (const t of completedTransfers) {
      let tCost = 0;
      for (const item of (t.items || [])) {
        const itemQty = Number(item.qty) || 0;
        const itemCost = productCostMap.get(item.productId) || 0;
        tCost = FinancialMath.add(tCost, FinancialMath.mul(itemQty, itemCost));
      }

      if (tCost > 0) {
        actualTransferValue = FinancialMath.add(actualTransferValue, tCost);
        eliminations.push({
          id: `elim-trans-${t.id}`,
          sourceId: t.sourceBranchId,
          targetId: t.targetBranchId,
          type: "INTERNAL_MOVEMENT",
          amount: tCost,
          referenceId: t.transferNumber || t.id,
          description: `تسوية تحويل مخزني بين الفروع رقم ${t.transferNumber || t.id.slice(0, 8)}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Eliminate internal inter-branch AR/AP balances if recorded
    let eliminatedARAP = 0;
    if (actualTransferValue > 0 && ledgerState.arTotal > 0 && ledgerState.apTotal > 0) {
      eliminatedARAP = Math.min(actualTransferValue, ledgerState.arTotal, ledgerState.apTotal);
    }

    const cashAndCashEquivalents = ledgerState.cashTotal;
    const accountsReceivable = Math.max(0, FinancialMath.sub(ledgerState.arTotal, eliminatedARAP));
    const inventoryValue = inventoryValuationTotal > 0 ? inventoryValuationTotal : ledgerState.inventoryLedgerTotal;
    const otherCurrentAssets = ledgerState.otherCurrentAssets;
    const nonCurrentAssets = ledgerState.nonCurrentAssets;

    const totalAssets = FinancialMath.add(
      cashAndCashEquivalents,
      accountsReceivable,
      inventoryValue,
      otherCurrentAssets,
      nonCurrentAssets
    );

    const accountsPayable = Math.max(0, FinancialMath.sub(ledgerState.apTotal, eliminatedARAP));
    const otherCurrentLiabilities = ledgerState.otherCurrentLiabilities;
    const nonCurrentLiabilities = ledgerState.nonCurrentLiabilities;

    const totalLiabilities = FinancialMath.add(
      accountsPayable,
      otherCurrentLiabilities,
      nonCurrentLiabilities
    );

    // EQUITY: Real ledger accounts (Zero balancing plugs!)
    const shareCapital = ledgerState.shareCapital;
    const retainedEarnings = ledgerState.retainedEarnings;
    
    // In accordance with GAAP / IFRS:
    // When books are unclosed for the current period, net income forms part of total ending equity:
    // Total Equity = Share Capital + Retained Earnings + Current Period Net Income + Other Equity
    const totalEquity = FinancialMath.add(
      shareCapital,
      retainedEarnings,
      currentPeriodNetIncome,
      ledgerState.otherEquity
    );

    // Verification of standard balance sheet equation: Assets == Liabilities + Equity
    const totalLiabilitiesAndEquity = FinancialMath.add(totalLiabilities, totalEquity);
    const isBalanced = FinancialMath.isBalanced(totalAssets, totalLiabilitiesAndEquity, 0.01);

    // Branch breakdown
    const branchBreakdown: ConsolidatedBalanceSheet["branchBreakdown"] = {};
    for (const [bId, br] of Object.entries(ledgerState.branchBreakdown)) {
      branchBreakdown[bId] = {
        branchName: br.branchName,
        assets: br.assets,
        liabilities: br.liabilities,
        equity: br.equity,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      assets: {
        cashAndCashEquivalents,
        accountsReceivable,
        inventoryValue,
        otherCurrentAssets,
        nonCurrentAssets,
        totalAssets,
      },
      liabilities: {
        accountsPayable,
        otherCurrentLiabilities,
        nonCurrentLiabilities,
        totalLiabilities,
      },
      equity: {
        shareCapital,
        retainedEarnings,
        totalEquity,
      },
      isBalanced,
      branchBreakdown,
      eliminations,
    };
  }
}
