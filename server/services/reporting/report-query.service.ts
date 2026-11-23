// server/services/reporting/report-query.service.ts
// Secure Multi-Tenant & Multi-Branch Data Aggregation Layer

import { prisma } from "../../database/prisma.js";
import { ReportFilterParams, ReportSyncMetadata, ReportingSyncTag } from "./reporting.types.js";

export interface QueriedAccount {
  id: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  balance: number;
  tenantId?: string | null;
}

export interface QueriedJournalLine {
  id: string;
  entryId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  debit: number;
  credit: number;
  description: string;
  entryDate: string;
  entryNumber: string;
  sourceType: string;
  sourceId?: string;
  status: string;
  branchId?: string | null;
  tenantId?: string | null;
  isSynced?: boolean;
}

export interface QueriedProduct {
  id: string;
  name: string;
  barcode: string;
  sku: string;
  category: string;
  cost: number;
  price: number;
  stockQuantity: number;
  expiryDate?: string;
  tenantId?: string | null;
  branchId?: string | null;
  isSynced?: boolean;
}

export interface QueriedInvoice {
  id: string;
  invoiceNumber: string;
  date: string;
  type: "SALE" | "PURCHASE" | "RETURN_SALE" | "RETURN_PURCHASE";
  partnerId?: string | null;
  partnerType?: string | null;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  paidAmount: number;
  paidAmountKnown?: boolean;
  costAmount: number;
  status: string;
  paymentStatus: string;
  branchId?: string | null;
  tenantId?: string | null;
  isSynced?: boolean;
}

export interface QueriedPartner {
  id: string;
  name: string;
  type: "CUSTOMER" | "SUPPLIER";
  phone?: string;
  email?: string;
  balance: number;
  tenantId?: string | null;
  isSynced?: boolean;
}

export class ReportQueryService {
  // In-memory store for unit test suites and offline mock simulations
  private static mockAccounts: QueriedAccount[] = [];
  private static mockJournalLines: QueriedJournalLine[] = [];
  private static mockProducts: QueriedProduct[] = [];
  private static mockInvoices: QueriedInvoice[] = [];
  private static mockPartners: QueriedPartner[] = [];

  public static seedMockData(data: {
    accounts?: QueriedAccount[];
    journalLines?: QueriedJournalLine[];
    products?: QueriedProduct[];
    invoices?: QueriedInvoice[];
    partners?: QueriedPartner[];
  }): void {
    if (data.accounts) this.mockAccounts = [...data.accounts];
    if (data.journalLines) this.mockJournalLines = [...data.journalLines];
    if (data.products) this.mockProducts = [...data.products];
    if (data.invoices) this.mockInvoices = [...data.invoices];
    if (data.partners) this.mockPartners = [...data.partners];
  }

  public static clearMockData(): void {
    this.mockAccounts = [];
    this.mockJournalLines = [];
    this.mockProducts = [];
    this.mockInvoices = [];
    this.mockPartners = [];
  }

  /**
   * Fetch Chart of Accounts for Tenant
   */
  public static async getAccounts(filters: ReportFilterParams): Promise<QueriedAccount[]> {
    if (this.mockAccounts.length > 0) {
      return this.mockAccounts.filter(a => !a.tenantId || a.tenantId === filters.tenantId);
    }

    try {
      if (prisma && prisma.account) {
        const rows = await prisma.account.findMany({
          // Account.tenantId is required by the PostgreSQL schema.
// System accounts are tenant-scoped too; tenantId: null is not a valid filter.
          where: {
            tenantId: filters.tenantId
          },
          orderBy: { code: "asc" }
        });
        return rows.map(r => ({
          id: r.id,
          code: r.code,
          name: r.name,
          type: r.type as any,
          balance: Number(r.balance || 0),
          tenantId: r.tenantId
        }));
      }
    } catch {
      // Fallback
    }

    return this.getDefaultChartOfAccounts(filters.tenantId);
  }

  /**
   * Fetch Journal Lines with tenant, branch and date filters
   */
  public static async getJournalLines(filters: ReportFilterParams): Promise<QueriedJournalLine[]> {
    if (this.mockJournalLines.length > 0) {
      return this.mockJournalLines.filter(l => {
        if (l.tenantId && l.tenantId !== filters.tenantId) return false;
        if (filters.branchId && l.branchId !== filters.branchId) return false;
        if (filters.accountId && l.accountId !== filters.accountId) return false;
        if (filters.startDate && l.entryDate < filters.startDate) return false;
        if (filters.endDate && l.entryDate > filters.endDate) return false;
        if (filters.asOfDate && l.entryDate > filters.asOfDate) return false;
        return true;
      });
    }

    try {
      if (prisma && prisma.journalLine) {
        const where: any = {
          entry: {
            tenantId: filters.tenantId,
            status: "POSTED"
          }
        };

        if (filters.branchId) {
          where.entry.branchId = filters.branchId;
        }

        if (filters.startDate || filters.endDate || filters.asOfDate) {
          where.entry.date = {};
          if (filters.startDate) where.entry.date.gte = new Date(filters.startDate);
          if (filters.endDate) where.entry.date.lte = new Date(filters.endDate);
          if (filters.asOfDate) where.entry.date.lte = new Date(filters.asOfDate);
        }

        if (filters.accountId) {
          where.accountId = filters.accountId;
        }

        const lines = await prisma.journalLine.findMany({
          where,
          include: {
            entry: true,
            account: true
          },
          orderBy: { entry: { date: "asc" } }
        });

        return lines.map(l => ({
          id: l.id,
          entryId: l.entryId,
          accountId: l.accountId,
          accountCode: l.account.code,
          accountName: l.account.name,
          accountType: l.account.type as any,
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          description: l.description || l.entry.description || "قيد يومية",
          entryDate: l.entry.date.toISOString().split("T")[0]!,
          entryNumber: l.entry.referenceId || l.entryId,
          sourceType: l.entry.sourceType || "MANUAL",
          sourceId: l.entry.sourceId || undefined,
          status: l.entry.status,
          branchId: l.entry.branchId,
          tenantId: l.entry.tenantId,
          isSynced: true
        }));
      }
    } catch {
      // Fallback
    }

    return [];
  }

  /**
   * Fetch Products and Inventory details
   */
  public static async getProducts(filters: ReportFilterParams): Promise<QueriedProduct[]> {
    if (this.mockProducts.length > 0) {
      return this.mockProducts.filter(p => {
        if (p.tenantId && p.tenantId !== filters.tenantId) return false;
        if (filters.productId && p.id !== filters.productId) return false;
        if (filters.category && p.category !== filters.category) return false;
        return true;
      });
    }

    try {
      if (prisma && prisma.product) {
        const rows = await prisma.product.findMany({
          where: {
            tenantId: filters.tenantId,
            isActive: true,
            deletedAt: null
          },
          include: {
            inventoryBatches: {
              where: { quantity: { gt: 0 } },
              orderBy: { expiryDate: "asc" }
            }
          }
        });

        return rows.map(r => {
          const nearestBatch = r.inventoryBatches?.[0];
          return {
            id: r.id,
            name: r.name,
            barcode: r.barcode || "N/A",
            sku: r.sku || "N/A",
            category: "عام",
            cost: Number(r.cost || 0),
            price: Number(r.price || 0),
            stockQuantity: Number(r.stockQuantity || 0),
            expiryDate: nearestBatch?.expiryDate ? nearestBatch.expiryDate.toISOString().split("T")[0] : undefined,
            tenantId: r.tenantId,
            isSynced: true
          };
        });
      }
    } catch {
      // Fallback
    }

    return [];
  }

  /**
   * Fetch Invoices (Sales, Purchases, Returns)
   */
  public static async getInvoices(filters: ReportFilterParams): Promise<QueriedInvoice[]> {
    if (this.mockInvoices.length > 0) {
      return this.mockInvoices.filter(inv => {
        if (inv.tenantId && inv.tenantId !== filters.tenantId) return false;
        if (filters.branchId && inv.branchId && inv.branchId !== filters.branchId) return false;
        if (filters.startDate && inv.date < filters.startDate) return false;
        if (filters.endDate && inv.date > filters.endDate) return false;
        if (filters.asOfDate && inv.date > filters.asOfDate) return false;
        if (filters.customerId && inv.partnerId !== filters.customerId) return false;
        if (filters.supplierId && inv.partnerId !== filters.supplierId) return false;
        return true;
      });
    }

    try {
      if (prisma && prisma.invoice) {
        const where: any = {
          tenantId: filters.tenantId,
          documentStatus: "ACTIVE"
        };

        if (filters.branchId) where.branchId = filters.branchId;
        if (filters.customerId) {
          where.partnerId = filters.customerId;
          where.partnerType = "CUSTOMER";
        }
        if (filters.supplierId) {
          where.partnerId = filters.supplierId;
          where.partnerType = "SUPPLIER";
        }

        if (filters.startDate || filters.endDate || filters.asOfDate) {
          where.date = {};
          if (filters.startDate) where.date.gte = new Date(filters.startDate);
          if (filters.endDate) where.date.lte = new Date(filters.endDate);
          if (filters.asOfDate) where.date.lte = new Date(filters.asOfDate);
        }

        const rows = await prisma.invoice.findMany({
          where,
          include: { items: true },
          orderBy: { date: "asc" }
        });

        return rows.map(r => {
          const total = Number(r.totalAmount || 0);
          const tax = total * 0.15 / 1.15; // default 15% VAT calculation if not broken down
          const subtotal = total - tax;
          return {
            id: r.id,
            invoiceNumber: r.invoiceNumber,
            date: r.date.toISOString().split("T")[0]!,
            type: r.type as any,
            partnerId: r.partnerId,
            partnerType: r.partnerType,
            subtotal,
            taxAmount: tax,
            totalAmount: total,
            paidAmount: r.paidAmount !== null && r.paidAmount !== undefined
              ? Number(r.paidAmount)
              : r.paymentStatus === "PAID" || r.paymentStatus === "CASH" ? total : 0,
            paidAmountKnown: r.paidAmount !== null && r.paidAmount !== undefined
              || r.paymentStatus !== "PARTIALLY_PAID",
            costAmount: subtotal * 0.7, // baseline estimate if not tracked individually
            status: r.status,
            paymentStatus: r.paymentStatus,
            branchId: r.branchId,
            tenantId: r.tenantId,
            isSynced: r.isSynced
          };
        });
      }
    } catch {
      // Fallback
    }

    return [];
  }

  /**
   * Fetch Customers and Suppliers
   */
  public static async getPartners(
    type: "CUSTOMER" | "SUPPLIER",
    filters: ReportFilterParams
  ): Promise<QueriedPartner[]> {
    if (this.mockPartners.length > 0) {
      return this.mockPartners.filter(p => {
        if (p.type !== type) return false;
        if (p.tenantId && p.tenantId !== filters.tenantId) return false;
        return true;
      });
    }

    try {
      if (type === "CUSTOMER" && prisma && prisma.customer) {
        const rows = await prisma.customer.findMany({
          where: { tenantId: filters.tenantId, isActive: true },
          orderBy: { name: "asc" }
        });
        return rows.map(r => ({
          id: r.id,
          name: r.name,
          type: "CUSTOMER",
          phone: r.phone || undefined,
          email: r.email || undefined,
          balance: Number(r.balance || 0),
          tenantId: r.tenantId
        }));
      }

      if (type === "SUPPLIER" && prisma && prisma.supplier) {
        const rows = await prisma.supplier.findMany({
          where: { tenantId: filters.tenantId, isActive: true },
          orderBy: { name: "asc" }
        });
        return rows.map(r => ({
          id: r.id,
          name: r.name,
          type: "SUPPLIER",
          phone: r.phone || undefined,
          email: r.email || undefined,
          balance: Number(r.balance || 0),
          tenantId: r.tenantId
        }));
      }
    } catch {
      // Fallback
    }

    return [];
  }

  /**
   * Compute Sync State Metadata across fetched items
   */
  public static evaluateSyncState(items: { isSynced?: boolean }[]): ReportSyncMetadata {
    const total = items.length;
    if (total === 0) {
      return {
        overallState: "CLOUD_AUTHORITATIVE",
        hasUnsyncedData: false,
        hasConflictedData: false,
        authoritativeRecordsCount: 0,
        syncedRecordsCount: 0,
        unsyncedRecordsCount: 0,
        conflictedRecordsCount: 0,
        asOfServerTimestamp: Date.now()
      };
    }

    const unsyncedCount = items.filter(i => i.isSynced === false).length;
    const syncedCount = items.filter(i => i.isSynced === true).length;

    let overallState: ReportingSyncTag = "CLOUD_AUTHORITATIVE";
    let hasUnsyncedData = false;
    let syncWarningArabic: string | undefined;
    let syncWarningEnglish: string | undefined;

    if (unsyncedCount > 0) {
      hasUnsyncedData = true;
      overallState = unsyncedCount === total ? "LOCAL_UNSYNCED" : "PARTIALLY_SYNCED";
      syncWarningArabic = "تنبيه: يحتوي هذا التقرير على سجلات محلية غير متزامنة مع السحابة.";
      syncWarningEnglish = "Warning: This report contains local records that are not yet synchronized with cloud authority.";
    }

    return {
      overallState,
      hasUnsyncedData,
      hasConflictedData: false,
      syncWarningArabic,
      syncWarningEnglish,
      authoritativeRecordsCount: syncedCount,
      syncedRecordsCount: syncedCount,
      unsyncedRecordsCount: unsyncedCount,
      conflictedRecordsCount: 0,
      asOfServerTimestamp: Date.now()
    };
  }

  private static getDefaultChartOfAccounts(tenantId: string): QueriedAccount[] {
    return [
      { id: "ACC-101", code: "ACC-101", name: "الصندوق والنقدية (Cash)", type: "ASSET", balance: 0, tenantId },
      { id: "ACC-104", code: "ACC-104", name: "البنك والحسابات الجارية (Bank)", type: "ASSET", balance: 0, tenantId },
      { id: "ACC-102", code: "ACC-102", name: "العملاء والمدينون (Accounts Receivable)", type: "ASSET", balance: 0, tenantId },
      { id: "ACC-103", code: "ACC-103", name: "مخزون الأدوية والبضائع (Inventory)", type: "ASSET", balance: 0, tenantId },
      { id: "ACC-201", code: "ACC-201", name: "الموردون والدائنون (Accounts Payable)", type: "LIABILITY", balance: 0, tenantId },
      { id: "ACC-202", code: "ACC-202", name: "أمانات ضريبة القيمة المضافة (VAT Payable)", type: "LIABILITY", balance: 0, tenantId },
      { id: "ACC-301", code: "ACC-301", name: "رأس المال (Owner Equity)", type: "EQUITY", balance: 0, tenantId },
      { id: "ACC-302", code: "ACC-302", name: "الأرباح المحتجزة (Retained Earnings)", type: "EQUITY", balance: 0, tenantId },
      { id: "ACC-401", code: "ACC-401", name: "إيرادات المبيعات (Sales Revenue)", type: "REVENUE", balance: 0, tenantId },
      { id: "ACC-501", code: "ACC-501", name: "تكلفة المبيعات (Cost of Goods Sold)", type: "EXPENSE", balance: 0, tenantId },
      { id: "ACC-502", code: "ACC-502", name: "مصاريف تشغيلية وعمومية (Operating Expenses)", type: "EXPENSE", balance: 0, tenantId },
      { id: "ACC-503", code: "ACC-503", name: "الرواتب والأجور (Salaries & Wages)", type: "EXPENSE", balance: 0, tenantId },
      { id: "ACC-504", code: "ACC-504", name: "إيجار وفواتير المرافق (Rent & Utilities)", type: "EXPENSE", balance: 0, tenantId }
    ];
  }
}
