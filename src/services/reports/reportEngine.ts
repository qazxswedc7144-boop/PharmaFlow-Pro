import { db } from '@/core/db';
import { WorkerClient } from '@features/workers/worker.client';
import { reportCache } from '@features/reports/services/reportCacheService';
import { Sale, Purchase, Product, Customer, Supplier, JournalEntry, JournalLine } from '@/types';

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  endingDebit: number;
  endingCredit: number;
}

export class ReportEngine {
  
  /**
   * Refreshes the local report cache or triggers re-aggregation (transitional compatibility)
   */
  static async refresh(): Promise<void> {
    console.log("[ReportEngine] Clearing and re-aggregating reports data...");
    reportCache.purge();
  }

  /**
   * Instance method wrapper for refresh to support instance-level calls robustly
   */
  async refresh(): Promise<void> {
    await ReportEngine.refresh();
  }
  
  /**
   * Retrieves and aggregates standard sales summary.
   */
  static async getSalesSummary(start: string, end: string) {
    const sales = await db.invoices
      .where('type')
      .equals('SALE')
      .filter((s: Sale) => (s.date || s.Date || '') >= start && (s.date || s.Date || '') <= end)
      .toArray() as Sale[];
    
    return {
      count: sales.length,
      total: sales.reduce((acc: number, s: Sale) => acc + (s.finalTotal || 0), 0)
    };
  }

  /**
   * Generates a GAAP-compliant Trial Balance (ميزان المراجعة).
   * Aggregates debits, credits, and calculates ending balances per account within date filters.
   */
  static async getTrialBalance(start?: string, end?: string): Promise<TrialBalanceRow[]> {
    const cacheKey = `trial-balance-${start || 'all'}-${end || 'all'}`;
    const cached = reportCache.get<TrialBalanceRow[]>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Trial Balance for key ${cacheKey}`);
      return cached;
    }

    const accounts = await db.accounts.toArray();
    const entries = await db.journalEntries.toArray();

    const result = await WorkerClient.runTrialBalance(accounts, entries, start, end);
    reportCache.set(cacheKey, result);
    return result as TrialBalanceRow[];
  }

  /**
   * Generates Profit & Loss Statement (قائمة الأرباح والخسائر).
   */
  static async getProfitLoss(start?: string, end?: string) {
    const cacheKey = `profit-loss-${start || 'all'}-${end || 'all'}`;
    const cached = reportCache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Profit & Loss for key ${cacheKey}`);
      return cached;
    }

    const trialBalance = await this.getTrialBalance(start, end);
    
    // Revenue Accounts (Standard ACC-401 for SALES_REVENUE)
    const revenues = trialBalance.filter((item: TrialBalanceRow) => item.type === 'REVENUE');
    const totalRevenue = revenues.reduce((acc: number, r: TrialBalanceRow) => acc + (r.endingCredit - r.endingDebit), 0);
    
    // COGS Accounts (Standard ACC-501 for COGS)
    const cogsItems = trialBalance.filter((item: TrialBalanceRow) => item.code === 'ACC-501' || item.id === 'ACC-501' || item.name.includes('تكلفة المبيعات') || (item.type === 'EXPENSE' && item.code === 'ACC-501'));
    const totalCogs = cogsItems.reduce((acc: number, c: TrialBalanceRow) => acc + (c.endingDebit - c.endingCredit), 0);

    // General Expense Accounts (EXPENSE excluding COGS)
    const operatingExpenses = trialBalance.filter((item: TrialBalanceRow) => item.type === 'EXPENSE' && item.code !== 'ACC-501' && item.id !== 'ACC-501' && !item.name.includes('تكلفة المبيعات'));
    const totalExpenses = operatingExpenses.reduce((acc: number, e: TrialBalanceRow) => acc + (e.endingDebit - e.endingCredit), 0);

    const grossProfit = totalRevenue - totalCogs;
    const netProfit = grossProfit - totalExpenses;
    const margin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    const result = {
      revenue: totalRevenue,
      cogs: totalCogs,
      grossProfit,
      expenses: totalExpenses,
      netProfit,
      margin,
      revenueDetails: revenues.map((r: TrialBalanceRow) => ({ id: r.id, name: r.name, code: r.code, amount: r.endingCredit - r.endingDebit })),
      expenseDetails: operatingExpenses.map((e: TrialBalanceRow) => ({ id: e.id, name: e.name, code: e.code, amount: e.endingDebit - e.endingCredit }))
    };
    reportCache.set(cacheKey, result);
    return result;
  }

  /**
   * Generates Balance Sheet (الميزانية العمومية).
   * Generates cumulative snapshot up to the specified date.
   */
  static async getBalanceSheet(asOfDate?: string) {
    const cacheKey = `balance-sheet-${asOfDate || 'all'}`;
    const cached = reportCache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Balance Sheet for key ${cacheKey}`);
      return cached;
    }

    // Balance Sheet accounts compile cumulatively from inception up to the selected date.
    const trialBalance = await this.getTrialBalance(undefined, asOfDate);
    
    const assetsList = trialBalance.filter((item: TrialBalanceRow) => item.type === 'ASSET');
    const liabilitiesList = trialBalance.filter((item: TrialBalanceRow) => item.type === 'LIABILITY');
    const equityList = trialBalance.filter((item: TrialBalanceRow) => item.type === 'EQUITY');

    // Retained Earnings (Net Profit accumulated from inception up to the asOfDate)
    const plStatement = await this.getProfitLoss(undefined, asOfDate);
    const retainedEarnings = Number(plStatement.netProfit || 0);

    const totalAssets = assetsList.reduce((acc: number, r: TrialBalanceRow) => acc + (r.endingDebit - r.endingCredit), 0);
    const totalLiabilities = liabilitiesList.reduce((acc: number, r: TrialBalanceRow) => acc + (r.endingCredit - r.endingDebit), 0);
    const totalEquityRaw = equityList.reduce((acc: number, r: TrialBalanceRow) => acc + (r.endingCredit - r.endingDebit), 0);
    const totalEquity = totalEquityRaw + retainedEarnings;

    const result = {
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      assets: assetsList.map((a: TrialBalanceRow) => ({ id: a.id, name: a.name, code: a.code, amount: a.endingDebit - a.endingCredit })),
      liabilities: liabilitiesList.map((l: TrialBalanceRow) => ({ id: l.id, name: l.name, code: l.code, amount: l.endingCredit - l.endingDebit })),
      equity: [
        ...equityList.map((e: TrialBalanceRow) => ({ id: e.id, name: e.name, code: e.code, amount: e.endingCredit - e.endingDebit })),
        { id: 'RETAINED_EARNINGS', name: 'الأرباح المحتجزة للفترة', code: 'ACC-399', amount: retainedEarnings }
      ],
      totalAssets,
      totalLiabilities,
      totalEquity,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
    };
    reportCache.set(cacheKey, result);
    return result;
  }

  /**
   * Calculates comprehensive inventory valuation matching FIFO & Weighted Average methods.
   */
  static async getInventoryValue() {
    const cacheKey = 'inventory-valuation-summary';
    const cached = reportCache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Inventory Valuation for key ${cacheKey}`);
      return cached;
    }

    const products = await db.getProducts();
    let totalQuantity = 0;
    let totalCostValue = 0;
    let totalSalesValue = 0;

    const items = (products as Product[]).map((p: Product) => {
      const qty = Number(p.stock ?? p.StockQuantity ?? 0);
      const cost = Number(p.CostPrice ?? p.LastPurchasePrice ?? 0);
      const sellPrice = Number(p.price ?? 0);
      const costValue = qty * cost;
      const salesValue = qty * sellPrice;
      const profitPotential = salesValue - costValue;

      totalQuantity += qty;
      totalCostValue += costValue;
      totalSalesValue += salesValue;

      return {
        id: p.id,
        name: p.name,
        code: p.barcode || 'N/A',
        category: p.categoryName || 'عام',
        quantity: qty,
        unitCost: cost,
        unitSell: sellPrice,
        costValue,
        salesValue,
        profitPotential
      };
    });

    const result = {
      totalQuantity,
      totalCostValue, // This is the inventory value on the Assets sheet
      totalSalesValue,
      totalProfitPotential: totalSalesValue - totalCostValue,
      items
    };
    reportCache.set(cacheKey, result);
    return result;
  }

  /**
   * Cash Flow Statement (قائمة التدفقات النقدية).
   * Direct method scanning General Ledger CASH and BANK lines.
   */
  static async getCashFlow(start?: string, end?: string) {
    const cacheKey = `cash-flow-${start || 'all'}-${end || 'all'}`;
    const cached = reportCache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Cash Flow for key ${cacheKey}`);
      return cached;
    }

    const entries = await db.journalEntries.toArray();

    const cashBankAccounts = ['ACC-101', 'ACC-104']; // CASH, BANK

    // Starting Cash Balance (Closing balances before start date)
    let startingBalance = 0;
    if (start) {
      const priorEntries = entries.filter((e: JournalEntry) => e.status === 'Posted' && (e.date || '') < start);
      for (const e of priorEntries) {
        if (!e.lines) continue;
        for (const l of e.lines) {
          if (cashBankAccounts.includes(l.accountId)) {
            startingBalance += (Number(l.debit || 0) - Number(l.credit || 0));
          }
        }
      }
    }

    // Filter range for movements
    const rangeEntries = entries.filter((e: JournalEntry) => {
      if (e.status !== 'Posted') return false;
      const entryDate = e.date || '';
      if (start && entryDate < start) return false;
      if (end && entryDate > end) return false;
      return true;
    });

    let collectionsFromCustomers = 0;
    let paymentsToSuppliers = 0;
    let operatingExpensesPaid = 0;
    let otherInflows = 0;
    let otherOutflows = 0;

    const flows: { date: string; description: string; type: 'INFLOW' | 'OUTFLOW'; amount: number; source: string }[] = [];

    for (const e of rangeEntries) {
      if (!e.lines) continue;
      // Check if entry has cash flow effect
      const cashLines = e.lines.filter((l: JournalLine) => cashBankAccounts.includes(l.accountId));
      if (cashLines.length === 0) continue;

      const netDelta = cashLines.reduce((sum: number, cl: JournalLine) => sum + (Number(cl.debit || 0) - Number(cl.credit || 0)), 0);
      if (netDelta === 0) continue;

      const category = e.sourceType || 'GENERAL';
      const absAmount = Math.abs(netDelta);

      if (netDelta > 0) {
        flows.push({
          date: e.date || '',
          description: e.description || 'حركة نقدية واردة',
          type: 'INFLOW',
          amount: absAmount,
          source: category
        });

        if (category === 'SALE' || category === 'RECEIPT') {
          collectionsFromCustomers += absAmount;
        } else {
          otherInflows += absAmount;
        }
      } else {
        flows.push({
          date: e.date || '',
          description: e.description || 'حركة نقدية صادرة',
          type: 'OUTFLOW',
          amount: absAmount,
          source: category
        });

        if (category === 'PURCHASE' || category === 'PAYMENT') {
          paymentsToSuppliers += absAmount;
        } else if (category === 'EXPENSE') {
          operatingExpensesPaid += absAmount;
        } else {
          otherOutflows += absAmount;
        }
      }
    }

    const netChange = collectionsFromCustomers + otherInflows - (paymentsToSuppliers + operatingExpensesPaid + otherOutflows);
    const endingBalance = startingBalance + netChange;

    const result = {
      startingBalance,
      collectionsFromCustomers,
      paymentsToSuppliers,
      operatingExpensesPaid,
      otherInflows,
      otherOutflows,
      netChange,
      endingBalance,
      flows
    };
    reportCache.set(cacheKey, result);
    return result;
  }

  /**
   * Customer Receivable Balances (أرصدة وذمم العملاء).
   */
  static async getCustomerBalances() {
    const cacheKey = 'customer-balances-summary';
    const cached = reportCache.get<unknown[]>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Customer Balances for key ${cacheKey}`);
      return cached;
    }

    const customers = await db.getCustomers();
    const invoices = await db.invoices.where('type').equals('SALE').toArray() as Sale[];
    
    // receipts are stored in vouchers or cash movements
    const receipts = await db.receipts.toArray();
    const vouchers = await db.vouchers.filter((v: { type?: string }) => v.type === 'RECEIPT').toArray();

    const customerDetails = (customers as Customer[]).map((cust: Customer) => {
      const custId = cust.id || cust.Customer_ID || cust.Partner_ID || '';
      const custName = cust.name || cust.Supplier_Name || cust.Customer_Name || 'عميل مجهول';

      // Total sales
      const custInvoices = invoices.filter((inv: Sale) => (inv.customerId || inv.customer_id) === custId);
      const totalSales = custInvoices.reduce((sum: number, inv: Sale) => sum + Number(inv.finalTotal || 0), 0);

      // Total receipts
      const directReceipts = receipts.filter((r: { customerId?: string; customer_id?: string; amount?: number; Paid_Amount?: number }) => r.customerId === custId || r.customer_id === custId).reduce((sum: number, r: { amount?: number; Paid_Amount?: number }) => sum + Number(r.amount || r.Paid_Amount || 0), 0);
      const voucherReceipts = vouchers.filter((v: { customer_id?: string; customerId?: string; amount?: number }) => v.customer_id === custId || v.customerId === custId).reduce((sum: number, v: { amount?: number }) => sum + Number(v.amount || 0), 0);
      const totalPaid = directReceipts + voucherReceipts;

      const outstandingBalance = totalSales - totalPaid;

      return {
        id: custId,
        name: custName,
        phone: cust.Phone || 'N/A',
        totalSales,
        totalPaid,
        balance: outstandingBalance,
        riskLevel: outstandingBalance > 5000 ? 'HIGH' : (outstandingBalance > 1000 ? 'MEDIUM' : 'NORMAL')
      };
    });

    reportCache.set(cacheKey, customerDetails);
    return customerDetails;
  }

  /**
   * Supplier Accounts Payable Balances (أرصدة وذمم الموردين).
   */
  static async getSupplierBalances() {
    const cacheKey = 'supplier-balances-summary';
    const cached = reportCache.get<unknown[]>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Supplier Balances for key ${cacheKey}`);
      return cached;
    }

    const suppliers = await db.getSuppliers();
    const purchases = await db.invoices.where('type').equals('PURCHASE').toArray() as Purchase[];
    
    // payments tables
    const payments = await db.payments.toArray();
    const vouchers = await db.vouchers.filter((v: { type?: string }) => v.type === 'PAYMENT').toArray();

    const result = (suppliers as Supplier[]).map((sup: Supplier) => {
      const supId = sup.id || sup.Supplier_ID || sup.Partner_ID || '';
      const supName = sup.name || sup.Supplier_Name || 'مورد مجهول';

      const supPurchases = purchases.filter(p => (p.supplierId || p.supplier_id) === supId);
      const totalPurchases = supPurchases.reduce((sum: number, p: Purchase) => sum + Number(p.totalAmount || p.finalTotal || 0), 0);

      const directPayments = payments.filter((p: { supplierId?: string; supplier_id?: string; amount?: number; Paid_Amount?: number }) => p.supplierId === supId || p.supplier_id === supId).reduce((sum: number, p: { amount?: number; Paid_Amount?: number }) => sum + Number(p.amount || p.Paid_Amount || 0), 0);
      const voucherPayments = vouchers.filter((v: { supplier_id?: string; supplierId?: string; amount?: number }) => v.supplier_id === supId || v.supplierId === supId).reduce((sum: number, v: { amount?: number }) => sum + Number(v.amount || 0), 0);
      const totalPaid = directPayments + voucherPayments;

      const outstandingBalance = totalPurchases - totalPaid;

      return {
        id: supId,
        name: supName,
        phone: sup.Phone || 'N/A',
        totalPurchases,
        totalPaid,
        balance: outstandingBalance
      };
    });

    reportCache.set(cacheKey, result);
    return result;
  }

  /**
   * Unified Debt Aging Report (تقرير تعمير الديون - عملاء وموردين).
   */
  static async getAgingReport(type: 'CUSTOMER' | 'SUPPLIER' = 'CUSTOMER') {
    const cacheKey = `aging-report-${type}`;
    const cached = reportCache.get<unknown[]>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Aging Report for key ${cacheKey}`);
      return cached;
    }

    const today = new Date();
    
    if (type === 'CUSTOMER') {
      const invoices = await db.invoices.where('type').equals('SALE').toArray() as Sale[];
      const customers = await db.getCustomers();

      const result = invoices
        .filter(inv => {
          const mainTotal = Number(inv.finalTotal || 0);
          const paid = Number(inv.paidAmount || 0);
          return mainTotal - paid > 0.01;
        })
        .map(inv => {
          const unpaid = Number(inv.finalTotal || 0) - Number(inv.paidAmount || 0);
          const invDate = new Date(inv.date || inv.Date || '');
          const diffMs = today.getTime() - invDate.getTime();
          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const customer = (customers as Customer[]).find(c => c.id === inv.customerId || c.id === inv.customer_id) || { name: 'عميل غير معرف' };

          return {
            id: inv.id,
            partnerId: inv.customerId || inv.customer_id,
            partnerName: customer.name || (customer as Customer).Customer_Name || 'عميل غير معرف',
            docId: inv.SaleID || inv.id,
            date: inv.date || inv.Date || '',
            days: diffDays,
            amount: unpaid,
            bucket1: diffDays <= 30 ? unpaid : 0,    // 0-30 days
            bucket2: diffDays > 30 && diffDays <= 60 ? unpaid : 0,  // 31-60 days
            bucket3: diffDays > 60 && diffDays <= 90 ? unpaid : 0,  // 61-90 days
            bucket4: diffDays > 90 ? unpaid : 0     // 90+ days
          };
        });

      reportCache.set(cacheKey, result);
      return result;
    } else {
      const purchases = await db.invoices.where('type').equals('PURCHASE').toArray() as Purchase[];
      const suppliers = await db.getSuppliers();

      const result = purchases
        .filter(p => {
          const mainTotal = Number(p.totalAmount || p.finalTotal || 0);
          const paid = Number(p.paidAmount || 0);
          return mainTotal - paid > 0.01;
        })
        .map(inv => {
          const unpaid = Number(inv.totalAmount || inv.finalTotal || 0) - Number(inv.paidAmount || 0);
          const invDate = new Date(inv.date || new Date().toISOString());
          const diffMs = today.getTime() - invDate.getTime();
          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const supplier = (suppliers as Supplier[]).find(s => s.id === inv.supplierId || s.id === inv.supplier_id) || { name: 'مورد غير معرف' };

          return {
            id: inv.id,
            partnerId: inv.supplierId || inv.supplier_id,
            partnerName: supplier.name || (supplier as Supplier).Supplier_Name || 'مورد غير معرف',
            docId: inv.invoiceId || inv.id,
            date: inv.date,
            days: diffDays,
            amount: unpaid,
            bucket1: diffDays <= 30 ? unpaid : 0,
            bucket2: diffDays > 30 && diffDays <= 60 ? unpaid : 0,
            bucket3: diffDays > 60 && diffDays <= 90 ? unpaid : 0,
            bucket4: diffDays > 90 ? unpaid : 0
          };
        });

      reportCache.set(cacheKey, result);
      return result;
    }
  }

  /**
   * VAT Net Tax reports (التقارير الضريبية وضريبة القيمة المضافة).
   */
  static async getTaxReport(start?: string, end?: string) {
    const cacheKey = `tax-report-${start || 'all'}-${end || 'all'}`;
    const cached = reportCache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      console.log(`[ReportEngine] Returning cached Tax Report for key ${cacheKey}`);
      return cached;
    }

    const sales = await db.invoices.where('type').equals('SALE').toArray() as Sale[];
    const purchases = await db.invoices.where('type').equals('PURCHASE').toArray() as Purchase[];

    const rangeSales = sales.filter(s => {
      const d = s.date || s.Date || '';
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });

    const rangePurchases = purchases.filter(p => {
      const d = p.date || '';
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });

    const outputVat = rangeSales.reduce((sum: number, s: Sale) => sum + Number(s.tax ?? 0), 0);
    const inputVat = rangePurchases.reduce((sum: number, p: Purchase) => sum + Number(p.tax ?? 0), 0);

    const totalSalesTaxable = rangeSales.reduce((sum: number, s: Sale) => sum + Number(s.subtotal || 0), 0);
    const totalPurchasesTaxable = rangePurchases.reduce((sum: number, p: Purchase) => sum + Number(p.subtotal || 0), 0);

    const netTaxPayable = outputVat - inputVat;

    const result = {
      totalSalesTaxable,
      outputVat, // TAX collected on sales
      totalPurchasesTaxable,
      inputVat, // TAX paid on purchases
      netTaxPayable, // Net tax due to Authority
      salesTaxDetails: rangeSales.map(s => ({ id: s.id, docId: s.SaleID || s.id, date: s.date || s.Date || '', taxable: s.subtotal || 0, vat: s.tax || 0 })),
      purchaseTaxDetails: rangePurchases.map(p => ({ id: p.id, docId: p.invoiceId || p.id, date: p.date, taxable: p.subtotal || 0, vat: p.tax || 0 }))
    };

    reportCache.set(cacheKey, result);
    return result;
  }

  /**
   * Account Movements & General Ledger Statement (كشف حركة الحسابات ودفتر الأستاذ)
   */
  static async getAccountMovement(start?: string, end?: string, accountId?: string) {
    const cacheKey = `account-movement-${start || 'all'}-${end || 'all'}-${accountId || 'all'}`;
    const cached = reportCache.get<unknown[]>(cacheKey);
    if (cached) return cached;

    const entries = await db.journalEntries.toArray();
    const accounts = await db.accounts.toArray();
    const accountMap = new Map<string, string>();
    accounts.forEach(a => {
      if (a.id && a.name) accountMap.set(String(a.id), String(a.name));
    });

    const movements: {
      id: string;
      date: string;
      entryNumber: string;
      description: string;
      accountId: string;
      accountName: string;
      debit: number;
      credit: number;
      reference?: string;
    }[] = [];

    entries
      .filter((e: JournalEntry) => {
        if (e.status !== 'Posted') return false;
        const d = e.date || '';
        if (start && d < start) return false;
        if (end && d > end) return false;
        return true;
      })
      .forEach((e: JournalEntry) => {
        (e.lines || []).forEach((l: JournalLine) => {
          if (accountId && l.accountId !== accountId) return;
          movements.push({
            id: `${e.id}-${l.accountId}`,
            date: e.date || '',
            entryNumber: e.entryNumber || e.id || '',
            description: (typeof l.description === 'string' ? l.description : '') || (typeof e.description === 'string' ? e.description : '') || 'قيد يومية',
            accountId: l.accountId,
            accountName: accountMap.get(l.accountId) || (typeof l.accountName === 'string' ? l.accountName : '') || l.accountId || '',
            debit: Number(l.debit || 0),
            credit: Number(l.credit || 0),
            reference: (e as any).reference || e.sourceType || ''
          });
        });
      });

    movements.sort((a, b) => (b.date > a.date ? 1 : -1));
    reportCache.set(cacheKey, movements);
    return movements;
  }

  /**
   * Sensitive Audit Trail & Governance Summary (سجل التدقيق والعمليات الحساسة)
   */
  static async getAuditSummary(start?: string, end?: string, limit = 200) {
    try {
      let logs = await db.auditLogs.orderBy('timestamp').reverse().toArray();
      if (start || end) {
        logs = logs.filter(l => {
          const d = l.timestamp || '';
          if (start && d < start) return false;
          if (end && d > end) return false;
          return true;
        });
      }
      return logs.slice(0, limit);
    } catch (e) {
      console.error('[ReportEngine] Failed to fetch audit logs:', e);
      return [];
    }
  }

  // Stubs replacement
  static async getIncomeStatement(start?: string, end?: string) {
    return await this.getProfitLoss(start, end);
  }

  static async getCustomerProfit(_start?: string, _end?: string) {
    return await this.getCustomerBalances();
  }

  static async getItemProfit(_start?: string, _end?: string) {
    return (await this.getInventoryValue()).items;
  }

  static async getAnalyticsSummary() {
    try {
      const sales = await db.invoices.where('type').equals('SALE').toArray() as Sale[];
      const purchases = await db.invoices.where('type').equals('PURCHASE').toArray() as Purchase[];
      const products = await db.getProducts();

      const totalSales = sales.reduce((sum: number, s: Sale) => sum + Number(s.finalTotal || 0), 0);
      const totalCost = sales.reduce((sum: number, s: Sale) => sum + Number(s.totalCost || 0), 0);
      const totalPurchases = purchases.reduce((sum: number, p: Purchase) => sum + Number(p.totalAmount || p.finalTotal || 0), 0);

      return {
        totalSales,
        totalPurchases,
        grossProfit: totalSales - totalCost,
        salesCount: sales.length,
        purchasesCount: purchases.length,
        productsCount: products.length,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      return {
        totalSales: 0,
        totalPurchases: 0,
        grossProfit: 0,
        salesCount: 0,
        purchasesCount: 0,
        productsCount: 0,
        timestamp: new Date().toISOString(),
        error: String(e)
      };
    }
  }
}

export const reportEngine = new ReportEngine();
