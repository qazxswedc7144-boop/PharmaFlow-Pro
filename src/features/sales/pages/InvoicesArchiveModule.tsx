
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { AdjustmentRepository } from '@/database/repositories/AdjustmentRepository';
import { SupplierRepository } from '@/database/repositories/SupplierRepository';
import { useUI } from '@/contexts/AppContext';
import { useAppStore } from '@/hooks/useAppStore';
import { Card, Badge, Modal } from '@/components/shared/SharedUI';
import AdjustmentForm from '@features/inventory/pages/AdjustmentForm';
import { authService } from '@features/auth/services/authService';
import { db } from '@/core/db';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';
import { transactionOrchestrator } from '@/services/transactions/transactionOrchestrator';
import { 
  Search, Edit3, ArrowRight, Tag, History, Filter, Fingerprint,
  Plus, Banknote, Clock, Lock, Ban, Cloud, RefreshCw, CalendarDays, RotateCcw
} from 'lucide-react';
import { FixedSizeList as List } from 'react-window';
import type { ArchiveDateFilter } from '@/features/sales/utils/archiveDateFilters';
import {
  getArchiveDateValue,
  getCurrentYearArchiveRange,
  isArchiveDateWithinRange,
  resolveArchiveDateRange,
  toArchiveDateKey
} from '@/features/sales/utils/archiveDateFilters';

export interface ArchiveInvoice {
  id: string;
  entityType: 'SALE' | 'PURCHASE';
  SaleID?: string;
  invoiceId?: string;
  purchase_id?: string;
  date?: string;
  Date?: string;
  createdAt?: string | Date;
  created_at?: string;
  Created_At?: string;
  finalTotal?: number;
  FinalTotal?: number;
  totalAmount?: number;
  finalAmount?: number;
  tax?: number;
  is_synced?: number;
  isSynced?: boolean;
  syncStatus?: string;
  payment_status?: string;
  paymentStatus?: string;
  status?: string;
  InvoiceStatus?: string;
  invoiceStatus?: string;
  paidAmount?: number;
  isReturn?: boolean;
  invoiceType?: string;
  [key: string]: unknown;
}

interface InvoicesArchiveModuleProps {
  onNavigate?: (view: string, params?: Record<string, unknown>) => void;
  initialFilter?: 'ALL' | 'SALE' | 'PURCHASE';
  initialSearch?: string;
  initialId?: string;
}

const InvoicesArchiveModule: React.FC<InvoicesArchiveModuleProps> = ({ 
  onNavigate, 
  initialFilter = 'ALL',
  initialSearch = '',
  initialId = ''
}) => {
  const { currency, version, refreshGlobal, addToast } = useUI();
  const { setEditingInvoiceId } = useAppStore();
  const user = authService.getCurrentUser();
  const isAdmin = user?.Role === 'Admin';
  
  const [searchTerm, setSearchTerm] = useState(initialSearch || initialId || '');
  const [invoices, setInvoices] = useState<ArchiveInvoice[]>([]);
  const [finalTotals, setFinalTotals] = useState<Record<string, number>>({});
  const [lockedInvoices, setLockedInvoices] = useState<Record<string, boolean>>({});
  const [showFilters, setShowFilters] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const [filterPopoverPosition, setFilterPopoverPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [isDateModalOpen, setIsDateModalOpen] = useState(false);
  const [filterType, setFilterType] = useState<'ALL' | 'SALE' | 'PURCHASE'>(initialFilter);
  const [quickFilter, setQuickFilter] = useState<'ALL' | 'UNPAID' | 'RETURNS'>('ALL');
  const [draftFilterType, setDraftFilterType] = useState<'ALL' | 'SALE' | 'PURCHASE'>(initialFilter);
  const [draftQuickFilter, setDraftQuickFilter] = useState<'ALL' | 'UNPAID' | 'RETURNS'>('ALL');
  const [appliedDateFilter, setAppliedDateFilter] = useState<ArchiveDateFilter | null>(null);
  const [draftDateFilter, setDraftDateFilter] = useState<ArchiveDateFilter | null>(null);
  const [calendarDateFilter, setCalendarDateFilter] = useState<ArchiveDateFilter>({
    basis: 'DOCUMENT', granularity: 'DAY', start: '', end: ''
  });
  const paymentFilter: 'ALL' | 'Cash' | 'Credit' = 'ALL';
  const [sortBy, setSortBy] = useState<'date' | 'total' | 'id'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  
  const [isAdjModalOpen, setIsAdjModalOpen] = useState(false);
  const [isSettlementModalOpen, setIsSettlementModalOpen] = useState(false);
  const [settlementHistory, setSettlementHistory] = useState<any[]>([]);
  const [targetInvoice, setTargetInvoice] = useState<ArchiveInvoice | null>(null);

  const [page, setPage] = useState(1);
  const pageSize = 10;

  const formatArchiveDate = (value: unknown): string => {
    const dateKey = toArchiveDateKey(value);
    return dateKey ? new Date(`${dateKey}T00:00:00`).toLocaleDateString('ar-SA') : '—';
  };

  const openDatePicker = () => {
    setCalendarDateFilter(draftDateFilter || {
      basis: 'DOCUMENT',
      granularity: 'DAY',
      start: '',
      end: ''
    });
    setIsDateModalOpen(true);
  };

  useEffect(() => {
    if (!showFilters) {
      setFilterPopoverPosition(null);
      return;
    }

    const updateFilterPopoverPosition = () => {
      const trigger = filterButtonRef.current;
      const popover = filterPopoverRef.current;
      if (!trigger || !popover) return;

      const visualViewport = window.visualViewport;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      const viewportWidth = visualViewport?.width ?? window.innerWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const edge = 12;
      const gap = 8;
      const maxHeight = Math.max(160, viewportHeight - edge * 2);
      const triggerRect = trigger.getBoundingClientRect();

      popover.style.maxHeight = `${maxHeight}px`;
      const popoverRect = popover.getBoundingClientRect();
      const fitsAbove = triggerRect.top - popoverRect.height - gap >= viewportTop + edge;
      const preferredTop = fitsAbove
        ? triggerRect.top - popoverRect.height - gap
        : triggerRect.bottom + gap;
      const top = Math.min(
        Math.max(preferredTop, viewportTop + edge),
        viewportBottom - Math.min(popoverRect.height, maxHeight) - edge
      );
      const left = Math.min(
        Math.max(triggerRect.left, edge),
        viewportWidth - popoverRect.width - edge
      );

      setFilterPopoverPosition({ top, left, maxHeight });
    };

    const frame = window.requestAnimationFrame(updateFilterPopoverPosition);
    window.addEventListener('resize', updateFilterPopoverPosition);
    window.addEventListener('scroll', updateFilterPopoverPosition, true);
    window.visualViewport?.addEventListener('resize', updateFilterPopoverPosition);
    window.visualViewport?.addEventListener('scroll', updateFilterPopoverPosition);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateFilterPopoverPosition);
      window.removeEventListener('scroll', updateFilterPopoverPosition, true);
      window.visualViewport?.removeEventListener('resize', updateFilterPopoverPosition);
      window.visualViewport?.removeEventListener('scroll', updateFilterPopoverPosition);
    };
  }, [showFilters]);

  const toggleArchiveFilters = () => {
    if (!showFilters) {
      setDraftFilterType(filterType);
      setDraftQuickFilter(quickFilter);
      setDraftDateFilter(appliedDateFilter);
    }
    setShowFilters(current => !current);
  };

  const applyArchiveFilters = () => {
    setFilterType(draftFilterType);
    setQuickFilter(draftQuickFilter);
    setAppliedDateFilter(draftDateFilter);
    setShowFilters(false);
  };

  const resetDraftArchiveFilters = () => {
    setDraftFilterType('ALL');
    setDraftQuickFilter('ALL');
    setDraftDateFilter(null);
  };

  const confirmCalendarRange = () => {
    const range = resolveArchiveDateRange(calendarDateFilter);
    if (!range) {
      addToast('يرجى تحديد تاريخ بداية ونهاية صحيحين، والتأكد أن البداية لا تتجاوز النهاية', 'warning');
      return;
    }
    setDraftDateFilter(calendarDateFilter);
    setIsDateModalOpen(false);
  };

  const getSyncBadge = (inv: ArchiveInvoice) => {
    const isSynced = inv.is_synced === 1 || inv.isSynced === true || inv.syncStatus === 'SYNCED';
    if (isSynced) {
      return (
        <span className="flex items-center gap-1 text-[9px] font-[#2E7D32] bg-emerald-50 px-2 py-1 rounded-full border border-emerald-100">
          <Cloud size={10} className="text-[#388E3C]" />
          <span className="font-bold">مُتزامن</span>
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1 text-[9px] font-[#D84315] bg-amber-50 px-2 py-1 rounded-full border border-amber-100 animate-pulse">
        <RefreshCw size={10} className="animate-spin text-[#E64A19]" />
        <span className="font-bold">معلق المزامنة</span>
      </span>
    );
  };

  useEffect(() => {
    if (initialFilter) setFilterType(initialFilter);
  }, [initialFilter]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, filterType, quickFilter, paymentFilter, sortBy, appliedDateFilter]);

  useEffect(() => {
    const loadArchive = async () => {
      const data = await InvoiceRepository.getInvoicesArchive();
      setInvoices(data as unknown as ArchiveInvoice[]);
    };
    loadArchive();
  }, [version]);

  const filteredInvoices = useMemo(() => {
    let list = [...invoices];
    if (filterType !== 'ALL') list = list.filter(inv => inv.entityType === filterType);

    // The archive defaults to the current calendar year using the invoice's visible document date.
    // A user-selected creation-date range uses the immutable record timestamp instead.
    const dateRange = appliedDateFilter
      ? resolveArchiveDateRange(appliedDateFilter)
      : getCurrentYearArchiveRange();
    const dateBasis = appliedDateFilter?.basis || 'DOCUMENT';
    if (dateRange) {
      list = list.filter(inv => isArchiveDateWithinRange(getArchiveDateValue(inv, dateBasis), dateRange));
    }
    if (quickFilter === 'UNPAID') {
      list = list.filter(inv => {
        const paid = Number(inv.paidAmount || 0);
        const total = Number(inv.finalTotal || inv.FinalTotal || inv.totalAmount || inv.finalAmount || 0);
        const status = String(inv.payment_status || inv.paymentStatus || '').toLowerCase();
        return status.includes('unpaid') || status.includes('غير مسدد') || (total > 0 && paid < total);
      });
    } else if (quickFilter === 'RETURNS') {
      list = list.filter(inv => inv.isReturn === true || String(inv.invoiceType || '').toLowerCase().includes('return') || String(inv.invoiceType || '').includes('مرتجع'));
    }
    if (paymentFilter !== 'ALL') {
      list = list.filter(inv => {
        const method = inv.paymentStatus || (inv.status === 'PAID' ? 'Cash' : 'Credit');
        return method === paymentFilter;
      });
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      list = list.filter(inv => {
        const invId = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
        const partner = String(inv.entityType === 'SALE'
          ? (inv.customerName || inv.CustomerName || inv.customerId || 'عميل نقدي')
          : (inv.partnerName || inv.supplierName || inv.partnerId || ''));
        return invId.toLowerCase().includes(term) || partner.toLowerCase().includes(term);
      });
    }

    // Sorting
    list.sort((a, b) => {
      let valA: number | string = 0;
      let valB: number | string = 0;
      if (sortBy === 'date') {
        valA = new Date(`${toArchiveDateKey(getArchiveDateValue(a, dateBasis)) || '1970-01-01'}T00:00:00`).getTime();
        valB = new Date(`${toArchiveDateKey(getArchiveDateValue(b, dateBasis)) || '1970-01-01'}T00:00:00`).getTime();
      } else if (sortBy === 'total') {
        const idA = a.entityType === 'SALE' ? (a.SaleID || a.id) : (a.invoiceId || a.purchase_id || a.id);
        const idB = b.entityType === 'SALE' ? (b.SaleID || b.id) : (b.invoiceId || b.purchase_id || b.id);
        valA = finalTotals[idA] || 0;
        valB = finalTotals[idB] || 0;
      } else {
        valA = a.entityType === 'SALE' ? (a.SaleID || a.id) : (a.invoiceId || a.purchase_id || a.id);
        valB = b.entityType === 'SALE' ? (b.SaleID || b.id) : (b.invoiceId || b.purchase_id || b.id);
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }, [invoices, searchTerm, filterType, quickFilter, paymentFilter, sortBy, sortOrder, finalTotals, appliedDateFilter]);

  const archiveStats = useMemo(() => ({
    total: filteredInvoices.length,
    sales: filteredInvoices.filter(inv => inv.entityType === 'SALE').length,
    purchases: filteredInvoices.filter(inv => inv.entityType === 'PURCHASE').length,
    unpaid: filteredInvoices.filter(inv => {
      const paid = Number(inv.paidAmount || 0);
      const total = Number(inv.finalTotal || inv.FinalTotal || inv.totalAmount || inv.finalAmount || 0);
      const status = String(inv.payment_status || inv.paymentStatus || '').toLowerCase();
      return status.includes('unpaid') || status.includes('غير مسدد') || (total > 0 && paid < total);
    }).length
  }), [filteredInvoices]);

  const hasActiveFilters = Boolean(searchTerm.trim()) || filterType !== 'ALL' || quickFilter !== 'ALL' || appliedDateFilter !== null;
  const resetFilters = () => {
    setSearchTerm('');
    setFilterType('ALL');
    setQuickFilter('ALL');
    setAppliedDateFilter(null);
    setDraftFilterType('ALL');
    setDraftQuickFilter('ALL');
    setDraftDateFilter(null);
    setSortBy('date');
    setSortOrder('desc');
  };

  const paginatedInvoices = useMemo(() => {
    return filteredInvoices.slice((page - 1) * pageSize, page * pageSize);
  }, [filteredInvoices, page]);

  useEffect(() => {
    const resolvePaginatedBalances = async () => {
      if (paginatedInvoices.length === 0) return;

      const missingIds = paginatedInvoices
        .map(inv => inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id))
        .filter(id => finalTotals[id] === undefined || lockedInvoices[id] === undefined);

      if (missingIds.length === 0) return;

      const nextTotals = { ...finalTotals };
      const nextLocks = { ...lockedInvoices };
      let updated = false;

      await Promise.all(paginatedInvoices.map(async (inv) => {
        const id = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
        
        if (nextTotals[id] === undefined) {
          const subtotal = inv.entityType === 'SALE' ? (inv.finalTotal || inv.FinalTotal || 0) : (inv.totalAmount || inv.finalAmount || 0);
          const tax = inv.tax || 0;
          nextTotals[id] = await AdjustmentRepository.calculateFinalTotal(id, subtotal, tax);
          updated = true;
        }

        if (nextLocks[id] === undefined) {
          const invDate = inv.date || inv.Date;
          nextLocks[id] = await PeriodLockEngine.isPeriodLocked(invDate || '');
          updated = true;
        }
      }));

      if (updated) {
        setFinalTotals(nextTotals);
        setLockedInvoices(nextLocks);
      }
    };
    resolvePaginatedBalances();
  }, [paginatedInvoices]);

  const handleOpenSettlements = async (e: React.MouseEvent, inv: ArchiveInvoice) => {
    e.stopPropagation();
    const id = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
    const history = await SupplierRepository.getInvoicePaymentHistory(id);
    setSettlementHistory(history);
    setTargetInvoice(inv);
    setIsSettlementModalOpen(true);
  };

  const handleViewAudit = (e: React.MouseEvent, inv: ArchiveInvoice) => {
    e.stopPropagation();
    const id = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
    // التنقل لواجهة التدقيق مع تمرير المعرف (Contextual Filter)
    onNavigate?.('audit-history', { id });
  };

  const handleOpenInvoice = (inv: ArchiveInvoice) => {
    const id = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
    const view = inv.entityType === 'SALE' ? 'sales' : 'purchases';
    onNavigate?.(view, { id });
  };

  const handleCancelInvoice = async (e: React.MouseEvent, inv: ArchiveInvoice) => {
    e.stopPropagation();
    const invDate = inv.date || inv.Date;
    const recordId = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
    
    if (invDate && await PeriodLockEngine.isPeriodLocked(invDate || '') && !isAdmin) {
      addToast("خطأ حماية: لا يمكن إلغاء مستند يقع ضمن فترة محاسبية مغلقة 🔒", "error");
      return;
    }

    const status = inv.InvoiceStatus || inv.invoiceStatus;
    if (status === 'CANCELLED' || status === 'VOID') {
      addToast("المستند ملغى بالفعل", "info");
      return;
    }

    // Phase 5: Double Confirm Delete
    const confirmText = `هل أنت متأكد من إلغاء هذا المستند؟ سيتم قفله ومنع التعديل عليه.\nيرجى كتابة رقم الفاتورة [${recordId}] للتأكيد:`;
    const userInput = prompt(confirmText);
    
    if (userInput !== recordId) {
      if (userInput !== null) addToast("رقم الفاتورة غير متطابق، تم إلغاء العملية", "warning");
      return;
    }
    
    try {
      // Phase 4: Delete Protection (Soft Delete)
      await transactionOrchestrator.deleteInvoice(inv.id, inv.entityType);
      addToast("تم إلغاء المستند بنجاح بنظام الأرشفة الآمنة ✅", "success");
      refreshGlobal();
    } catch (err: unknown) { 
      const errMsg = err instanceof Error ? err.message : "Error cancelling";
      addToast(errMsg, "error"); 
    }
  };

  const handleUnpostAndEdit = async (e: React.MouseEvent, inv: ArchiveInvoice) => {
    e.stopPropagation();
    const recordId = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
    
    if (!isAdmin) {
      addToast("عذراً، هذه الصلاحية متوفرة للمدراء فقط 🔒", "error");
      return;
    }

    // Confirmation Dialog (User Request)
    const confirmText = `⚠️ تحذير: أنت على وشك إلغاء ترحيل الفاتورة رقم [${recordId}].
سيتم عكس كافة القيود المحاسبية وحركات المخزون المرتبطة بها.
هل تريد الاستمرار؟`;
    
    if (!window.confirm(confirmText)) return;

    try {
      const res = await transactionOrchestrator.unpostInvoice(inv.id, inv.entityType);
      if (res.success) {
        addToast("تم إلغاء الترحيل بنجاح. يمكنك الآن تعديل الفاتورة ✅", "success");
        
        // Phase 3: Smart Navigation
        const paymentType = inv.paymentStatus || (inv.status === 'PAID' ? 'Cash' : 'Credit');
        const isReturn = inv.entityType === 'SALE' ? !!inv.isReturn : inv.invoiceType === 'مرتجع';
        
        let targetView = '';
        if (inv.entityType === 'PURCHASE') {
          if (isReturn) {
            targetView = paymentType === 'Cash' ? 'PurchaseReturnCashScreen' : 'PurchaseReturnCreditScreen';
          } else {
            targetView = paymentType === 'Cash' ? 'PurchaseCashScreen' : 'PurchaseCreditScreen';
          }
        } else {
          if (isReturn) {
            targetView = paymentType === 'Cash' ? 'SalesReturnCashScreen' : 'SalesReturnCreditScreen';
          } else {
            targetView = paymentType === 'Cash' ? 'SalesCashScreen' : 'SalesCreditScreen';
          }
        }
        
        const viewMapping: Record<string, string> = {
          'PurchaseCashScreen': 'purchases',
          'PurchaseCreditScreen': 'purchases',
          'PurchaseReturnCashScreen': 'purchases',
          'PurchaseReturnCreditScreen': 'purchases',
          'SalesCashScreen': 'sales',
          'SalesCreditScreen': 'sales',
          'SalesReturnCashScreen': 'sales',
          'SalesReturnCreditScreen': 'sales'
        };

        setEditingInvoiceId(inv.id);
        onNavigate?.(viewMapping[targetView] || (inv.entityType === 'SALE' ? 'sales' : 'purchases'), { id: inv.id });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "فشل إلغاء الترحيل";
      addToast(errMsg, "error");
    }
  };

  const getPaymentStatusBadge = (inv: ArchiveInvoice, total: number) => {
    const paid = inv.paidAmount || 0;
    const status = inv.payment_status || (paid === 0 ? 'Unpaid' : paid < total ? 'Partially Paid' : 'Paid');
    
    switch(status) {
      case 'Unpaid': return <Badge variant="danger">غير مسددة</Badge>;
      case 'Partially Paid': return <Badge variant="warning">مسددة جزئياً</Badge>;
      case 'Paid': return <Badge variant="success">مسددة بالكامل</Badge>;
      default: return <Badge variant="neutral">{status}</Badge>;
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 bg-[#F8FAFA] min-h-full pb-32 animate-in fade-in" dir="rtl">
      <div className="space-y-4">
        <div className="flex items-center gap-2.5 min-w-0 w-full">
          <button
            onClick={() => onNavigate?.('dashboard')}
            className="w-7 h-7 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center text-[#1E4D4D] hover:bg-slate-100 transition-all shrink-0"
            title="الرجوع للرئيسية"
            aria-label="الرجوع للرئيسية"
          >
            <ArrowRight size={16} />
          </button>
          <div className="w-12 h-12 sm:w-14 sm:h-14 bg-[#1E4D4D] text-white rounded-[20px] flex items-center justify-center text-2xl shadow-lg shrink-0" aria-hidden="true">📦</div>
          <div className="flex items-baseline gap-2 min-w-0 flex-1 overflow-hidden whitespace-nowrap">
            <h2 className="text-base sm:text-xl md:text-2xl font-black text-[#1E4D4D] shrink-0">أرشيف المستندات</h2>
            <p className="hidden sm:block text-slate-400 text-[10px] font-bold truncate min-w-0">إدارة سجلات العمليات والربط المالي</p>
          </div>
        </div>
        <div className="flex items-center gap-2 w-full">
          <button onClick={() => onNavigate?.('sales')} className="flex-1 min-w-0 bg-[#10B981] text-white px-3 sm:px-5 py-2.5 rounded-xl font-black text-[10px] shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2"><Plus size={14} /> مبيعات جديدة</button>
          <button onClick={() => onNavigate?.('purchases')} className="flex-1 min-w-0 bg-[#1E4D4D] text-white px-3 sm:px-5 py-2.5 rounded-xl font-black text-[10px] shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2"><Plus size={14} /> مشتريات جديدة</button>
        </div>
      </div>

      <div className="flex items-center gap-2 bg-white p-2 rounded-[20px] border border-slate-100 shadow-sm relative">
        <div className="relative flex-1 min-w-0 group">
          <input type="text" placeholder="رقم الفاتورة أو العميل أو المورد..." aria-label="البحث في أرشيف المستندات" className="w-full min-w-0 bg-slate-50 border-2 border-transparent rounded-[16px] px-10 py-3 text-[10px] sm:text-[11px] font-black focus:bg-white focus:border-[#1E4D4D] outline-none shadow-inner" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          <Search size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300" />
        </div>
        <button ref={filterButtonRef} onClick={toggleArchiveFilters} aria-expanded={showFilters} aria-haspopup="dialog" className={`shrink-0 flex items-center gap-2 px-3 sm:px-5 py-3 rounded-[16px] text-[10px] font-black transition-all border ${showFilters ? 'bg-[#1E4D4D] text-white' : 'bg-slate-50 text-slate-500'}`}>
          <Filter size={14} /> فلترة
        </button>
        {showFilters && (
          <>
            <div className="fixed inset-0 z-40" role="presentation" onClick={() => setShowFilters(false)} />
            <div ref={filterPopoverRef} className="fixed z-50 w-[min(320px,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-2xl border border-slate-100 bg-white p-3 shadow-2xl" style={{ top: filterPopoverPosition?.top ?? 12, left: filterPopoverPosition?.left ?? 12, maxHeight: filterPopoverPosition?.maxHeight ?? 'calc(100dvh - 24px)', visibility: filterPopoverPosition ? 'visible' : 'hidden' }} dir="rtl" role="dialog" aria-label="تصفية أرشيف المستندات">
              <button type="button" onClick={openDatePicker} className="w-full rounded-xl bg-slate-50 px-3 py-3 text-sm font-black text-[#1E4D4D] hover:bg-emerald-50 transition-colors">
                <span className="flex items-center justify-center gap-2">
                  <span>التاريخ</span>
                  <CalendarDays size={18} />
                </span>
              </button>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setDraftFilterType('ALL'); setDraftQuickFilter('ALL'); }} aria-pressed={draftFilterType === 'ALL' && draftQuickFilter === 'ALL'} className={`col-span-2 rounded-xl px-3 py-2.5 text-xs font-black transition-colors ${draftFilterType === 'ALL' && draftQuickFilter === 'ALL' ? 'bg-[#1E4D4D] text-white shadow-sm' : 'bg-slate-100 text-slate-600'}`}>الكل</button>
                <button type="button" onClick={() => { setDraftFilterType('SALE'); setDraftQuickFilter('ALL'); }} aria-pressed={draftFilterType === 'SALE' && draftQuickFilter === 'ALL'} className={`rounded-xl px-3 py-2.5 text-xs font-black transition-colors ${draftFilterType === 'SALE' && draftQuickFilter === 'ALL' ? 'bg-[#1E4D4D] text-white shadow-sm' : 'bg-slate-100 text-slate-600'}`}>مبيعات</button>
                <button type="button" onClick={() => { setDraftFilterType('PURCHASE'); setDraftQuickFilter('ALL'); }} aria-pressed={draftFilterType === 'PURCHASE' && draftQuickFilter === 'ALL'} className={`rounded-xl px-3 py-2.5 text-xs font-black transition-colors ${draftFilterType === 'PURCHASE' && draftQuickFilter === 'ALL' ? 'bg-[#1E4D4D] text-white shadow-sm' : 'bg-slate-100 text-slate-600'}`}>مشتريات</button>
                <button type="button" onClick={() => { setDraftFilterType('ALL'); setDraftQuickFilter('RETURNS'); }} aria-pressed={draftQuickFilter === 'RETURNS'} className={`rounded-xl px-3 py-2.5 text-xs font-black transition-colors ${draftQuickFilter === 'RETURNS' ? 'bg-[#1E4D4D] text-white shadow-sm' : 'bg-slate-100 text-slate-600'}`}>مرتجعات</button>
                <button type="button" onClick={() => { setDraftFilterType('ALL'); setDraftQuickFilter('UNPAID'); }} aria-pressed={draftQuickFilter === 'UNPAID'} className={`rounded-xl px-3 py-2.5 text-xs font-black transition-colors ${draftQuickFilter === 'UNPAID' ? 'bg-[#1E4D4D] text-white shadow-sm' : 'bg-slate-100 text-slate-600'}`}>غير مسددة</button>
              </div>
              <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-center text-[10px] font-bold text-slate-500">
                {draftDateFilter
                  ? `من ${draftDateFilter.start} إلى ${draftDateFilter.end} · ${draftDateFilter.basis === 'DOCUMENT' ? 'تاريخ الفاتورة' : 'تاريخ الإنشاء'}`
                  : 'بدون نطاق محدد: من بداية السنة إلى اليوم'}
              </div>
              <div className="mt-3 space-y-2">
                <p className="text-[10px] font-black text-slate-500">ترتيب حسب</p>
                <div className="flex rounded-xl bg-slate-50 p-1">
                  {(['date', 'total', 'id'] as const).map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        if (sortBy === option) setSortOrder(current => current === 'asc' ? 'desc' : 'asc');
                        else { setSortBy(option); setSortOrder('desc'); }
                      }}
                      className={`flex-1 rounded-lg py-2 text-[9px] font-black transition-colors ${sortBy === option ? 'bg-white text-[#1E4D4D] shadow-sm' : 'text-slate-500'}`}
                    >
                      {option === 'date' ? 'التاريخ' : option === 'total' ? 'الإجمالي' : 'المرجع'}
                      {sortBy === option ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
                <button type="button" onClick={resetDraftArchiveFilters} className="flex-1 rounded-xl bg-slate-100 px-3 py-3 text-[10px] font-black text-slate-600 hover:bg-slate-200">
                  <span className="flex items-center justify-center gap-1"><RotateCcw size={13} /> إعادة تعيين</span>
                </button>
                <button type="button" onClick={applyArchiveFilters} className="flex-[1.4] rounded-xl bg-[#1E4D4D] px-3 py-3 text-[10px] font-black text-white shadow-md hover:bg-[#163c3c]">
                  تطبيق الفلترة
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'المستندات', value: archiveStats.total },
          { label: 'المبيعات', value: archiveStats.sales },
          { label: 'المشتريات', value: archiveStats.purchases },
          { label: 'غير مسددة', value: archiveStats.unpaid }
        ].map(stat => (
          <div key={stat.label} className="bg-white border border-slate-100 rounded-xl px-3 py-2 shadow-sm min-w-0">
            <p className="text-[9px] font-bold text-slate-400 truncate">{stat.label}</p>
            <p className="text-base font-black text-[#1E4D4D] tabular-nums">{stat.value.toLocaleString('ar')}</p>
          </div>
        ))}
      </div>

      {/* Virtualized Mobile Cards View */}
      <div className="lg:hidden w-full" style={{ height: filteredInvoices.length === 0 ? 'auto' : Math.min(600, Math.max(300, filteredInvoices.length * 170)) }}>
        {filteredInvoices.length === 0 ? (
          <div className="py-10 px-4 text-center bg-white rounded-3xl border border-slate-100 shadow-sm space-y-3">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-[#1E4D4D] text-xl">{invoices.length === 0 ? '📦' : '🔎'}</div>
            <p className="text-sm font-black text-slate-600">{invoices.length === 0 ? 'الأرشيف فارغ حالياً' : 'لا توجد مستندات مطابقة للفلاتر'}</p>
            <p className="text-[10px] text-slate-400">{invoices.length === 0 ? 'أنشئ أول مستند ليظهر هنا' : 'جرّب تعديل البحث أو إعادة تعيين الفلاتر'}</p>
            {hasActiveFilters ? (
              <button onClick={resetFilters} className="px-4 py-2 rounded-xl bg-slate-100 text-[#1E4D4D] text-[10px] font-black">إعادة تعيين الفلاتر</button>
            ) : invoices.length === 0 ? (
              <div className="flex justify-center gap-2">
                <button onClick={() => onNavigate?.('sales')} className="px-3 py-2 rounded-xl bg-[#10B981] text-white text-[10px] font-black">فاتورة مبيعات جديدة</button>
                <button onClick={() => onNavigate?.('purchases')} className="px-3 py-2 rounded-xl bg-[#1E4D4D] text-white text-[10px] font-black">فاتورة مشتريات جديدة</button>
              </div>
            ) : null}
          </div>
        ) : (
          <List
            height={Math.min(600, Math.max(300, filteredInvoices.length * 170))}
            itemCount={filteredInvoices.length}
            itemSize={170}
            width="100%"
            className="custom-scrollbar"
          >
            {({ index, style }) => {
              const inv = filteredInvoices[index];
              if (!inv) return null;
              const id = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
              const total = finalTotals[id] || 0;
              const paid = inv.paidAmount || 0;
              const isFinancialLocked = inv.payment_status && inv.payment_status !== 'Unpaid';
              const invDate = inv.date || inv.Date;
              const isPeriodLocked = lockedInvoices[id] || false;
              const partner = inv.entityType === 'SALE'
                ? (inv.customerName || inv.CustomerName || inv.customerId || 'عميل نقدي')
                : (inv.partnerName || inv.supplierName || inv.partnerId);

              return (
                <div style={style} className="pb-3 px-1" key={id}>
                  <Card onClick={() => handleOpenInvoice(inv)} className="hover:shadow-md transition-all cursor-pointer border-slate-100 !p-4 relative group h-full flex flex-col justify-between">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className="w-8 h-8 bg-slate-50 rounded-lg flex items-center justify-center text-xs">
                          {inv.entityType === 'SALE' ? '🛒' : '📦'}
                        </span>
                        <div>
                          <div className="flex items-center gap-1">
                            <span className="font-black text-[#1E4D4D] text-sm">{id}</span>
                            {(isFinancialLocked || isPeriodLocked) && (
                              <Lock size={10} className={isPeriodLocked ? "text-amber-500" : "text-red-400"} />
                            )}
                          </div>
                          <p className="text-[9px] font-bold text-slate-400">{formatArchiveDate(invDate)}</p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-[9px] font-black text-[#1E4D4D] bg-emerald-50 px-2 py-1 rounded-full">{inv.entityType === 'SALE' ? 'مبيعات' : 'مشتريات'}{inv.isReturn || String(inv.invoiceType || '').includes('مرتجع') ? ' · مرتجع' : ''}</span>
                        {getPaymentStatusBadge(inv, total)}
                        {getSyncBadge(inv)}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between items-end">
                        <div>
                          <p className="text-[8px] font-black text-slate-300 uppercase tracking-widest mb-0.5">الطرف الثاني</p>
                          <p className="text-xs font-black text-slate-700 truncate max-w-[150px]">{String(partner || '')}</p>
                        </div>
                        <div className="text-left">
                          <p className="text-[8px] font-black text-slate-300 uppercase tracking-widest mb-0.5 text-left">الإجمالي</p>
                          <p className="text-sm font-black text-[#1E4D4D]">{total.toLocaleString()} <span className="text-[10px] opacity-40">{currency}</span></p>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-50 flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-[9px] font-black text-slate-400">المسدد: <span className="text-emerald-600">{paid.toLocaleString()}</span></span>
                          <span className="text-[9px] font-black text-slate-400">المتبقي: <span className="text-amber-600">{Math.max(0, total - paid).toLocaleString()}</span></span>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); handleViewAudit(e, inv); }} className="p-2 bg-slate-50 text-slate-400 rounded-lg hover:bg-[#1E4D4D] hover:text-white transition-colors"><Fingerprint size={14}/></button>
                          <button onClick={(e) => { e.stopPropagation(); handleOpenSettlements(e, inv); }} className="p-2 bg-slate-50 text-blue-500 rounded-lg hover:bg-blue-505 hover:text-white transition-colors"><History size={14}/></button>
                        </div>
                      </div>
                    </div>
                  </Card>
                </div>
              );
            }}
          </List>
        )}
      </div>

      {/* Virtualized Desktop Table View */}
      <Card noPadding className="hidden lg:block shadow-xl overflow-hidden !rounded-[40px] bg-white border-slate-100">
        <div className="bg-[#F8FAFA] text-slate-400 font-black border-b border-slate-50 flex text-right text-[11px] px-8 py-5">
          <div className="w-2/12">المرجع</div>
          <div className="w-2/12">التاريخ</div>
          <div className="w-3/12">الطرف</div>
          <div className="w-2/12 text-center">الحالة</div>
          <div className="w-1/12 text-center">المسدد</div>
          <div className="w-2/12 text-left">إجراءات</div>
        </div>

        {filteredInvoices.length === 0 ? (
          <div className="py-16 px-4 text-center text-slate-500 font-black bg-white">
            <p>{invoices.length === 0 ? 'الأرشيف فارغ حالياً' : 'لا توجد مستندات مطابقة للفلاتر'}</p>
            {hasActiveFilters && <button onClick={resetFilters} className="mt-3 px-4 py-2 rounded-xl bg-slate-100 text-[#1E4D4D] text-[10px]">إعادة تعيين الفلاتر</button>}
          </div>
        ) : (
          <List
            height={Math.min(550, Math.max(250, filteredInvoices.length * 68))}
            itemCount={filteredInvoices.length}
            itemSize={68}
            width="100%"
            className="custom-scrollbar divide-y divide-slate-50"
          >
            {({ index, style }) => {
              const inv = filteredInvoices[index];
              if (!inv) return null;
              const id = inv.entityType === 'SALE' ? (inv.SaleID || inv.id) : (inv.invoiceId || inv.purchase_id || inv.id);
              const total = finalTotals[id] || 0;
              const paid = inv.paidAmount || 0;
              const isFinancialLocked = inv.payment_status && inv.payment_status !== 'Unpaid';
              const invDate = inv.date || inv.Date;
              const isPeriodLocked = lockedInvoices[id] || false;
              const partner = inv.entityType === 'SALE'
                ? (inv.customerName || inv.CustomerName || inv.customerId || 'عميل نقدي')
                : (inv.partnerName || inv.supplierName || inv.partnerId);

              return (
                <div 
                  style={style} 
                  key={id} 
                  onClick={() => handleOpenInvoice(inv)} 
                  className="flex items-center text-right text-[11px] px-8 py-3 hover:bg-slate-50 cursor-pointer group transition-colors border-b border-slate-50"
                >
                  <div className="w-2/12">
                    <div className="flex items-center gap-2">
                      <span className="font-black text-[#1E4D4D]">{id}</span>
                      {(isFinancialLocked || isPeriodLocked) && (
                        <Lock size={12} className={isPeriodLocked ? "text-amber-500" : "text-red-400"} />
                      )}
                    </div>
                  </div>
                  <div className="w-2/12 font-bold text-slate-400">
                    {formatArchiveDate(invDate)}
                  </div>
                  <div className="w-3/12 font-black text-slate-600 truncate">
                    {String(partner || '')}
                  </div>
                  <div className="w-2/12 text-center">
                    <div className="flex flex-col items-center gap-1">
                      {getPaymentStatusBadge(inv, total)}
                      {getSyncBadge(inv)}
                    </div>
                  </div>
                  <div className="w-1/12 text-center">
                    <div className="flex flex-col items-center">
                      <span className={`font-black ${paid >= total ? 'text-emerald-500' : 'text-blue-500'}`}>{paid.toLocaleString()}</span>
                      <span className="text-[7px] font-bold opacity-30 uppercase">من {total.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="w-2/12">
                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all">
                      {inv.InvoiceStatus === 'POSTED' || inv.invoiceStatus === 'POSTED' ? (
                        <button onClick={(e) => handleUnpostAndEdit(e, inv)} className="w-9 h-9 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-indigo-500 hover:text-indigo-600 shadow-sm" title="إلغاء الترحيل والتعديل"><Edit3 size={16} /></button>
                      ) : (
                        <button onClick={() => handleOpenInvoice(inv)} className="w-9 h-9 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-emerald-500 hover:text-emerald-600 shadow-sm" title="تعديل"><Edit3 size={16} /></button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); setTargetInvoice(inv); setIsAdjModalOpen(true); }} className={`w-9 h-9 bg-white border border-slate-100 rounded-xl flex items-center justify-center transition-all ${isPeriodLocked && !isAdmin ? 'text-slate-200 cursor-not-allowed' : 'text-amber-500 hover:text-amber-600 shadow-sm'}`} title="تعديل مالي"><Tag size={16} /></button>
                      <button onClick={(e) => handleCancelInvoice(e, inv)} className={`w-9 h-9 bg-white border border-slate-100 rounded-xl flex items-center justify-center transition-all ${isPeriodLocked && !isAdmin ? 'text-slate-200 cursor-not-allowed' : 'text-red-300 hover:text-red-500 shadow-sm'}`} title="إلغاء المستند"><Ban size={16} /></button>
                      <button onClick={(e) => { e.stopPropagation(); handleViewAudit(e, inv); }} className="w-9 h-9 bg-white border border-slate-100 rounded-xl text-slate-900 flex items-center justify-center hover:bg-slate-900 hover:text-white" title="تاريخ التدقيق"><Fingerprint size={16}/></button>
                      <button onClick={(e) => handleOpenSettlements(e, inv)} className="w-9 h-9 bg-white border border-slate-100 rounded-xl text-blue-500 flex items-center justify-center hover:shadow-md" title="سجل الدفعات"><History size={16}/></button>
                    </div>
                  </div>
                </div>
              );
            }}
          </List>
        )}
      </Card>

      {/* Pagination Controls */}
      {filteredInvoices.length > pageSize && (
        <div className="flex items-center justify-between bg-white p-4 rounded-[20px] border border-slate-100 shadow-sm mt-4" dir="rtl">
          <p className="text-[10px] font-black text-slate-400">
            عرض الفواتير {Math.min(filteredInvoices.length, (page - 1) * pageSize + 1)} - {Math.min(filteredInvoices.length, page * pageSize)} من أصل {filteredInvoices.length}
          </p>
          <div className="flex gap-2">
            <button
              disabled={page === 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-4 py-2 bg-slate-50 border border-slate-100 text-[10px] font-black hover:bg-slate-100 rounded-xl transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-[#1E4D4D]"
            >
              السابق
            </button>
            <span className="px-4 py-2 bg-[#1E4D4D] text-white rounded-xl text-[10px] font-black">
              {page} / {Math.ceil(filteredInvoices.length / pageSize)}
            </span>
            <button
              disabled={page >= Math.ceil(filteredInvoices.length / pageSize)}
              onClick={() => setPage(p => Math.min(Math.ceil(filteredInvoices.length / pageSize), p + 1))}
              className="px-4 py-2 bg-slate-50 border border-slate-100 text-[10px] font-black hover:bg-slate-100 rounded-xl transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-[#1E4D4D]"
            >
              التالي
            </button>
          </div>
        </div>
      )}

      <Modal
        isOpen={isDateModalOpen}
        onClose={() => setIsDateModalOpen(false)}
        title="تحديد فترة الأرشيف"
        maxWidth="sm:max-w-md"
        positionClass="items-center"
      >
        <div className="space-y-4 py-2" dir="rtl">
          <div className="space-y-2">
            <p className="text-xs font-black text-slate-600">أساس البحث بالتاريخ</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCalendarDateFilter(current => ({ ...current, basis: 'DOCUMENT' }))} aria-pressed={calendarDateFilter.basis === 'DOCUMENT'} className={`rounded-xl border px-3 py-3 text-xs font-black ${calendarDateFilter.basis === 'DOCUMENT' ? 'border-[#1E4D4D] bg-[#1E4D4D] text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                تاريخ الفاتورة
              </button>
              <button type="button" onClick={() => setCalendarDateFilter(current => ({ ...current, basis: 'CREATED' }))} aria-pressed={calendarDateFilter.basis === 'CREATED'} className={`rounded-xl border px-3 py-3 text-xs font-black ${calendarDateFilter.basis === 'CREATED' ? 'border-[#1E4D4D] bg-[#1E4D4D] text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                تاريخ الإنشاء
              </button>
            </div>
            <p className="text-[10px] leading-5 text-slate-400">
              تاريخ الفاتورة هو التاريخ الظاهر في الأرشيف. تاريخ الإنشاء هو وقت إدخال السجل ولا يتغير عند تعديل تاريخ الفاتورة.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-black text-slate-600">نوع الفترة</p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'DAY', label: 'يومي' },
                { value: 'MONTH', label: 'شهري' },
                { value: 'YEAR', label: 'سنوي' }
              ] as const).map(option => (
                <button key={option.value} type="button" onClick={() => setCalendarDateFilter(current => ({ ...current, granularity: option.value, start: '', end: '' }))} aria-pressed={calendarDateFilter.granularity === option.value} className={`rounded-xl border px-2 py-2.5 text-xs font-black ${calendarDateFilter.granularity === option.value ? 'border-[#1E4D4D] bg-emerald-50 text-[#1E4D4D]' : 'border-slate-200 bg-white text-slate-500'}`}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-2">
              <span className="block text-xs font-black text-slate-600">{calendarDateFilter.granularity === 'DAY' ? 'من تاريخ' : calendarDateFilter.granularity === 'MONTH' ? 'من شهر' : 'من سنة'}</span>
              <input
                type={calendarDateFilter.granularity === 'DAY' ? 'date' : calendarDateFilter.granularity === 'MONTH' ? 'month' : 'number'}
                min={calendarDateFilter.granularity === 'YEAR' ? '1900' : undefined}
                max={calendarDateFilter.granularity === 'YEAR' ? '9999' : undefined}
                step={calendarDateFilter.granularity === 'YEAR' ? '1' : undefined}
                inputMode={calendarDateFilter.granularity === 'YEAR' ? 'numeric' : undefined}
                value={calendarDateFilter.start}
                onChange={event => setCalendarDateFilter(current => ({ ...current, start: event.target.value }))}
                className="w-full min-w-0 rounded-xl border-2 border-slate-200 bg-white px-2 py-3 text-center text-xs font-bold text-slate-700 outline-none focus:border-[#1E4D4D]"
              />
            </label>
            <label className="space-y-2">
              <span className="block text-xs font-black text-slate-600">{calendarDateFilter.granularity === 'DAY' ? 'إلى تاريخ' : calendarDateFilter.granularity === 'MONTH' ? 'إلى شهر' : 'إلى سنة'}</span>
              <input
                type={calendarDateFilter.granularity === 'DAY' ? 'date' : calendarDateFilter.granularity === 'MONTH' ? 'month' : 'number'}
                min={calendarDateFilter.granularity === 'YEAR' ? '1900' : undefined}
                max={calendarDateFilter.granularity === 'YEAR' ? '9999' : undefined}
                step={calendarDateFilter.granularity === 'YEAR' ? '1' : undefined}
                inputMode={calendarDateFilter.granularity === 'YEAR' ? 'numeric' : undefined}
                value={calendarDateFilter.end}
                onChange={event => setCalendarDateFilter(current => ({ ...current, end: event.target.value }))}
                className="w-full min-w-0 rounded-xl border-2 border-slate-200 bg-white px-2 py-3 text-center text-xs font-bold text-slate-700 outline-none focus:border-[#1E4D4D]"
              />
            </label>
          </div>
          <div className="flex gap-2 border-t border-slate-100 pt-3">
            <button type="button" onClick={() => setIsDateModalOpen(false)} className="flex-1 rounded-xl bg-slate-100 px-4 py-3 text-xs font-black text-slate-600">
              إلغاء
            </button>
            <button type="button" onClick={confirmCalendarRange} className="flex-1 rounded-xl bg-[#1E4D4D] px-4 py-3 text-xs font-black text-white shadow-md">
              اعتماد الفترة
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isSettlementModalOpen} onClose={() => setIsSettlementModalOpen(false)} title="سجل سدادات الفاتورة">
         {targetInvoice && (
           <div className="space-y-6 py-2" dir="rtl">
              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex justify-between items-center">
                 <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase">إجمالي المستند</p>
                    <h3 className="text-lg font-black text-[#1E4D4D]">{finalTotals[targetInvoice.entityType === 'SALE' ? (targetInvoice.SaleID || targetInvoice.id) : (targetInvoice.invoiceId || targetInvoice.purchase_id || targetInvoice.id)]?.toLocaleString()} {currency}</h3>
                 </div>
                 {getPaymentStatusBadge(targetInvoice, finalTotals[targetInvoice.entityType === 'SALE' ? (targetInvoice.SaleID || targetInvoice.id) : (targetInvoice.invoiceId || targetInvoice.purchase_id || targetInvoice.id)] || 0)}
              </div>

              <div className="space-y-3">
                 <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">سجل الدفعات (Vouchers)</h4>
                 {settlementHistory.length === 0 ? (
                    <div className="py-10 text-center opacity-30 italic font-bold text-xs">لا توجد دفعات مرتبطة بهذا المستند حالياً</div>
                 ) : (
                    <div className="space-y-2">
                       {settlementHistory.map(s => (
                         <div key={s.id} className="p-4 bg-white border border-slate-100 rounded-2xl flex justify-between items-center shadow-sm">
                            <div className="flex items-center gap-3">
                               <div className="w-8 h-8 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center"><Banknote size={14}/></div>
                               <div>
                                  <p className="font-black text-[#1E4D4D] text-xs">سند مالي رقم #{s.voucherId}</p>
                                  <p className="text-[9px] font-bold text-slate-400 flex items-center gap-1"><Clock size={8}/> {new Date(s.date).toLocaleDateString('ar-SA')}</p>
                               </div>
                            </div>
                            <span className="font-black text-emerald-600 text-sm">{s.amount.toLocaleString()}</span>
                         </div>
                       ))}
                    </div>
                 )}
              </div>
           </div>
         )}
      </Modal>

      {targetInvoice && (
        <AdjustmentForm 
          isOpen={isAdjModalOpen}
          onClose={() => setIsAdjModalOpen(false)}
          invoiceId={targetInvoice.entityType === 'SALE' ? (targetInvoice.SaleID || targetInvoice.id) : (targetInvoice.invoiceId || targetInvoice.purchase_id || targetInvoice.id)}
          currency={currency}
          onSave={async (adj) => {
            const id = targetInvoice.entityType === 'SALE' ? (targetInvoice.SaleID || targetInvoice.id) : (targetInvoice.invoiceId || targetInvoice.purchase_id || targetInvoice.id);
            await AdjustmentRepository.save({ ...adj, AdjustmentID: db.generateId('ADJ'), InvoiceID: id });
            addToast("تمت إضافة التعديل المالي بنجاح ✅", "success");
            refreshGlobal();
          }}
        />
      )}
    </div>
  );
};

export default InvoicesArchiveModule;
