
import { db } from '@/core/db';
import { configurationService } from '@/services/config/configurationService';
import { AccountingEntry, JournalLine, Sale, Purchase, InvoiceItem, UnifiedInvoice } from '@/types';
import { CurrencyService } from '@/services/localization/CurrencyService';
import { AccountingError } from '@/core/errors';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';

export interface SaleAdjustment {
  Type: 'Discount' | 'Tax Adjustment' | string;
  Value: number;
}

export class AccountingEngine {
  
  /**
   * Calculates the total amount for a sale, including taxes and discounts.
   */
  static calculateSaleTotal(sale: Sale, adjustments: SaleAdjustment[] = []): number {
    let total = sale.items.reduce((acc, item) => acc + ((item.qty ?? 0) * (item.price ?? 0)), 0);
    adjustments.forEach(adj => {
      if (adj.Type === 'Discount') total -= adj.Value;
      else if (adj.Type === 'Tax Adjustment') total += adj.Value;
    });
    return total;
  }

  /**
   * Calculates the total amount for a purchase.
   */
  static calculatePurchaseTotal(purchase: Purchase): number {
    return (purchase.items || []).reduce((acc, item) => acc + ((item.qty ?? 0) * (item.price ?? 0)), 0);
  }

  static async getCoreAccount(type: 'CASH' | 'BANK' | 'RECEIVABLE' | 'PAYABLE' | 'INVENTORY' | 'SALES_REVENUE' | 'COGS' | 'EXPENSE'): Promise<string> {
    try {
      const setting = await configurationService.get<any>(`ACCOUNT_${type}`);
      if (setting) return typeof setting === 'string' ? setting : setting.value || setting;
    } catch (e) {
      console.warn(`Error fetching ACCOUNT_${type} from configurationService:`, e);
    }

    // Fallback to defaults if not configured
    const defaults: Record<string, string> = {
      CASH: 'ACC-101',
      BANK: 'ACC-104',
      RECEIVABLE: 'ACC-103',
      PAYABLE: 'ACC-201',
      INVENTORY: 'ACC-102',
      SALES_REVENUE: 'ACC-401',
      COGS: 'ACC-501',
      EXPENSE: 'ACC-502'
    };
    return defaults[type] || '';
  }

  static async seedAccounts() {
    console.log('AccountingEngine.seedAccounts called - now managed via Dexie settings');
  }

  static async generateSalesEntry(sale: Sale, items: InvoiceItem[]): Promise<AccountingEntry> {
    const cashAcc = await this.getCoreAccount('CASH');
    const arAcc = await this.getCoreAccount('RECEIVABLE');
    const revenueAcc = await this.getCoreAccount('SALES_REVENUE');
    const cogsAcc = await this.getCoreAccount('COGS');
    const invAcc = await this.getCoreAccount('INVENTORY');

    const lines: JournalLine[] = [];
    const entryId = `JE-${Date.now()}`;

    // Multi-currency conversion
    const currencyCode = (sale as any).currencyCode || CurrencyService.getCurrentCurrencyCode();
    const { baseAmount } = await CurrencyService.convertToBase(sale.finalTotal ?? 0, currencyCode, sale.date);

    // 1. Revenue Impact
    if (sale.paymentStatus === 'Cash') {
      lines.push(await this.createLine(entryId, cashAcc, baseAmount, 0));
    } else {
      lines.push(await this.createLine(entryId, arAcc, baseAmount, 0));
    }
    lines.push(await this.createLine(entryId, revenueAcc, 0, baseAmount));

    // 2. COGS Impact
    const totalCalculatedCost = await this.calculateTotalCOGS(items);
    const { baseAmount: baseCost } = await CurrencyService.convertToBase(totalCalculatedCost, currencyCode, sale.date);
    
    if (baseCost > 0) {
      lines.push(await this.createLine(entryId, cogsAcc, baseCost, 0));
      lines.push(await this.createLine(entryId, invAcc, 0, baseCost));
    }

    this.validateEntryBalance(lines);

    return {
      id: entryId,
      entry_id: entryId,
      date: sale.date,
      referenceId: sale.SaleID,
      description: `فاتورة مبيعات رقم ${sale.SaleID}`,
      TotalAmount: baseAmount,
      status: 'Posted',
      sourceId: sale.id,
      sourceType: 'SALE',
      lines,
      created_at: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };
  }

  static async generatePurchaseEntry(purchase: Purchase): Promise<AccountingEntry> {
    const cashAcc = await this.getCoreAccount('CASH');
    const apAcc = await this.getCoreAccount('PAYABLE');
    const invAcc = await this.getCoreAccount('INVENTORY');

    const lines: JournalLine[] = [];
    const entryId = `JE-${Date.now()}`;

    // Multi-currency conversion
    const currencyCode = (purchase as any).currencyCode || CurrencyService.getCurrentCurrencyCode();
    const { baseAmount } = await CurrencyService.convertToBase(purchase.totalAmount || purchase.finalTotal || 0, currencyCode, purchase.date || new Date().toISOString());

    // Debit Inventory
    lines.push(await this.createLine(entryId, invAcc, baseAmount, 0));

    // Credit Cash or Payable
    if (purchase.status === 'PAID') {
      lines.push(await this.createLine(entryId, cashAcc, 0, baseAmount));
    } else {
      lines.push(await this.createLine(entryId, apAcc, 0, baseAmount));
    }

    this.validateEntryBalance(lines);

    return {
      id: entryId,
      entry_id: entryId,
      date: purchase.date || new Date().toISOString(),
      referenceId: purchase.invoiceId,
      description: `فاتورة مشتريات رقم ${purchase.invoiceId}`,
      TotalAmount: baseAmount,
      status: 'Posted',
      sourceId: purchase.id,
      sourceType: 'PURCHASE',
      lines,
      created_at: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };
  }

  static async generateReturnEntry(sale: Sale, items: InvoiceItem[]): Promise<AccountingEntry> {
    const cashAcc = await this.getCoreAccount('CASH');
    const arAcc = await this.getCoreAccount('RECEIVABLE');
    const revenueAcc = await this.getCoreAccount('SALES_REVENUE');
    const cogsAcc = await this.getCoreAccount('COGS');
    const invAcc = await this.getCoreAccount('INVENTORY');

    const lines: JournalLine[] = [];
    const entryId = `JE-${Date.now()}`;

    const currencyCode = (sale as any).currencyCode || CurrencyService.getCurrentCurrencyCode();
    const { baseAmount } = await CurrencyService.convertToBase(sale.finalTotal ?? 0, currencyCode, sale.date);

    // Reverse Revenue: Debit Revenue, Credit Cash/AR
    lines.push(await this.createLine(entryId, revenueAcc, baseAmount, 0));
    if (sale.paymentStatus === 'Cash') {
      lines.push(await this.createLine(entryId, cashAcc, 0, baseAmount));
    } else {
      lines.push(await this.createLine(entryId, arAcc, 0, baseAmount));
    }

    // Reverse COGS: Debit Inventory, Credit COGS
    const totalCalculatedCost = await this.calculateTotalCOGS(items);
    const { baseAmount: baseCost } = await CurrencyService.convertToBase(totalCalculatedCost, currencyCode, sale.date);
    
    if (baseCost > 0) {
      lines.push(await this.createLine(entryId, invAcc, baseCost, 0));
      lines.push(await this.createLine(entryId, cogsAcc, 0, baseCost));
    }

    this.validateEntryBalance(lines);

    return {
      id: entryId,
      entry_id: entryId,
      date: sale.date,
      referenceId: sale.SaleID,
      description: `مرتجع مبيعات فاتورة رقم ${sale.SaleID}`,
      TotalAmount: baseAmount,
      status: 'Posted',
      sourceId: sale.id,
      sourceType: 'RETURN',
      lines,
      created_at: new Date().toISOString(),
      lastModified: new Date().toISOString()
    };
  }

  static async generatePurchaseReturnEntry(purchase: Purchase): Promise<AccountingEntry> {
    const cashAcc = await this.getCoreAccount('CASH');
    const apAcc = await this.getCoreAccount('PAYABLE');
    const invAcc = await this.getCoreAccount('INVENTORY');

    const lines: JournalLine[] = [];
    const entryId = `JE-${Date.now()}`;

    const currencyCode = (purchase as any).currencyCode || CurrencyService.getCurrentCurrencyCode();
    const { baseAmount } = await CurrencyService.convertToBase(purchase.totalAmount || purchase.finalTotal || 0, currencyCode, purchase.date || new Date().toISOString());

    // Debit Cash or Payable, Credit Inventory
    if (purchase.status === 'PAID') {
      lines.push(await this.createLine(entryId, cashAcc, baseAmount, 0));
    } else {
      lines.push(await this.createLine(entryId, apAcc, baseAmount, 0));
    }
    lines.push(await this.createLine(entryId, invAcc, 0, baseAmount));

    this.validateEntryBalance(lines);

    return {
      id: entryId,
      entry_id: entryId,
      date: purchase.date || new Date().toISOString(),
      referenceId: purchase.invoiceId,
      description: `مرتجع مشتريات فاتورة رقم ${purchase.invoiceId}`,
      TotalAmount: baseAmount,
      status: 'Posted',
      sourceId: purchase.id,
      sourceType: 'PURCHASE_RETURN',
      lines,
      created_at: new Date().toISOString(),
      lastModified: new Date().toISOString()
    };
  }

  static async generateVoucherEntry(params: {
    type: 'RECEIPT' | 'PAYMENT';
    amount: number;
    partnerId: string;
    date: string;
    refId: string;
    notes?: string;
    paymentMethod?: 'CASH' | 'TRANSFER';
    tenantId?: string;
    branchId?: string;
  }): Promise<AccountingEntry> {
    const cashAcc = await this.getCoreAccount('CASH');
    const bankAcc = await this.getCoreAccount('BANK');
    const arAcc = await this.getCoreAccount('RECEIVABLE');
    const apAcc = await this.getCoreAccount('PAYABLE');

    const lines: JournalLine[] = [];
    const entryId = `JE-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const fundAcc = params.paymentMethod === 'TRANSFER' ? bankAcc : cashAcc;

    if (params.type === 'RECEIPT') {
      lines.push(await this.createLine(entryId, fundAcc, params.amount, 0));
      lines.push(await this.createLine(entryId, arAcc, 0, params.amount));
    } else {
      lines.push(await this.createLine(entryId, apAcc, params.amount, 0));
      lines.push(await this.createLine(entryId, fundAcc, 0, params.amount));
    }

    this.validateEntryBalance(lines);

    return {
      id: entryId,
      entry_id: entryId,
      date: params.date,
      referenceId: params.refId,
      description: params.notes || `${params.type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} - ${params.partnerId}`,
      TotalAmount: params.amount,
      status: 'Posted',
      sourceId: params.refId,
      sourceType: 'VOUCHER',
      partnerId: params.partnerId,
      tenantId: params.tenantId,
      branchId: params.branchId,
      lines,
      created_at: new Date().toISOString(),
      lastModified: new Date().toISOString()
    };
  }

  private static async calculateTotalCOGS(items: InvoiceItem[]): Promise<number> {
    let totalCOGS = 0;
    for (const item of items) {
      let unitCost = 0;
      
      // Try to get cost from batch from Dexie
      if (item.batchId) {
        try {
          const batch = await db.medicineBatches.get(item.batchId);
          if (batch && batch.unitCost !== undefined) {
            unitCost = batch.unitCost;
          }
        } catch (e) {
          console.warn("Error fetching batch from Dexie:", e);
        }
      }
      
      // Fallback to product default cost price if batch cost is missing
      if (unitCost === 0) {
        const prodId = (item as any).productId || item.product_id;
        if (prodId) {
          try {
            const product = await db.products.get(prodId);
            if (product) {
              unitCost = product.CostPrice || (product as any).costPrice || 0;
            }
          } catch (e) {
            console.warn("Error fetching product from Dexie:", e);
          }
        }
      }
      
      const qty = item.qty || (item as any).quantity || 0;
      totalCOGS += qty * unitCost;
    }
    return totalCOGS;
  }

  private static validateEntryBalance(lines: JournalLine[]) {
    const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new AccountingError({
        message: `Unbalanced journal entry: Total Debit (${totalDebit}) does not equal Total Credit (${totalCredit}).`,
        arabicMessage: `القيد المحاسبي غير متوازن (إجمالي المدين ${totalDebit} لا يساوي الدائن ${totalCredit}).`,
        module: 'ACCOUNTING',
        metadata: { totalDebit, totalCredit },
      });
    }
  }

  /**
   * High-level postInvoice method for SystemOrchestrator
   */
  static async postInvoice(
    invoice: Sale | Purchase | UnifiedInvoice,
    _costResult?: { totalCost: number }
  ): Promise<void> {
    
    const type = ('type' in invoice && invoice.type) ? invoice.type : (('customerId' in invoice && invoice.customerId) ? 'SALE' : 'PURCHASE');
    const isReturn = ('isReturn' in invoice && invoice.isReturn) || ('invoiceType' in invoice && (invoice as { invoiceType?: string }).invoiceType === 'مرتجع');

    let entry: AccountingEntry | AccountingEntry[];

    if (type === 'SALE') {
      const saleObj = invoice as Sale;
      if (isReturn) {
        entry = await this.generateReturnEntry(saleObj, saleObj.items || []);
      } else {
        entry = await this.generateSalesEntry(saleObj, saleObj.items || []);
      }
    } else {
      const purchaseObj = invoice as Purchase;
      if (isReturn) {
        entry = await this.generatePurchaseReturnEntry(purchaseObj);
      } else {
        entry = await this.generatePurchaseEntry(purchaseObj);
      }
    }

    if (Array.isArray(entry)) {
      for (const e of entry) {
        await AccountingRepository.addEntry(e);
      }
    } else {
      await AccountingRepository.addEntry(entry);
    }
  }

  private static async createLine(entryId: string, accountId: string, debit: number, credit: number): Promise<JournalLine> {
    const id = `JL-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const safeAccId = accountId || 'ACC-GENERIC';
    
    return {
      id,
      lineId: id,
      entryId,
      entry_id: entryId,
      accountId: safeAccId,
      account_id: safeAccId,
      accountName: 'حساب محلي',
      debit,
      credit,
      type: debit > 0 ? 'DEBIT' : 'CREDIT',
      amount: debit > 0 ? debit : credit
    };
  }
}

