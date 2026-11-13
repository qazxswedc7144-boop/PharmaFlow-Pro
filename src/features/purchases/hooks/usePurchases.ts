import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { configurationService } from '@/services/config/configurationService';
import { db } from '@/core/db';
import { Product, InvoiceStatus, InvoiceItem, PaymentStatus, Supplier } from '@/types';
import { useUI, useInventory, useAccounting } from '@/contexts/AppContext';
import { useAppStore } from '@/hooks/useAppStore';
import { authService } from '@features/auth/services/authService';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { InvoiceRepository } from '@/database/repositories/invoice.repository';
import { SupplierRepository } from '@/database/repositories/SupplierRepository';
import { auditLogService } from '@/services/audit/auditLog';
import { InvoiceWorkflowEngine } from '@features/sales/services/InvoiceWorkflowEngine';
import { predictionService } from '@features/ai/services/predictionService';
import { saveLearning } from '@features/ai/services/learningService';
import { useAppNotification } from '@/context/NotificationContext';
import { ErrorManager } from '@/core/errors';
import { DraftService } from '@/services/system/DraftService';
import { reportCache } from '@features/reports/services/reportCacheService';
import { ReportEngine } from '@/services/reports/reportEngine';
import { SmartImportOrchestrator } from '../services/smartImport/smartImportOrchestrator';
import { ImportAnalysisResult, ExtractedImportRow } from '../services/smartImport/types';
import { normalizeToISODate } from '@/utils/expiryUtils';
import { generateTransactionUuid } from '@/utils/uuid';
import { collectPendingProductsForInvoice, mergePendingProductSuggestions } from '../utils/pendingProducts';
import { buildFailedPurchaseDraft } from '../utils/failedPurchaseDraft';
import { getPurchaseFailureDisposition } from '../utils/purchaseFailureDisposition';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import type { IdempotencyRecord } from '@/core/integrity/types';
import { getPurchaseDraftSnapshot } from '../utils/recoverablePurchaseDraft';
import { cleanupFailedPurchaseOperation } from '../utils/cleanupFailedPurchaseOperation';
import { canResetAfterFailedPurchase, cleanupFailedPurchaseDrafts, getPurchaseSaveFailureMessage } from '../utils/purchaseSaveFailure';
import { writeDiagnosticLog } from '@/services/system/diagnosticLogger';
import { discardPurchaseDrafts } from '../utils/discardPurchaseDrafts';
import { getPurchaseAuditDetails, getSavedPurchaseInvoiceNumber, normalizeSupplierInvoiceNumber } from '../utils/purchaseInvoiceNumber';

const DRAFT_KEY = 'pharmaflow_purchase_draft';

function getPurchaseDraftKeys() {
  const session = TokenProvider.getCurrentSession();
  const user = session.user as any;
  const tenantId = String(session.tenantId || user?.tenantId || user?.tenant_id || '').trim();
  const branchValue = session.branchId || user?.branchId || user?.branch_id;
  const branchId = typeof branchValue === 'string' && branchValue.trim() ? branchValue.trim() : null;
  if (!tenantId) throw new Error('PURCHASE_DRAFT_TENANT_REQUIRED: refusing to use an unscoped purchase draft.');
  const tenantKey = encodeURIComponent(tenantId);
  const branchKey = encodeURIComponent(branchId || 'no-branch');
  return {
    tenantId,
    branchId,
    invoiceDraftId: `purchases_draft_${tenantKey}_${branchKey}`,
    draftId: `purchases_${tenantKey}_${branchKey}`,
    configKey: `${DRAFT_KEY}_${tenantKey}_${branchKey}`
  };
}

export interface AIParsedInvoiceData {
  invoice_number?: string;
  supplier?: string;
  type?: string;
  notes?: string;
  items?: Array<{
    name?: string;
    quantity?: number;
    price?: number;
    discountPercent?: number;
    barcode?: string;
    bonusQty?: number;
    batchNumber?: string;
    notes?: string;
    product_id?: string;
    expiryDate?: string;
    categoryId?: string;
  }>;
}

export function usePurchases(onNavigate?: (view: string, params?: Record<string, unknown>) => void) {
  const { addToast, currency, refreshGlobal } = useUI();
  const { showNotification } = useAppNotification();
  const { addInvoice, suppliers } = useAccounting();
  const { categories, addCategory } = useInventory();
  const { setEditingInvoiceId, editingInvoiceId, systemStatus } = useAppStore();
  const isRecovery = systemStatus === 'RECOVERY_MODE';
  
  const [items, setItems] = useState<InvoiceItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [supplierSearchTerm, setSupplierSearchTerm] = useState('');
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);
  const [isAddSupplierModalOpen, setIsAddSupplierModalOpen] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');

  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [filteredSuppliers, setFilteredSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierIndex, setSelectedSupplierIndex] = useState(-1);
  const [isSearchingSuppliers, setIsSearchingSuppliers] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      (async () => {
        const term = supplierSearchTerm.trim();
        if (term.length < 2) {
          setFilteredSuppliers([]);
          return;
        }
        setIsSearchingSuppliers(true);
        try {
          const results = await SupplierRepository.searchSuppliers(term);
          setFilteredSuppliers(results);
        } catch (err) {
          console.error('Error searching suppliers:', err);
          const localResults = await predictionService.searchSuppliers(term);
          setFilteredSuppliers(localResults);
        } finally {
          setIsSearchingSuppliers(false);
        }
      })().catch(e => console.error("[usePurchases] supplierSearch fatal:", e));
    }, 400);
    return () => clearTimeout(timer);
  }, [supplierSearchTerm]);

  const [isSaving, setIsSaving] = useState(false);
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [hasDependencies, setHasDependencies] = useState(false);
  const [isAdjustmentsOpen, setIsAdjustmentsOpen] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [hasUnsavedAI, setHasUnsavedAI] = useState(false);
  const [showAIConfirmModal, setShowAIConfirmModal] = useState(false);
  const [aiParsedData, setAIParsedData] = useState<AIParsedInvoiceData | null>(null);
  const [smartAnalysisResult, setSmartAnalysisResult] = useState<ImportAnalysisResult | null>(null);
  const [importProgressStage, setImportProgressStage] = useState<string>('');
  const [importProgressPercent, setImportProgressPercent] = useState<number>(0);
  const [importProgressMessage, setImportProgressMessage] = useState<string>('');
  const [saveSuccessData, setSaveSuccessData] = useState<{ invoiceNumber: string; totalAmount: number; type: 'SALE' | 'PURCHASE'; date?: string; partnerName?: string; accountingStatus?: string; inventoryStatus?: string; balanceStatus?: string } | null>(null);
  const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
  const [recoveryDraftData, setRecoveryDraftData] = useState<Record<string, unknown> | null>(null);
  const [isConfirmSaveOpen, setIsConfirmSaveOpen] = useState(false);
  const [adjData, setAdjData] = useState({ discountPercent: 0, otherFees: 0, tax: 0 });
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [manualItemName, setManualItemName] = useState<string>('');
  const [tempQty, setTempQty] = useState<number | string>('');
  const [tempPrice, setTempPrice] = useState<number | string>('');
  const [tempExpiry, setTempExpiry] = useState<string>('');
  const [tempNote, setTempNote] = useState<string>('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [manualCategoryName, setManualCategoryName] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const invNumInputRef = useRef<HTMLInputElement>(null);
  const prevSupplierInvoiceNumberRef = useRef<string>('');
  const itemNameInputRef = useRef<HTMLInputElement>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const expiryInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const categoryInputRef = useRef<HTMLSelectElement>(null);
  const [header, setHeader] = useState({ invoice_number: '', supplierInvoiceNumber: '', supplier_id: '', payment_method: 'Cash', status: 'DRAFT' as InvoiceStatus, payment_status: 'Unpaid' as PaymentStatus, date: new Date().toISOString().split('T')[0], notes: '', isReturn: false, attachment: '' });
  const currentOperationRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const pendingProductsRef = useRef<any[]>([]);

  const resetInvoiceState = useCallback(() => {
    prevSupplierInvoiceNumberRef.current = '';
    setHeader({ invoice_number: '', supplierInvoiceNumber: '', supplier_id: '', payment_method: 'Cash', status: 'DRAFT', payment_status: 'Unpaid', date: new Date().toISOString().split('T')[0], notes: '', isReturn: false, attachment: '' });
    setItems([]);
    setAdjData({ discountPercent: 0, otherFees: 0, tax: 0 });
    setSupplierSearchTerm('');
    setSearchTerm('');
    setFilteredProducts([]);
    setSelectedProduct(null);
    setManualItemName('');
    setTempQty('');
    setTempPrice('');
    setTempExpiry('');
    setTempNote('');
    setSelectedIndex(-1);
    setShowSearchDropdown(false);
    setManualCategoryName('');
    setSelectedCategoryId('');
    setShowCategoryDropdown(false);
    setShowSupplierDropdown(false);
    setSelectedSupplierIndex(-1);
    setHasDependencies(false);
    setEditingInvoiceId(null);
    setAIParsedData(null);
    setSmartAnalysisResult(null);
    setShowAIConfirmModal(false);
    setIsProcessingAI(false);
    setHasUnsavedAI(false);
    setIsRecoveryModalOpen(false);
    setRecoveryDraftData(null);
    setIsConfirmSaveOpen(false);
    setSavePhase('idle');
    currentOperationRef.current = null;
    pendingProductsRef.current = [];
  }, [setEditingInvoiceId]);

  const [isDateLockedStatus, setIsDateLockedStatus] = useState(false);
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const query = manualItemName.trim();
        if (!query) {
          setFilteredProducts([]);
          return;
        }
        const persistedProducts = await predictionService.searchProducts(query);
        const suggestions = mergePendingProductSuggestions(
          persistedProducts as any[],
          pendingProductsRef.current,
          query
        );
        setFilteredProducts(suggestions as Product[]);
      } catch (e) {
        console.error('Product prediction failed:', e);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [manualItemName]);
  useEffect(() => { const checkLock = async () => { try { const locked = await db.isDateLocked(header.date || ""); setIsDateLockedStatus(locked); } catch (e) { console.error("checkLock failed:", e); } }; checkLock().catch(e => console.error("[usePurchases] checkLock fatal error:", e)); }, [header.date]);
  const isLocked = useMemo(() => { const isWorkflowLocked = InvoiceWorkflowEngine.isLocked(header.status); const isPeriodLocked = isDateLockedStatus && authService.getCurrentUser()?.Role !== 'Admin'; return isWorkflowLocked || isPeriodLocked || hasDependencies; }, [header.status, isDateLockedStatus, hasDependencies]);

  useEffect(() => { const fetchEditingInvoice = async () => { try { if (editingInvoiceId) { const inv: any = await InvoiceRepository.getPurchaseById(editingInvoiceId); if (inv) { setHeader({ invoice_number: inv.invoiceNumber || inv.invoice_number || inv.invoiceId || '', supplierInvoiceNumber: inv.supplierInvoiceNumber || '', supplier_id: inv.partnerId || inv.supplier_id || '', payment_method: inv.status === 'PAID' ? 'Cash' : 'Credit', status: inv.invoiceStatus || inv.status || 'DRAFT', payment_status: inv.payment_status || 'Unpaid', date: inv.date, notes: inv.notes || '', attachment: inv.attachment || '', isReturn: inv.invoiceType === 'مرتجع' }); const normalizedItems = (inv.items || []).map((i: any, idx: number) => ({ ...i, name: i.name || i.productName || i.Name || '', productName: i.productName || i.name || i.Name || '', qty: Number(i.qty ?? i.quantity ?? 0), quantity: Number(i.quantity ?? i.qty ?? 0), price: Number(i.price ?? i.unitPrice ?? 0), unitPrice: Number(i.unitPrice ?? i.price ?? 0), sum: Number(i.sum ?? ((i.qty ?? i.quantity ?? 0) * (i.price ?? i.unitPrice ?? 0))), row_order: i.row_order || idx + 1, expiryDate: normalizeToISODate(i.expiryDate || i.ExpiryDate || i.expiry_date || i.expirationDate || '') })); setItems(normalizedItems); setAdjData({ discountPercent: inv.discountPercent || 0, otherFees: inv.otherFees || 0, tax: inv.tax || 0 }); const deps = await InvoiceRepository.checkHasDependencies(editingInvoiceId, 'PURCHASE'); setHasDependencies(deps); } } else resetInvoiceState(); } catch (e) { console.error("fetchEditingInvoice failed:", e); } }; fetchEditingInvoice().catch(e => console.error("[usePurchases] fetchEditingInvoice fatal error:", e)); }, [editingInvoiceId, resetInvoiceState]);
  useEffect(() => { let timer: NodeJS.Timeout | null = null; if (isLocked && editingInvoiceId) { timer = setTimeout(() => { (async () => { try { await db.updatePurchaseNotes(editingInvoiceId, header.notes); await db.updatePurchaseAttachment(editingInvoiceId, header.attachment || ''); } catch (e) { console.error("Auto-update header failed:", e); } })().catch(e => console.error("[usePurchases] Auto-update header fatal:", e)); }, 1000); } return () => { if (timer) clearTimeout(timer); }; }, [header.notes, header.attachment, isLocked, editingInvoiceId]);

  const draftPromptCheckedRef = useRef(false);
  useEffect(() => {
    if (editingInvoiceId) return;
    const checkDraft = async () => {
      if (draftPromptCheckedRef.current) return;
      draftPromptCheckedRef.current = true;
      try {
        // Failed quarantine is preferred to a debounced autosave because it
        // contains the exact invoice lines captured at the failed save boundary.
        const draftKeys = getPurchaseDraftKeys();
        const recoverable = await DraftService.getRecoverablePurchaseDraft();
        if (recoverable) {
          setRecoveryDraftData(recoverable);
          setIsRecoveryModalOpen(true);
          return;
        }

        const hasSavedDraft = await DraftService.hasDraft(draftKeys.draftId);
        if (hasSavedDraft) {
          const draft = await DraftService.getDraft(draftKeys.draftId);
          if (draft && draft.items && draft.items.length > 0) {
            setRecoveryDraftData(draft as any);
            setIsRecoveryModalOpen(true);
          }
        }
      } catch (err) {
        console.error('Failed to load purchases draft recovery status:', err);
      }
    };
    checkDraft().catch(e => console.error('checkDraft error:', e));
  }, [editingInvoiceId]);

  const restoreDraft = useCallback(async () => {
    if (!recoveryDraftData) {
      setIsRecoveryModalOpen(false);
      return;
    }

    const draftObj: any = recoveryDraftData;
    const draftKeys = getPurchaseDraftKeys();
    // Clear stale item-entry state before restoring the snapshot. Pending products
    // are rehydrated from the snapshot immediately below because they are required
    // for atomic product creation when this invoice is posted.
    currentOperationRef.current = null;
    pendingProductsRef.current = [];
    setFilteredProducts([]);
    setSelectedProduct(null);
    setManualItemName('');
    setSearchTerm('');
    setSelectedIndex(-1);
    setShowSearchDropdown(false);
    const snapshot = getPurchaseDraftSnapshot(draftObj);
    const rawItems = snapshot.items || [];

    const restoredItems = rawItems.map((item: any, idx: number) => ({
      ...item,
      name: item.name || item.productName || item.Name || '',
      productName: item.productName || item.name || item.Name || '',
      qty: Number(item.qty ?? item.quantity ?? 0),
      quantity: Number(item.quantity ?? item.qty ?? 0),
      price: Number(item.price ?? item.unitPrice ?? 0),
      unitPrice: Number(item.unitPrice ?? item.price ?? 0),
      sum: Number(item.sum ?? ((item.qty ?? item.quantity ?? 0) * (item.price ?? item.unitPrice ?? 0))),
      row_order: item.row_order || idx + 1,
      expiryDate: normalizeToISODate(item.expiryDate || item.ExpiryDate || item.expiry_date || item.expirationDate || '')
    }));
    if (snapshot.header) setHeader(snapshot.header as any);
    setItems(restoredItems as any);
    setAdjData(snapshot.adjData as any);
    pendingProductsRef.current = Array.isArray(snapshot.pendingProducts)
      ? snapshot.pendingProducts
      : [];

    const supplierId = String((snapshot.header as any)?.supplier_id || '');
    const supplierName = String(
      snapshot.partner?.partnerName ||
      suppliers.find((supplier: any) => supplier.id === supplierId || supplier.Supplier_ID === supplierId)?.Supplier_Name ||
      ''
    );
    setSupplierSearchTerm(supplierName);

    // Reset the item-entry search surface; the restored invoice rows remain intact.
    setManualItemName('');
    setFilteredProducts([]);
    setSelectedProduct(null);
    setSearchTerm('');
    setShowSearchDropdown(false);

    if (draftObj.status === 'FAILED_QUARANTINED' && draftObj.draftId) {
      try {
        // Materialize the restored snapshot as the active draft before marking
        // the forensic quarantine as recovered. This avoids falling back to a
        // stale pre-failure autosave if the user closes the app immediately.
        const restoredSubtotal = restoredItems.reduce(
          (sum: number, item: any) => sum + Number(item.qty || 0) * Number(item.price || 0),
          0
        );
        await DraftService.saveInvoiceDraft(draftKeys.invoiceDraftId, 'PURCHASE', restoredItems, {
          header: snapshot.header,
          adjData: snapshot.adjData,
          subtotal: restoredSubtotal,
          partner: snapshot.partner,
          pendingProducts: snapshot.pendingProducts
        });
        const activeDraft = await DraftService.getInvoiceDraft(draftKeys.invoiceDraftId);
        const activeTotals = activeDraft?.totals || {};
        if (
          !activeDraft ||
          JSON.stringify(activeDraft.items || []) !== JSON.stringify(restoredItems) ||
          JSON.stringify(activeTotals.header || null) !== JSON.stringify(snapshot.header) ||
          JSON.stringify(activeTotals.adjData || {}) !== JSON.stringify(snapshot.adjData) ||
          JSON.stringify(activeTotals.partner || null) !== JSON.stringify(snapshot.partner) ||
          JSON.stringify(activeTotals.pendingProducts || []) !== JSON.stringify(snapshot.pendingProducts)
        ) {
          throw new Error('PURCHASE_DRAFT_RESTORE_VERIFY_FAILED');
        }
        await DraftService.markInvoiceDraftRecovered(draftObj.draftId);
      } catch (recoveryMarkerError) {
        console.warn('[usePurchases] Failed to finalize recovered purchase draft:', recoveryMarkerError);
        addToast('تمت استعادة الأصناف، لكن تعذر تحديث نسخة المسودة النشطة؛ بقيت نسخة الاسترداد محفوظة.', 'warning');
      }
    }

    addToast('تمت استعادة مسودة المشتريات وأصنافها بنجاح 💾', 'success');
    setIsRecoveryModalOpen(false);
    setRecoveryDraftData(null);
  }, [recoveryDraftData, addToast, suppliers]);
  const discardDraft = useCallback(async () => {
    let draftKeys: ReturnType<typeof getPurchaseDraftKeys> | null = null;
    try {
      draftKeys = getPurchaseDraftKeys();
      await discardPurchaseDrafts({
        clearAllFailedPurchaseDrafts: () => DraftService.clearAllFailedPurchaseDrafts(),
        clearRecoveryInvoiceDraft: async () => {
          const recoveryDraftId = (recoveryDraftData as any)?.draftId;
          if (recoveryDraftId) await DraftService.clearInvoiceDraft(recoveryDraftId);
        },
        clearDraft: () => DraftService.clearDraft(draftKeys!.draftId),
        getUnfinishedInvoiceDraft: () => DraftService.getUnfinishedInvoiceDraft('PURCHASE'),
        clearInvoiceDraft: (draftId: string) => DraftService.clearInvoiceDraft(draftId),
        onSuccess: () => {
          pendingProductsRef.current = [];
          resetInvoiceState();
          setRecoveryDraftData(null);
          addToast("تم حذف جميع مسودات المشتريات بنجاح وبدء قيد جديد", "success");
        },
        onFailure: async (error: unknown) => {
          console.error("discardDraft failed:", error);
          await writeDiagnosticLog(db, error, {
            operation: 'PURCHASE_DISCARD_DRAFT',
            tenantId: draftKeys?.tenantId,
            context: {
              branchId: draftKeys?.branchId,
              recoveryDraftId: (recoveryDraftData as any)?.draftId || null
            }
          });
          addToast("تعذر حذف جميع المسودات. حاول مرة أخرى.", "error");
        }
      });
    } catch (error) {
      console.error("discardDraft failed before cleanup:", error);
      await writeDiagnosticLog(db, error, {
        operation: 'PURCHASE_DISCARD_DRAFT',
        tenantId: draftKeys?.tenantId,
        context: { branchId: draftKeys?.branchId }
      });
      addToast("تعذر حذف جميع المسودات. حاول مرة أخرى.", "error");
    }
  }, [addToast, resetInvoiceState, recoveryDraftData]);

  const handleSupplierSearch = useCallback((val: string) => { setSupplierSearchTerm(val); setShowSupplierDropdown(true); setSelectedSupplierIndex(-1); }, []);
  const handleSupplierKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedSupplierIndex(prev => Math.min(prev + 1, filteredSuppliers.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedSupplierIndex(prev => Math.max(prev - 1, -1)); } else if (e.key === 'Enter') { if (selectedSupplierIndex >= 0 && filteredSuppliers[selectedSupplierIndex]) { e.preventDefault(); selectSupplier(filteredSuppliers[selectedSupplierIndex]); } } else if (e.key === 'Escape') { setShowSupplierDropdown(false); setSelectedSupplierIndex(-1); } }, [filteredSuppliers, selectedSupplierIndex]);
  const selectSupplier = useCallback((s: Supplier) => { setHeader(prev => ({ ...prev, supplier_id: s.id, supplierInvoiceNumber: prev.supplier_id && prev.supplier_id !== s.id ? '' : prev.supplierInvoiceNumber })); setSupplierSearchTerm(s.Supplier_Name || s.name || ''); setShowSupplierDropdown(false); showNotification(`رصيد المورد الحالي للفاتورة: ${(s.balance || 0).toLocaleString()} ${currency}`, 'info'); }, [showNotification, currency]);
  const handleSupplierBlur = useCallback(() => { setTimeout(async () => { setShowSupplierDropdown(false); if (supplierSearchTerm) { try { const allDBSuppliers = await db.suppliers.toArray(); const activeSuppliers = allDBSuppliers.filter(s => s.Is_Active === true || s.Is_Active === 1 || String(s.Is_Active) === "true" || s.Is_Active === undefined); const exactMatch = activeSuppliers.find(s => s.Supplier_Name === supplierSearchTerm || s.name === supplierSearchTerm); if (!exactMatch) { const similarSupplier = activeSuppliers.find(s => { const sName = (s.Supplier_Name || s.name || '').toLowerCase(); const tName = supplierSearchTerm.toLowerCase(); return sName.includes(tName) || tName.includes(sName); }); if (similarSupplier) { if (window.confirm(`هل تقصد [${similarSupplier.Supplier_Name || similarSupplier.name}]؟`)) { selectSupplier(similarSupplier); return; } } setNewSupplierName(supplierSearchTerm); setIsAddSupplierModalOpen(true); } else selectSupplier(exactMatch); } catch (error) { console.error("Checking DB for supplier failed", error); } } }, 200); }, [supplierSearchTerm, selectSupplier]);
  const confirmAddSupplier = useCallback(async () => { try { const newId = `SUP-${Date.now()}`; const newSup: Supplier = { id: newId, Supplier_ID: newId, Supplier_Name: newSupplierName, Phone: '', Address: '', balance: 0, openingBalance: 0, Is_Active: true, Created_At: new Date().toISOString() }; await db.saveSupplier(newSup); await refreshGlobal(); setHeader(prev => ({ ...prev, supplier_id: newId, supplierInvoiceNumber: prev.supplier_id && prev.supplier_id !== newId ? '' : prev.supplierInvoiceNumber })); setSupplierSearchTerm(newSupplierName); setIsAddSupplierModalOpen(false); addToast(`تم إضافة المورد ${newSupplierName} بنجاح`, "success"); } catch (error) { console.error("Failed to add supplier", error); addToast("فشل في إضافة المورد", "error"); } }, [newSupplierName, refreshGlobal, addToast]);
  const cancelAddSupplier = useCallback(() => { setIsAddSupplierModalOpen(false); setSupplierSearchTerm(''); setHeader(prev => ({ ...prev, supplier_id: '' })); }, []);
  const safeNavigate = useCallback((path: string) => { try { onNavigate?.(path); } catch (error) { console.error("Navigation failed, falling back to window.location", error); window.location.hash = path; } }, [onNavigate]);
  const importAbortControllerRef = useRef<AbortController | null>(null);
  const cancelSmartImport = useCallback(() => { if (importAbortControllerRef.current) { importAbortControllerRef.current.abort(); importAbortControllerRef.current = null; } setIsProcessingAI(false); setShowAIConfirmModal(false); addToast("تم إلغاء عملية الاستيراد الذكي", "info"); }, [addToast]);

  const handleAIImport = async (file: File | string) => { if (importAbortControllerRef.current) importAbortControllerRef.current.abort(); const abortController = new AbortController(); importAbortControllerRef.current = abortController; setIsProcessingAI(true); setImportProgressPercent(10); setImportProgressStage('DETECTING_SOURCE'); setImportProgressMessage('جاري فحص مصدر وصيغة المستند...'); setShowAIConfirmModal(true); try { const user = authService.getCurrentUser(); const analysis = await SmartImportOrchestrator.analyzeInvoice(file, { tenantId: (user as any)?.tenantId, branchId: (user as any)?.branchId, abortSignal: abortController.signal, onProgress: (stage, percent, message) => { setImportProgressStage(stage); setImportProgressPercent(percent); setImportProgressMessage(message); } }); setSmartAnalysisResult(analysis); setAIParsedData({ invoice_number: analysis.summary.detectedInvoiceNumber, supplier: analysis.summary.detectedSupplier, notes: analysis.rawText, items: analysis.rows.map(r => ({ name: r.productName, quantity: r.quantity, price: r.unitPrice, discountPercent: r.discountPercent, barcode: r.barcode, bonusQty: r.bonusQty, batchNumber: r.batchNumber, notes: r.notes, product_id: r.matchedProductId, expiryDate: r.expiryDate })) }); if (typeof file === 'string') setHeader(prev => ({ ...prev, attachment: file })); else { const reader = new FileReader(); const base64 = await new Promise<string>((resolve) => { reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(file); }); setHeader(prev => ({ ...prev, attachment: base64 })); } setIsProcessingAI(false); } catch (error: any) { if (error?.name === 'AbortError') { console.log('[SMART IMPORT] Import was cancelled by user.'); setIsProcessingAI(false); return; } console.error("[SMART IMPORT ERROR]:", error); addToast(`❌ تعذر استيراد الفاتورة: ${error.message || 'خطأ غير متوقع'}`, "error"); setIsProcessingAI(false); setShowAIConfirmModal(false); } finally { if (importAbortControllerRef.current === abortController) importAbortControllerRef.current = null; } };

  const applySmartImportData = useCallback((approvedRows: ExtractedImportRow[], detectedSupplier?: string, detectedInvoiceNumber?: string, detectedDate?: string) => { if (!approvedRows || approvedRows.length === 0) { addToast("لا توجد أصناف معتمدة للتطبيق", "warning"); return { convertedItems: [], matchedSupplierId: header.supplier_id, invoiceNumber: header.invoice_number, supplierInvoiceNumber: header.supplierInvoiceNumber }; } const supplierInvoiceNumber = normalizeSupplierInvoiceNumber(detectedInvoiceNumber || header.supplierInvoiceNumber || ''); const invoiceNumber = header.invoice_number || db.generateId('PURCH'); const convertedItems = SmartImportOrchestrator.convertToInvoiceItems(approvedRows, invoiceNumber); let matchedSupplierId = header.supplier_id; if (detectedSupplier) { const match = suppliers?.find(s => s.Supplier_Name?.toLowerCase().includes(detectedSupplier.toLowerCase()) || detectedSupplier.toLowerCase().includes((s.Supplier_Name || '').toLowerCase())); if (match) { matchedSupplierId = match.id || match.Supplier_ID || ''; setSupplierSearchTerm(match.Supplier_Name || ''); } } setItems(convertedItems); setHeader(prev => ({ ...prev, invoice_number: invoiceNumber, supplierInvoiceNumber, supplier_id: matchedSupplierId || prev.supplier_id, date: detectedDate || prev.date, status: 'DRAFT' })); setHasUnsavedAI(true); setShowAIConfirmModal(false); addToast(`✅ تم استيراد ${convertedItems.length} صنف إلى الفاتورة بنجاح للمراجعة والحفظ`, "success"); return { convertedItems, matchedSupplierId, invoiceNumber, supplierInvoiceNumber }; }, [header.invoice_number, header.supplierInvoiceNumber, header.supplier_id, suppliers, addToast]);

  const applyAIParsedData = async () => { if (!aiParsedData) return; if (!aiParsedData.items || aiParsedData.items.length === 0) { addToast("لم يتم التعرف على بيانات الفاتورة", "warning"); setIsProcessingAI(false); return; } const cleanedItems = (aiParsedData.items || []).filter(i => i.name && i.quantity && i.price); if (!cleanedItems.length) { addToast("❌ فشل تحليل الفاتورة في استخراج أصناف صالحة", "error"); setIsProcessingAI(false); return; } const matchedSupplier = suppliers?.find(s => s.Supplier_Name?.toLowerCase().includes((aiParsedData.supplier || '').toLowerCase()) || (aiParsedData.supplier || '').toLowerCase().includes((s.Supplier_Name || '').toLowerCase())); const matchedSupplierId = matchedSupplier ? (matchedSupplier.id || matchedSupplier.Supplier_ID) : (suppliers?.[0]?.id || ''); const internalInvoiceNumber = header.invoice_number || db.generateId('PURCH'); const mappedItems: any[] = cleanedItems.map((item, idx) => { const q = Number(item.quantity || 1); const p = Number(item.price || 0); const disc = Number(item.discountPercent || 0); const sub = q * p; const finalSum = disc > 0 ? sub * (1 - disc / 100) : sub; const notesParts = [item.barcode ? `باركود: ${item.barcode}` : '', item.bonusQty ? `بونص: +${item.bonusQty}` : '', item.batchNumber ? `تشغيلة: ${item.batchNumber}` : '', item.notes || ''].filter(Boolean); return { id: `PUR-DET-${Date.now()}-${idx}`, parent_id: internalInvoiceNumber, product_id: item.product_id || `manual-${Date.now()}-${idx}`, productId: item.product_id || `manual-${Date.now()}-${idx}`, productName: item.name || '', name: item.name || '', quantity: q, qty: q, unitPrice: p, price: p, subtotal: finalSum, sum: finalSum, discount_val: disc, row_order: idx + 1, expiryDate: normalizeToISODate(item.expiryDate || (item as any).ExpiryDate || (item as any).expiry_date || ''), notes: notesParts.join(' | '), category: item.categoryId || '' }; }); setItems(mappedItems as any); setHeader(prev => ({ ...prev, invoice_number: internalInvoiceNumber, supplierInvoiceNumber: normalizeSupplierInvoiceNumber(aiParsedData.invoice_number || prev.supplierInvoiceNumber || ''), supplier_id: matchedSupplierId || prev.supplier_id || '', isReturn: aiParsedData.type === 'return', notes: aiParsedData.notes || prev.notes, status: 'DRAFT' as const })); setHasUnsavedAI(true); setIsProcessingAI(false); setShowAIConfirmModal(false); addToast("📝 تم تعبئة شاشة المراجعة الوسيطة بنجاح! يرجى التدقيق يدوياً والموافقة لحفظ الفاتورة المحاسبية 💾", "success"); };

  const vTotalSum = useMemo(() => { const subtotal = items.reduce((sum, item) => sum + (item.qty * item.price), 0); const discount = subtotal * (adjData.discountPercent / 100); return subtotal - discount + adjData.otherFees + adjData.tax; }, [items, adjData]);
  const prevItemsRef = useRef<InvoiceItem[]>(items); const prevSupplierIdRef = useRef<string>(header.supplier_id); const prevNotesRef = useRef<string>(header.notes); const prevAdjDataRef = useRef<{ discountPercent: number; otherFees: number; tax: number }>(adjData);
  useEffect(() => { if (savePhase === 'failed' || editingInvoiceId) return; if (items.length === 0 && !header.supplier_id && !header.notes && !header.supplierInvoiceNumber) return; const itemsChanged = JSON.stringify(items) !== JSON.stringify(prevItemsRef.current); const supplierChanged = header.supplier_id !== prevSupplierIdRef.current; const supplierInvoiceNumberChanged = header.supplierInvoiceNumber !== prevSupplierInvoiceNumberRef.current; const notesChanged = header.notes !== prevNotesRef.current; const adjChanged = JSON.stringify(adjData) !== JSON.stringify(prevAdjDataRef.current); if (itemsChanged || supplierChanged || supplierInvoiceNumberChanged || notesChanged || adjChanged) { prevItemsRef.current = items; prevSupplierIdRef.current = header.supplier_id; prevSupplierInvoiceNumberRef.current = header.supplierInvoiceNumber || ''; prevNotesRef.current = header.notes; prevAdjDataRef.current = adjData; const timer = setTimeout(async () => { try { const partner = suppliers.find(s => s.id === header.supplier_id); const partnerName = partner ? partner.Supplier_Name : ''; await DraftService.saveInvoiceDraft(getPurchaseDraftKeys().invoiceDraftId, 'PURCHASE', items, { adjData, subtotal: vTotalSum, header, partner: { partnerName }, pendingProducts: JSON.parse(JSON.stringify(pendingProductsRef.current)) }); } catch (e) { console.error("Debounced auto-save failed:", e); } }, 1000); return () => clearTimeout(timer); } return undefined; }, [items, header, adjData, vTotalSum, editingInvoiceId, suppliers, savePhase]);

  const selectProduct = useCallback((p: Product) => { setSelectedProduct(p); setManualItemName(p.Name || ''); setTempPrice(p.LastPurchasePrice || p.CostPrice || ''); setTempQty(1); if (p.StockQuantity !== undefined) addToast(`المخزون الحالي: ${p.StockQuantity}`, "info"); if (p.LastPurchasePrice) addToast(`آخر سعر شراء: ${p.LastPurchasePrice} ${currency}`, "info"); setSearchTerm(''); setShowSearchDropdown(false); setSelectedIndex(-1); qtyInputRef.current?.focus(); }, [addToast, currency]);
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(prev => Math.min(prev + 1, filteredProducts.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(prev => Math.max(prev - 1, -1)); } else if (e.key === 'Enter') { if (selectedIndex >= 0) { e.preventDefault(); const prod = filteredProducts[selectedIndex]; if (prod) selectProduct(prod); } else if (manualItemName) { e.preventDefault(); qtyInputRef.current?.focus(); } } else if (e.key === 'Escape') { setShowSearchDropdown(false); setSelectedIndex(-1); } }, [filteredProducts, selectedIndex, selectProduct, manualItemName]);
  const finalizeItemAdd = useCallback(() => { if (!manualItemName || !tempQty || !tempPrice) { addToast("يرجى إكمال بيانات الصنف", "error"); return; } const newItem: InvoiceItem = { id: `PUR-DET-${Date.now()}`, parent_id: header.invoice_number, product_id: selectedProduct?.id || `manual-${Date.now()}`, productId: selectedProduct?.id || `manual-${Date.now()}`, productName: manualItemName, name: manualItemName, quantity: Number(tempQty), qty: Number(tempQty), unitPrice: Number(tempPrice), price: Number(tempPrice), subtotal: Number(tempQty) * Number(tempPrice), sum: Number(tempQty) * Number(tempPrice), row_order: items.length + 1, expiryDate: normalizeToISODate(tempExpiry), notes: tempNote, category: selectedCategoryId || selectedProduct?.categoryId }; setItems(prev => [...prev, newItem]); setSelectedProduct(null); setManualItemName(''); setTempQty(''); setTempPrice(''); setTempExpiry(''); setTempNote(''); setSelectedCategoryId(''); setManualCategoryName(''); setShowCategoryDropdown(false); itemNameInputRef.current?.focus(); addToast("تمت إضافة الصنف ✅", "success"); }, [manualItemName, tempQty, tempPrice, header.invoice_number, selectedProduct, items.length, tempExpiry, tempNote, selectedCategoryId, addToast]);

  const handlePost = useCallback(async (overridePayload?: { items?: InvoiceItem[]; header?: typeof header; adjData?: typeof adjData }) => {
    if (isSavingRef.current || savePhase === 'saving') return;
    const currentItems = overridePayload?.items || items;
    const currentHeader = overridePayload?.header || header;
    const currentAdjData = overridePayload?.adjData || adjData;
    if (!currentHeader.supplier_id) { addToast("يرجى اختيار المورد", "error"); return; }
    if (!currentHeader.isReturn && (!editingInvoiceId || currentHeader.status === 'DRAFT') && !normalizeSupplierInvoiceNumber(currentHeader.supplierInvoiceNumber)) { addToast("يرجى إدخال رقم فاتورة المورد", "error"); return; }
    if (currentItems.length === 0) { addToast("الفاتورة فارغة", "error"); return; }
    const subtotal = currentItems.reduce((sum: number, item: any) => sum + (item.qty * item.price), 0);
    const discount = subtotal * (currentAdjData.discountPercent / 100);
    const currentTotal = subtotal - discount + currentAdjData.otherFees + currentAdjData.tax;
    isSavingRef.current = true;
    showNotification('⌛ جاري حفظ الفاتورة وتحديث المستودع...', 'info');
    addToast("جاري الحفظ والمزامنة... ⏳", "info");
    setIsSaving(true);
    setSavePhase('saving');
    let purchaseDraftKeys: ReturnType<typeof getPurchaseDraftKeys> | null = null;
    let itemsForSave: InvoiceItem[] = currentItems;
    try {
      purchaseDraftKeys = getPurchaseDraftKeys();
      if (aiParsedData) {
        const originalSupplier = aiParsedData.supplier;
        const finalSupplier = suppliers.find(s => s.id === currentHeader.supplier_id)?.Supplier_Name;
        if (originalSupplier && finalSupplier && originalSupplier !== finalSupplier) saveLearning(originalSupplier, finalSupplier || '');
        (aiParsedData.items || []).forEach(aiItem => { const finalItem = currentItems.find(i => i.qty === aiItem.quantity && i.price === aiItem.price); if (finalItem && aiItem.name !== finalItem.name && aiItem.name) saveLearning(aiItem.name, finalItem.name || ''); });
      }
      if (!currentOperationRef.current) { currentOperationRef.current = generateTransactionUuid('PURCHASE'); }
      const requestUuid = currentOperationRef.current;
      const preparedProducts = collectPendingProductsForInvoice(
        currentItems,
        pendingProductsRef.current
      );
      pendingProductsRef.current = preparedProducts.pendingProducts;
      // Preserve the exact normalized lines submitted to addInvoice for quarantine/retry.
      itemsForSave = preparedProducts.items.map((item: InvoiceItem) => ({
        ...item,
        expiryDate: normalizeToISODate(item.expiryDate || (item as any).ExpiryDate || (item as any).expiry_date || (item as any).expirationDate || '')
      })) as InvoiceItem[];
      setItems(itemsForSave);

      // تنفيذ الحفظ المحلي مباشرة (بدون Promise.race أو مهلة زمنية)
      const res = await addInvoice({
        type: 'PURCHASE',
        payload: {
          supplierId: currentHeader.supplier_id,
          items: itemsForSave,
          total: currentTotal,
          invoiceId: currentHeader.invoice_number,
          invoiceNumber: currentHeader.invoice_number,
          supplierInvoiceNumber: normalizeSupplierInvoiceNumber(currentHeader.supplierInvoiceNumber) || null,
          id: editingInvoiceId || undefined,
          notes: currentHeader.notes,
          attachment: currentHeader.attachment,
          date: currentHeader.date,
          transactionUuid: requestUuid,
          discountPercent: currentAdjData.discountPercent,
          otherFees: currentAdjData.otherFees,
          tax: currentAdjData.tax,
          pendingProducts: pendingProductsRef.current
        },
        options: {
          isCash: currentHeader.payment_method === 'Cash',
          paymentStatus: currentHeader.payment_method === 'Cash' ? 'Cash' : 'Credit',
          invoiceStatus: 'POSTED',
          isReturn: !!currentHeader.isReturn,
          currency,
          date: currentHeader.date,
          isEdit: !!editingInvoiceId
        }
      }) as { success: boolean; refId?: string; invoiceNumber?: string; syncStatus?: 'ENQUEUED' | 'SYNCED' | 'FAILED' | 'LOCAL_ONLY' };

      if (res?.success) {
        const savedInvoiceNumber = getSavedPurchaseInvoiceNumber({ invoiceNumber: res.invoiceNumber }, currentHeader.invoice_number);
        const savedInvoiceId = res.refId || editingInvoiceId || savedInvoiceNumber;
        setSavePhase('idle');
        // Local persistence has succeeded. Post-commit UI work must never report save failure.
        showNotification("Invoice Saved Successfully\nReturning to Dashboard...", 'success', 1000);
        addToast("Invoice Saved Successfully\nReturning to Dashboard...", "success");

        const postCommitWarnings: string[] = [];
        const runPostCommitTask = async (name: string, task: () => Promise<unknown> | unknown) => {
          try {
            await task();
          } catch (postCommitError) {
            console.warn(`[usePurchases] Post-commit task failed (${name}):`, postCommitError);
            postCommitWarnings.push(name);
          }
        };

        // Invalidate cached report values immediately, but defer refresh/provider
        // work so a successful invoice never waits on report processing.
        reportCache.purge();
        db.incrementDataVersion();
        ReportEngine.scheduleRefreshInBackground();
        setTimeout(() => {
          void Promise.resolve()
            .then(() => refreshGlobal())
            .catch((refreshError: unknown) => {
              console.warn('[usePurchases] Background provider refresh failed:', refreshError);
            });
        }, 0);
        configurationService.set(purchaseDraftKeys!.configKey, null).catch(() => {});
        setHasUnsavedAI(false);
        await runPostCommitTask('audit-log', () =>
          auditLogService.log({ table: 'purchases', action: 'PURCHASE', entityId: savedInvoiceId, newData: { items: currentItems, total: currentTotal, invoiceNumber: savedInvoiceNumber, supplierInvoiceNumber: normalizeSupplierInvoiceNumber(currentHeader.supplierInvoiceNumber) || null }, details: getPurchaseAuditDetails(savedInvoiceNumber, !!currentHeader.isReturn) })
        );
        const supplier = suppliers.find(s => s.id === currentHeader.supplier_id);
        const supplierName = supplier ? supplier.Supplier_Name : 'مورد غير محدد';
        await runPostCommitTask('draft-cleanup', async () => {
          await DraftService.clearInvoiceDraft(purchaseDraftKeys!.invoiceDraftId);
          await DraftService.clearDraft(purchaseDraftKeys!.draftId);
        });

        if (res.syncStatus === 'FAILED') {
          showNotification('تم حفظ الفاتورة محلياً، لكن فشلت المزامنة. ستتم المحاولة لاحقاً.', 'warning');
        } else if (postCommitWarnings.length > 0) {
          showNotification('تم حفظ الفاتورة، لكن بعض تحديثات ما بعد الحفظ لم تكتمل.', 'warning');
        }
        setSaveSuccessData({ invoiceNumber: savedInvoiceNumber, totalAmount: currentTotal, type: 'PURCHASE', date: currentHeader.date, partnerName: supplierName, accountingStatus: 'قيد ذمم دائنة مرحل وتلقائي', inventoryStatus: 'قيد المخزون المتاح والوجبات المدخلة', balanceStatus: 'معدل ومرحل لحساب المورد' });
        resetInvoiceState();
        setTimeout(() => { try { onNavigate?.('dashboard'); } catch (error) { window.location.hash = '#/dashboard'; } }, 1000);
      }
    } catch (error: unknown) {
      await writeDiagnosticLog(db, error, {
        operation: 'PURCHASE_SAVE',
        context: {
          invoiceNumber: currentHeader.invoice_number,
          invoiceId: editingInvoiceId || undefined,
          operationId: currentOperationRef.current || undefined,
          itemCount: currentItems.length
        }
      });
      const failureOperationId = currentOperationRef.current || generateTransactionUuid('PURCHASE_FAILED');
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = rawErrorMessage.match(/[A-Z][A-Z0-9_]{3,}/)?.[0] || 'PURCHASE_SAVE_FAILED';
      const currentUser = authService.getCurrentUser();
      const tenantId = currentUser?.tenantId || (currentUser as any)?.tenant_id || purchaseDraftKeys?.tenantId;
      const normalized = ErrorManager.handleError(error, { module: 'PURCHASES', action: 'SAVE_PURCHASE', showToast: false });

      // If the registry cannot be read, the operation outcome is unknown.
      // Do not quarantine, clear artifacts, reset the form, or rotate its key.
      if (!tenantId || !purchaseDraftKeys) {
        setSavePhase('failed');
        showNotification('تعذر التحقق من سياق المؤسسة وحالة العملية. احتفظ بالفاتورة الحالية ولا تنشئ بديلاً.', 'error');
        addToast(normalized.arabicMessage, 'error');
        return;
      }
      let idempotencyRecord: IdempotencyRecord | null = null;
      try {
        idempotencyRecord = await IdempotencyRegistry.get(failureOperationId, tenantId);
      } catch (registryReadError) {
        console.error('[usePurchases] Idempotency state could not be read; preserving the unresolved operation:', registryReadError);
        setSavePhase('failed');
        showNotification('تعذر التحقق من نتيجة الحفظ. احتفظ بالفاتورة ومفتاح العملية ولا تعِد إنشاءها.', 'error');
        addToast(normalized.arabicMessage, 'error');
        return;
      }
      const disposition = getPurchaseFailureDisposition(idempotencyRecord?.status || null);

      // A committed transaction must never be treated as a failed invoice.
      // Preserve the idempotency key until active-draft cleanup succeeds.
      if (disposition === 'COMMITTED') {
        try {
          await DraftService.clearInvoiceDraft(purchaseDraftKeys!.invoiceDraftId);
          await DraftService.clearDraft(purchaseDraftKeys!.draftId);
          await configurationService.set(purchaseDraftKeys!.configKey, null);
          // Keep the committed operation key and pending-product snapshot intact.
          // The component may retry/reconcile this same operation, but must not
          // silently turn a committed transaction into a new operation.
          setSavePhase('failed');
          showNotification('تم اعتماد الفاتورة بالفعل. احتفظنا بمفتاح العملية لمنع إعادة ترحيلها.', 'success');
          addToast('تم حفظ الفاتورة بنجاح؛ لا تنشئ فاتورة بديلة قبل مغادرة هذه الشاشة.', 'success');
        } catch (cleanupError) {
          console.error('[usePurchases] Committed invoice draft cleanup failed:', cleanupError);
          setSavePhase('failed');
          showNotification('الفاتورة معتمدة بالفعل. لا تنشئ فاتورة بديلة؛ أعد المحاولة بنفس الفاتورة.', 'error');
          addToast(normalized.arabicMessage, 'error');
        }
        return;
      }

      // PROCESSING is an unresolved operation: keep the same form and
      // idempotency key so a retry/replay cannot create a duplicate purchase.
      if (disposition === 'PENDING') {
        setSavePhase('failed');
        showNotification('نتيجة الحفظ لم تُحسم بعد. لا تنشئ فاتورة جديدة؛ احتفظ بهذه المحاولة وأعد التحقق.', 'error');
        addToast(normalized.arabicMessage, 'error');
        return;
      }

      let failedInvoiceQuarantined = false;
      let failedOperationArtifactsCleaned = false;
      let activeDraftCleanupComplete = false;

      // The workflow rolls back domain writes before returning QUARANTINE. Remove
      // only sync/idempotency artifacts proven to belong to this failed tenant-scoped
      // operation; COMMITTED and PROCESSING paths returned above are untouched.
      try {
        await cleanupFailedPurchaseOperation(failureOperationId, tenantId);
        failedOperationArtifactsCleaned = true;
      } catch (operationCleanupError) {
        console.error('[usePurchases] Failed operation artifact cleanup failed:', operationCleanupError);
      }

      // Persist and verify the forensic copy first. Cleanup is a separate stage:
      // a cleanup failure must not be misreported as a quarantine-write failure.
      const failedDraft = buildFailedPurchaseDraft({
        operationId: failureOperationId,
        header: currentHeader as any,
        items: itemsForSave,
        adjData: currentAdjData,
        errorCode
      });
      const failedSupplier = suppliers.find((supplier: any) =>
        supplier.id === currentHeader.supplier_id || supplier.Supplier_ID === currentHeader.supplier_id
      );
      (failedDraft as any).partner = {
        partnerName: failedSupplier?.Supplier_Name || failedSupplier?.name || ''
      };
      (failedDraft as any).pendingProducts = JSON.parse(JSON.stringify(pendingProductsRef.current));
      (failedDraft as any).tenantId = purchaseDraftKeys!.tenantId;
      (failedDraft as any).branchId = purchaseDraftKeys!.branchId;

      try {
        await DraftService.quarantineInvoiceDraft(failedDraft);
        const verifiedQuarantine = await DraftService.getInvoiceDraft(failedDraft.draftId);
        if (!verifiedQuarantine || verifiedQuarantine.status !== 'FAILED_QUARANTINED') {
          throw new Error('FAILED_PURCHASE_QUARANTINE_VERIFY_FAILED');
        }
        failedInvoiceQuarantined = true;
      } catch (quarantineError) {
        console.error('[usePurchases] Failed purchase quarantine write/verification failed:', quarantineError);
      }

      if (failedInvoiceQuarantined) {
        // The verified quarantine is the durable recovery source. Only active
        // invoice/general draft deletion is required before resetting the form.
        const cleanupResult = await cleanupFailedPurchaseDrafts({
          clearInvoiceDraft: () => DraftService.clearInvoiceDraft(purchaseDraftKeys!.invoiceDraftId),
          clearDraft: () => DraftService.clearDraft(purchaseDraftKeys!.draftId),
          // This legacy config key is not a recovery source. Remove it best-effort;
          // its absence or a permission/registry failure must not block safe reset.
          clearOptionalConfig: () => configurationService.remove(purchaseDraftKeys!.configKey)
        });
        activeDraftCleanupComplete = cleanupResult.activeDraftCleanupComplete;

        if (!activeDraftCleanupComplete) {
          console.error(
            '[usePurchases] Quarantine was saved, but required active draft cleanup failed:',
            cleanupResult.requiredCleanupResults
          );
        }

        if (cleanupResult.optionalConfigCleanup.status === 'rejected') {
          console.warn(
            '[usePurchases] Optional purchase config cleanup failed; verified quarantine and required draft cleanup remain authoritative:',
            cleanupResult.optionalConfigCleanup.reason
          );
          await writeDiagnosticLog(db, cleanupResult.optionalConfigCleanup.reason, {
            operation: 'PURCHASE_OPTIONAL_CONFIG_CLEANUP',
            tenantId,
            context: {
              configKey: purchaseDraftKeys!.configKey,
              invoiceNumber: currentHeader.invoice_number,
              operationId: failureOperationId
            }
          });
        }
      }

      // A persisted quarantine permits UI reset even if the stale active-draft
      // cleanup failed. However, if operation artifacts could not be isolated,
      // retain the form and operation key to prevent an unsafe retry.
      const failedInvoiceIsolated = canResetAfterFailedPurchase({
        quarantinePersisted: failedInvoiceQuarantined,
        operationArtifactsCleaned: failedOperationArtifactsCleaned,
        activeDraftCleanupComplete
      });

      if (failedInvoiceIsolated) {
        currentOperationRef.current = null;
        pendingProductsRef.current = [];
        resetInvoiceState();
        setFilteredProducts([]);
        setSelectedProduct(null);
        setManualItemName('');
        setShowSearchDropdown(false);
      } else {
        // Do not discard in-memory invoice data if its quarantine/cleanup failed.
        setSavePhase('failed');
      }

      showNotification(
        failedInvoiceIsolated
          ? '❌ تعذر حفظ فاتورة المشتريات. تم عزل بيانات المحاولة الفاشلة وتنظيف المسودة النشطة.'
          : failedInvoiceQuarantined && failedOperationArtifactsCleaned && !activeDraftCleanupComplete
            ? 'تم حفظ نسخة العزل وتنظيف آثار العملية، لكن تعذر تنظيف المسودة النشطة؛ أبقينا بيانات الفاتورة ومفتاح العملية كما هما لمنع فقدانها أو إنشاء مستند مكرر.'
            : failedInvoiceQuarantined
              ? 'تم حفظ نسخة العزل، لكن تعذر تنظيف آثار العملية؛ بقيت بيانات النموذج لمنع إعادة المحاولة غير الآمنة.'
              : 'تعذر حفظ الفاتورة وفشل حفظ نسخة العزل؛ بقيت البيانات الحالية محفوظة للمحاولة الآمنة.',
        'error'
      );
      addToast(getPurchaseSaveFailureMessage(error) || normalized.arabicMessage, 'error');
    } finally { isSavingRef.current = false; setIsSaving(false); }
  }, [header, items, aiParsedData, suppliers, vTotalSum, editingInvoiceId, currency, addInvoice, addToast, refreshGlobal, onNavigate, showNotification, savePhase]);

  const handleExport = () => { /* Implementation for export */ };
  const applyAndSaveSmartImport = useCallback(async (approvedRows: ExtractedImportRow[], detectedSupplier?: string, detectedInvoiceNumber?: string, detectedDate?: string) => { const result = applySmartImportData(approvedRows, detectedSupplier, detectedInvoiceNumber, detectedDate); if (!result || !result.convertedItems || result.convertedItems.length === 0) return; const newHeader = { ...header, invoice_number: result.invoiceNumber, supplierInvoiceNumber: result.supplierInvoiceNumber, supplier_id: result.matchedSupplierId || header.supplier_id, date: detectedDate || header.date, status: 'DRAFT' as const }; await handlePost({ items: result.convertedItems, header: newHeader, adjData }); }, [applySmartImportData, handlePost, header, adjData]);
  const printData = { invoiceId: header.invoice_number, title: header.isReturn ? "فاتورة مرتجع مشتريات" : "فاتورة مشتريات", invoiceNumber: header.invoice_number, date: header.date, customerName: suppliers.find(s => s.id === header.supplier_id)?.Supplier_Name || 'مورد عام', items: items.map(i => ({ name: i.name, qty: i.qty, price: i.price, total: i.sum })), total: vTotalSum, currency };
  return { items, setItems, searchTerm, setSearchTerm, isSaving, hasDependencies, isAdjustmentsOpen, setIsAdjustmentsOpen, isCameraOpen, setIsCameraOpen, isViewerOpen, setIsViewerOpen, adjData, setAdjData, selectedProduct, setSelectedProduct, manualItemName, setManualItemName, tempQty, setTempQty, tempPrice, setTempPrice, tempExpiry, setTempExpiry, tempNote, setTempNote, showSearchDropdown, setShowSearchDropdown, manualCategoryName, setManualCategoryName, selectedCategoryId, setSelectedCategoryId, showCategoryDropdown, setShowCategoryDropdown, invNumInputRef, itemNameInputRef, qtyInputRef, priceInputRef, expiryInputRef, noteInputRef, categoryInputRef, header, setHeader, isLocked, vTotalSum, filteredProducts, filteredSuppliers, selectedIndex, setSelectedIndex, supplierSearchTerm, setSupplierSearchTerm, showSupplierDropdown, setShowSupplierDropdown, isAddSupplierModalOpen, setIsAddSupplierModalOpen, newSupplierName, handleSupplierSearch, handleSupplierKeyDown, selectedSupplierIndex, isSearchingSuppliers, selectSupplier, handleSupplierBlur, confirmAddSupplier, cancelAddSupplier, selectProduct, finalizeItemAdd, handleSearchKeyDown, handlePost, safeNavigate, currency, isRecovery, suppliers, categories, addCategory, handleExport, printData, editingInvoiceId, aiParsedData, smartAnalysisResult, importProgressStage, importProgressPercent, importProgressMessage, applySmartImportData, applyAndSaveSmartImport, isProcessingAI, setIsProcessingAI, hasUnsavedAI, showAIConfirmModal, setShowAIConfirmModal, handleAIImport, cancelSmartImport, applyAIParsedData, resetInvoiceState, savePhase, setSavePhase, saveSuccessData, setSaveSuccessData, isConfirmSaveOpen, setIsConfirmSaveOpen, isRecoveryModalOpen, setIsRecoveryModalOpen, recoveryDraftData, restoreDraft, discardDraft };
}
