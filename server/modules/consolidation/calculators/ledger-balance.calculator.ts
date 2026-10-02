// server/modules/consolidation/calculators/ledger-balance.calculator.ts
// Single Source of Truth for General Ledger Account Aggregations

import { FinancialMath } from "../financial-math.js";
import { CONSOLIDATION_DEFAULTS } from "../consolidation.constants.js";

export type LedgerAccountCategory =
  | "CASH"
  | "RECEIVABLE"
  | "INVENTORY"
  | "OTHER_CURRENT_ASSET"
  | "NON_CURRENT_ASSET"
  | "PAYABLE"
  | "OTHER_CURRENT_LIABILITY"
  | "NON_CURRENT_LIABILITY"
  | "CAPITAL"
  | "RETAINED_EARNINGS"
  | "OTHER_EQUITY"
  | "REVENUE"
  | "COGS"
  | "OPEX_SALARY"
  | "OPEX_RENT"
  | "OPEX_UTILITIES"
  | "OPEX_MARKETING"
  | "OPEX_TAX"
  | "OPEX_OTHER";

export interface AccountLedgerSummary {
  accountId: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  category: LedgerAccountCategory;
  debit: number;
  credit: number;
  netBalance: number;
  balanceType: "DEBIT" | "CREDIT";
  branchBreakdowns: {
    [branchId: string]: {
      branchName: string;
      debit: number;
      credit: number;
      netBalance: number;
    };
  };
}

export interface AggregatedLedgerState {
  accounts: AccountLedgerSummary[];
  accountMap: Map<string, AccountLedgerSummary>;

  // Balance Sheet Totals
  cashTotal: number;
  arTotal: number;
  inventoryLedgerTotal: number;
  otherCurrentAssets: number;
  nonCurrentAssets: number;
  apTotal: number;
  otherCurrentLiabilities: number;
  nonCurrentLiabilities: number;
  shareCapital: number;
  retainedEarnings: number;
  otherEquity: number;
  hasExplicitRetainedEarningsAccount: boolean;

  // Income Statement Totals
  rawRevenue: number;
  rawCOGS: number;
  salaryExpense: number;
  rentExpense: number;
  utilitiesExpense: number;
  marketingExpense: number;
  taxExpense: number;
  otherExpense: number;
  totalOPEX: number;
  rawNetIncome: number;

  // Trial Balance Invariants
  totalDebit: number;
  totalCredit: number;
  isTrialBalanceBalanced: boolean;
  trialBalanceDiscrepancy: number;

  // Branch breakdowns
  branchBreakdown: {
    [branchId: string]: {
      branchName: string;
      assets: number;
      liabilities: number;
      equity: number;
      revenue: number;
      cogs: number;
      opex: number;
      netIncome: number;
    };
  };
}

export class LedgerBalanceCalculator {
  /**
   * Classifies an account strictly based on its type, code, and standard name
   */
  public static classifyAccount(
    type: string,
    code: string,
    name: string
  ): LedgerAccountCategory {
    const normCode = (code || "").toUpperCase();
    const normName = (name || "").toLowerCase();

    if (type === "ASSET") {
      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_CASH_PREFIX) ||
        normCode === "ACC-101" ||
        normCode === "ACC-104" ||
        normName.includes("cash") ||
        normName.includes("bank") ||
        normName.includes("صندوق") ||
        normName.includes("بنك") ||
        normName.includes("نقد") ||
        normName.includes("خزينة")
      ) {
        return "CASH";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_RECEIVABLE_PREFIX) ||
        normCode === "ACC-102" ||
        normName.includes("receivable") ||
        normName.includes("customer") ||
        normName.includes("عملاء") ||
        normName.includes("مدين")
      ) {
        return "RECEIVABLE";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_INVENTORY_PREFIX) ||
        normCode === "ACC-103" ||
        normName.includes("inventory") ||
        normName.includes("stock") ||
        normName.includes("مخزون") ||
        normName.includes("بضاعة")
      ) {
        return "INVENTORY";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_OTHER_CURRENT_ASSETS_PREFIX) ||
        normCode.startsWith("13") ||
        normCode.startsWith("14")
      ) {
        return "OTHER_CURRENT_ASSET";
      }

      return "NON_CURRENT_ASSET";
    }

    if (type === "LIABILITY") {
      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_PAYABLE_PREFIX) ||
        normCode === "ACC-201" ||
        normName.includes("payable") ||
        normName.includes("supplier") ||
        normName.includes("مورد") ||
        normName.includes("دائن")
      ) {
        return "PAYABLE";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_OTHER_CURRENT_LIABILITIES_PREFIX) ||
        normCode === "ACC-202" ||
        normName.includes("vat") ||
        normName.includes("tax") ||
        normName.includes("ضريب") ||
        normName.includes("أمانات") ||
        normCode.startsWith("21") ||
        normCode.startsWith("22")
      ) {
        return "OTHER_CURRENT_LIABILITY";
      }

      return "NON_CURRENT_LIABILITY";
    }

    if (type === "EQUITY") {
      if (
        normCode === "ACC-302" ||
        normCode.startsWith("302") ||
        normName.includes("retained") ||
        normName.includes("محتجز") ||
        normName.includes("مبقاة")
      ) {
        return "RETAINED_EARNINGS";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_EQUITY_PREFIX) ||
        normCode === "ACC-301" ||
        normCode.startsWith("300") ||
        normCode.startsWith("301") ||
        normName.includes("capital") ||
        normName.includes("equity") ||
        normName.includes("رأس المال")
      ) {
        return "CAPITAL";
      }

      return "OTHER_EQUITY";
    }

    if (type === "REVENUE") {
      return "REVENUE";
    }

    if (type === "EXPENSE") {
      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_COGS_PREFIX) ||
        normCode === "ACC-501" ||
        normCode.startsWith("50") ||
        normName.includes("cogs") ||
        normName.includes("cost of goods") ||
        normName.includes("تكلفة المبيعات") ||
        normName.includes("تكلفة البضاعة")
      ) {
        return "COGS";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_OPEX_SALARY_PREFIX) ||
        normCode === "ACC-503" ||
        normName.includes("salary") ||
        normName.includes("wage") ||
        normName.includes("رواتب") ||
        normName.includes("أجور")
      ) {
        return "OPEX_SALARY";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_OPEX_RENT_PREFIX) ||
        normCode === "ACC-504" ||
        normName.includes("rent") ||
        normName.includes("إيجار")
      ) {
        return "OPEX_RENT";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_OPEX_UTILITIES_PREFIX) ||
        normName.includes("utilities") ||
        normName.includes("electricity") ||
        normName.includes("water") ||
        normName.includes("كهرباء") ||
        normName.includes("مياه") ||
        normName.includes("مرافق")
      ) {
        return "OPEX_UTILITIES";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_OPEX_MARKETING_PREFIX) ||
        normName.includes("marketing") ||
        normName.includes("advertis") ||
        normName.includes("تسويق") ||
        normName.includes("إعلان")
      ) {
        return "OPEX_MARKETING";
      }

      if (
        normCode.startsWith(CONSOLIDATION_DEFAULTS.ACCOUNTS_TAX_PREFIX) ||
        normName.includes("income tax") ||
        normName.includes("tax expense") ||
        normName.includes("ضريبة الدخل")
      ) {
        return "OPEX_TAX";
      }

      return "OPEX_OTHER";
    }

    return "OPEX_OTHER";
  }

  /**
   * Aggregates all posted journal lines into structured account summaries
   */
  public static calculateAggregatedLedger(
    journalLines: any[],
    branches: Array<{ id: string; name: string }>
  ): AggregatedLedgerState {
    const branchMap = new Map(branches.map(b => [b.id, b]));
    const accountMap = new Map<string, AccountLedgerSummary>();

    // Initialize branch breakdown structure
    const branchBreakdown: AggregatedLedgerState["branchBreakdown"] = {};
    for (const b of branches) {
      branchBreakdown[b.id] = {
        branchName: b.name,
        assets: 0,
        liabilities: 0,
        equity: 0,
        revenue: 0,
        cogs: 0,
        opex: 0,
        netIncome: 0,
      };
    }

    let totalDebit = 0;
    let totalCredit = 0;

    for (const line of journalLines) {
      const acct = line.account;
      if (!acct) continue;

      const deb = FinancialMath.safeNum(line.debit);
      const cred = FinancialMath.safeNum(line.credit);
      const bId = line.entry?.branchId || CONSOLIDATION_DEFAULTS.MAIN_BRANCH_CODE;

      if (!branchBreakdown[bId]) {
        branchBreakdown[bId] = {
          branchName: branchMap.get(bId)?.name || "External Branch",
          assets: 0,
          liabilities: 0,
          equity: 0,
          revenue: 0,
          cogs: 0,
          opex: 0,
          netIncome: 0,
        };
      }

      if (!accountMap.has(acct.id)) {
        const branchBreakdowns: AccountLedgerSummary["branchBreakdowns"] = {};
        for (const b of branches) {
          branchBreakdowns[b.id] = {
            branchName: b.name,
            debit: 0,
            credit: 0,
            netBalance: 0,
          };
        }

        const category = this.classifyAccount(acct.type, acct.code, acct.name);
        const isDebitNorm = acct.type === "ASSET" || acct.type === "EXPENSE";

        accountMap.set(acct.id, {
          accountId: acct.id,
          code: acct.code,
          name: acct.name,
          type: acct.type,
          category,
          debit: 0,
          credit: 0,
          netBalance: 0,
          balanceType: isDebitNorm ? "DEBIT" : "CREDIT",
          branchBreakdowns,
        });
      }

      const summary = accountMap.get(acct.id)!;
      summary.debit = FinancialMath.add(summary.debit, deb);
      summary.credit = FinancialMath.add(summary.credit, cred);

      if (!summary.branchBreakdowns[bId]) {
        summary.branchBreakdowns[bId] = {
          branchName: branchMap.get(bId)?.name || "External Branch",
          debit: 0,
          credit: 0,
          netBalance: 0,
        };
      }

      summary.branchBreakdowns[bId].debit = FinancialMath.add(summary.branchBreakdowns[bId].debit, deb);
      summary.branchBreakdowns[bId].credit = FinancialMath.add(summary.branchBreakdowns[bId].credit, cred);

      totalDebit = FinancialMath.add(totalDebit, deb);
      totalCredit = FinancialMath.add(totalCredit, cred);
    }

    // Compute net balances and categorize
    let cashTotal = 0;
    let arTotal = 0;
    let inventoryLedgerTotal = 0;
    let otherCurrentAssets = 0;
    let nonCurrentAssets = 0;

    let apTotal = 0;
    let otherCurrentLiabilities = 0;
    let nonCurrentLiabilities = 0;

    let shareCapital = 0;
    let retainedEarnings = 0;
    let otherEquity = 0;
    let hasExplicitRetainedEarningsAccount = false;

    let rawRevenue = 0;
    let rawCOGS = 0;
    let salaryExpense = 0;
    let rentExpense = 0;
    let utilitiesExpense = 0;
    let marketingExpense = 0;
    let taxExpense = 0;
    let otherExpense = 0;

    for (const acct of accountMap.values()) {
      const isDebitPref = acct.balanceType === "DEBIT";
      const net = isDebitPref
        ? FinancialMath.sub(acct.debit, acct.credit)
        : FinancialMath.sub(acct.credit, acct.debit);

      acct.netBalance = net;

      // Update per-branch net balances
      for (const bId of Object.keys(acct.branchBreakdowns)) {
        const br = acct.branchBreakdowns[bId];
        if (!br) continue;

        br.netBalance = isDebitPref
          ? FinancialMath.sub(br.debit, br.credit)
          : FinancialMath.sub(br.credit, br.debit);

        const brGlobal = branchBreakdown[bId];
        if (brGlobal) {
          if (acct.type === "ASSET") {
            brGlobal.assets = FinancialMath.add(brGlobal.assets, br.netBalance);
          } else if (acct.type === "LIABILITY") {
            brGlobal.liabilities = FinancialMath.add(brGlobal.liabilities, br.netBalance);
          } else if (acct.type === "EQUITY") {
            brGlobal.equity = FinancialMath.add(brGlobal.equity, br.netBalance);
          } else if (acct.type === "REVENUE") {
            brGlobal.revenue = FinancialMath.add(brGlobal.revenue, br.netBalance);
            brGlobal.netIncome = FinancialMath.add(brGlobal.netIncome, br.netBalance);
          } else if (acct.type === "EXPENSE") {
            if (acct.category === "COGS") {
              brGlobal.cogs = FinancialMath.add(brGlobal.cogs, br.netBalance);
            } else {
              brGlobal.opex = FinancialMath.add(brGlobal.opex, br.netBalance);
            }
            brGlobal.netIncome = FinancialMath.sub(brGlobal.netIncome, br.netBalance);
          }
        }
      }

      // Group totals by category
      switch (acct.category) {
        case "CASH":
          cashTotal = FinancialMath.add(cashTotal, net);
          break;
        case "RECEIVABLE":
          arTotal = FinancialMath.add(arTotal, net);
          break;
        case "INVENTORY":
          inventoryLedgerTotal = FinancialMath.add(inventoryLedgerTotal, net);
          break;
        case "OTHER_CURRENT_ASSET":
          otherCurrentAssets = FinancialMath.add(otherCurrentAssets, net);
          break;
        case "NON_CURRENT_ASSET":
          nonCurrentAssets = FinancialMath.add(nonCurrentAssets, net);
          break;

        case "PAYABLE":
          apTotal = FinancialMath.add(apTotal, net);
          break;
        case "OTHER_CURRENT_LIABILITY":
          otherCurrentLiabilities = FinancialMath.add(otherCurrentLiabilities, net);
          break;
        case "NON_CURRENT_LIABILITY":
          nonCurrentLiabilities = FinancialMath.add(nonCurrentLiabilities, net);
          break;

        case "CAPITAL":
          shareCapital = FinancialMath.add(shareCapital, net);
          break;
        case "RETAINED_EARNINGS":
          retainedEarnings = FinancialMath.add(retainedEarnings, net);
          hasExplicitRetainedEarningsAccount = true;
          break;
        case "OTHER_EQUITY":
          otherEquity = FinancialMath.add(otherEquity, net);
          break;

        case "REVENUE":
          rawRevenue = FinancialMath.add(rawRevenue, net);
          break;
        case "COGS":
          rawCOGS = FinancialMath.add(rawCOGS, net);
          break;
        case "OPEX_SALARY":
          salaryExpense = FinancialMath.add(salaryExpense, net);
          break;
        case "OPEX_RENT":
          rentExpense = FinancialMath.add(rentExpense, net);
          break;
        case "OPEX_UTILITIES":
          utilitiesExpense = FinancialMath.add(utilitiesExpense, net);
          break;
        case "OPEX_MARKETING":
          marketingExpense = FinancialMath.add(marketingExpense, net);
          break;
        case "OPEX_TAX":
          taxExpense = FinancialMath.add(taxExpense, net);
          break;
        case "OPEX_OTHER":
          otherExpense = FinancialMath.add(otherExpense, net);
          break;
      }
    }

    const totalOPEX = FinancialMath.add(salaryExpense, rentExpense, utilitiesExpense, marketingExpense, otherExpense);
    const rawNetIncome = FinancialMath.sub(
      FinancialMath.sub(rawRevenue, rawCOGS),
      FinancialMath.add(totalOPEX, taxExpense)
    );

    const isTrialBalanceBalanced = FinancialMath.isBalanced(totalDebit, totalCredit, 0.01);
    const trialBalanceDiscrepancy = FinancialMath.discrepancy(totalDebit, totalCredit);

    return {
      accounts: Array.from(accountMap.values()),
      accountMap,
      cashTotal,
      arTotal,
      inventoryLedgerTotal,
      otherCurrentAssets,
      nonCurrentAssets,
      apTotal,
      otherCurrentLiabilities,
      nonCurrentLiabilities,
      shareCapital,
      retainedEarnings,
      otherEquity,
      hasExplicitRetainedEarningsAccount,
      rawRevenue,
      rawCOGS,
      salaryExpense,
      rentExpense,
      utilitiesExpense,
      marketingExpense,
      taxExpense,
      otherExpense,
      totalOPEX,
      rawNetIncome,
      totalDebit,
      totalCredit,
      isTrialBalanceBalanced,
      trialBalanceDiscrepancy,
      branchBreakdown,
    };
  }
}
