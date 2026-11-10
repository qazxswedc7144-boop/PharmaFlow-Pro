import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { configurationService } from '@/services/config/configurationService';
import { db } from '@/core/db';
import { Product, InvoiceStatus, InvoiceItem, PaymentStatus, Supplier } from '@/types';
import { useUI, useInventory, useAccounting } from '@/contexts/AppContext';
import { useAppStore } from '@/hooks/useAppStore';
import { authService } from '@features/auth/services/authService';
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
import { collectPendingProductsForInvoice } from '../utils/pendingProducts';
import { buildFailedPurchaseDraft } from '../utils/failedPurchaseDraft';

const DRAFT_KEY = 'pharmaflow_purchase_draft';

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
  const itemNameInputRef = useRef<HTMLInputElement>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const expiryInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const categoryInputRef = useRef<HTMLSelectElement>(null);
  const [header, setHeader] = useState({ invoice_number: '', supplier_id: '', payment_method: 'Cash', status: 'DRAFT' as InvoiceStatus, payment_status: 'Unpaid' as PaymentStatus, date: new Date().toISOString().split('T')[0], notes: '', isReturn: false, attachment: '' });
  const currentOperationRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const pendingProductsRef = useRef<any[]>([]);

  const resetInvoiceState = useCallback(() => {
    setHeader({ invoice_number: '', supplier_id: '', payment_method: 'Cash', status: 'DRAFT', payment_status: 'Unpaid', date: new Date().toISOString().split('T')[0], notes: '', isReturn: false, attachment: '' });
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
  useEffect(() => { const timer = setTimeout(async () => { try { if (manualItemName.trim()) setFilteredProducts(await predictionService.searchProducts(manualItemName)); else setFilteredProducts([]); } catch (e) { console.error("Product prediction failed:", e); } }, 300); return () => clearTimeout(timer); }, [manualItemName]);
  useEffect(() => { const checkLock = async () => { try { const locked = await db.isDateLocked(header.date || ""); setIsDateLockedStatus(locked); } catch (e) { console.error("checkLock failed:", e); } }; checkLock().catch(e => console.error("[usePurchases] checkLock fatal error:", e)); }, [header.date]);
  const isLocked = useMemo(() => { const isWorkflowLocked = InvoiceWorkflowEngine.isLocked(header.status); const isPeriodLocked = isDateLockedStatus && authService.getCurrentUser()?.Role !== 'Admin'; return isWorkflowLocked || isPeriodLocked || hasDependencies; }, [header.status, isDateLockedStatus, hasDependencies]);

  useEffect(() => { const fetchEditingInvoice = async () => { try { if (editingInvoiceId) { const inv: any = await InvoiceRepository.getPurchaseById(editingInvoiceId); if (inv) { setHeader({ invoice_number: inv.invoiceId || inv.invoice_number || '', supplier_id: inv.partnerId || inv.supplier_id || '', payment_method: inv.status === 'PAID' ? 'Cash' : 'Credit', status: inv.invoiceStatus || inv.status || 'DRAFT', payment_status: inv.payment_status || 'Unpaid', date: inv.date, notes: inv.notes || '', attachment: inv.attachment || '', isReturn: inv.invoiceType === 'مرتجع' }); const normalizedItems = (inv.items || []).map((i: any, idx: number) => ({ ...i, name: i.name || i.productName || i.Name || '', productName: i.productName || i.name || i.Name || '', qty: Number(i.qty ?? i.quantity ?? 0), quantity: Number(i.quantity ?? i.qty ?? 0), price: Number(i.price ?? i.unitPrice ?? 0), unitPrice: Number(i.unitPrice ?? i.price ?? 0), sum: Number(i.sum ?? ((i.qty ?? i.quantity ?? 0) * (i.price ?? i.unitPrice ?? 0))), row_order: i.row_order || idx + 1, expiryDate: normalizeToISODate(i.expiryDate || i.ExpiryDate || i.expiry_date || i.expirationDate || '') })); setItems(normalizedItems); setAdjData({ discountPercent: inv.discountPercent || 0, otherFees: inv.otherFees || 0, tax: inv.tax || 0 }); const deps = await InvoiceRepository.checkHasDependencies(editingInvoiceId, 'PURCHASE'); setHasDependencies(deps); } } else resetInvoiceState(); } catch (e) { console.error("fetchEditingInvoice failed:", e); } }; fetchEditingInvoice().catch(e => console.error("[usePurchases] fetchEditingInvoice fatal error:", e)); }, [editingInvoiceId, resetInvoiceState]);
  useEffect(() => { let timer: NodeJS.Timeout | null = null; if (isLocked && editingInvoiceId) { timer = setTimeout(() => { (async () => { try { await db.updatePurchaseNotes(editingInvoiceId, header.notes); await db.updatePurchaseAttachment(editingInvoiceId, header.attachment || ''); } catch (e) { console.error("Auto-update header failed:", e); } })().catch(e => console.error("[usePurchases] Auto-update header fatal:", e)); }, 1000); } return () => { if (timer) clearTimeout(timer); }; }, [header.notes, header.attachment, isLocked, editingInvoiceId]);

  const draftPromptCheckedRef = useRef(false);
  useEffect(() => { if (editingInvoiceId) return; const checkDraft = async () => { if (draftPromptCheckedRef.current) return; draftPromptCheckedRef.current = true; try { const unfinished = await DraftService.getUnfinishedInvoiceDraft('PURCHASE'); if (unfinished) { setRecoveryDraftData(unfinished); setIsRecoveryModalOpen(true); } else { const hasSavedDraft = await DraftService.hasDraft('purchases'); if (hasSavedDraft) { const draft = await DraftService.getDraft('purchases'); if (draft && draft.items && draft.items.length > 0) { setRecoveryDraftData(draft as any); setIsRecoveryModalOpen(true); } } } } catch (err) { console.error('Failed to load purchases draft recovery status:', err); } }; checkDraft().catch(e => console.error("checkDraft error:", e)); }, [editingInvoiceId]);
  const restoreDraft = useCallback(async () => { if (recoveryDraftData) { const draftObj: any = recoveryDraftData; const data = draftObj.totals?.header ? draftObj.totals : (draftObj.payload || draftObj); if (data) { if (data.header) setHeader(data.header); const rawItems = draftObj.items || data.items || []; if (rawItems && rawItems.length > 0) setItems(rawItems.map((i: any, idx: number) => ({ ...i, name: i.name || i.productName || i.Name || '', productName: i.productName || i.name || i.Name || '', qty: Number(i.qty ?? i.quantity ?? 0), quantity: Number(i.quantity ?? i.qty ?? 0), price: Number(i.price ?? i.unitPrice ?? 0), unitPrice: Number(i.unitPrice ?? i.price ?? 0), sum: Number(i.sum ?? ((i.qty ?? i.quantity ?? 0) * (i.price ?? i.unitPrice ?? 0))), row_order: i.row_order || idx + 1, expiryDate: normalizeToISODate(i.expiryDate || i.ExpiryDate || i.expiry_date || i.expirationDate || '') }))); if (data.adjData) setAdjData(data.adjData); else if (data.totals?.adjData) setAdjData(data.totals.adjData); else if (draftObj.totals?.adjData) setAdjData(draftObj.totals.adjData); if (draftObj.partner?.partnerName) setSupplierSearchTerm(draftObj.partner.partnerName); else if (data.partner?.partnerName) setSupplierSearchTerm(data.partner.partnerName); } addToast("تمت استعادة مسودة المشتريات بنجاح 💾", "success"); } setIsRecoveryModalOpen(false); setRecoveryDraftData(null); }, [recoveryDraftData, addToast]);
  const discardDraft = useCallback(async () => { try { if ((recoveryDraftData as any)?.draftId) await DraftService.clearInvoiceDraft((recoveryDraftData as any).draftId); await DraftService.clearDraft('purchases'); const unfinished = await DraftService.getUnfinishedInvoiceDraft('PURCHASE'); if (unfinished?.draftId) await DraftService.clearInvoiceDraft(unfinished.draftId); addToast("تم حذف مسودة المشتريات المتروكة وبدء قيد جديد", "info"); resetInvoiceState(); } catch (e) { console.error("discardDraft failed:", e); } finally { setIsRecoveryModalOpen(false); setRecoveryDraftData(null); } }, [addToast, resetInvoiceState, recoveryDraftData]);

  const handleSupplierSearch = useCallback((val: string) => { setSupplierSearchTerm(val); setShowSupplierDropdown(true); setSelectedSupplierIndex(-1); }, []);
  const handleSupplierKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedSupplierIndex(prev => Math.min(prev + 1, filteredSuppliers.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedSupplierIndex(prev => Math.max(prev - 1, -1)); } else if (e.key === 'Enter') { if (selectedSupplierIndex >= 0 && filteredSuppliers[selectedSupplierIndex]) { e.preventDefault(); selectSupplier(filteredSuppliers[selectedSupplierIndex]); } } else if (e.key === 'Escape') { setShowSupplierDropdown(false); setSelectedSupplierIndex(-1); } }, [filteredSuppliers, selectedSupplierIndex]);
  const selectSupplier = useCallback((s: Supplier) => { setHeader(prev => ({ ...prev, supplier_id: s.id })); setSupplierSearchTerm(s.Supplier_Name || s.name || ''); setShowSupplierDropdown(false); showNotification(`رصيد المورد الحالي للفاتورة: ${(s.balance || 0).toLocaleString()} ${currency}`, 'info'); }, [showNotification, currency]);
  const handleSupplierBlur = useCallback(() => { setTimeout(async () => { setShowSupplierDropdown(false); if (supplierSearchTerm) { try { const allDBSuppliers = await db.suppliers.toArray(); const activeSuppliers = allDBSuppliers.filter(s => s.Is_Active === true || s.Is_Active === 1 || String(s.Is_Active) === "true" || s.Is_Active === undefined); const exactMatch = activeSuppliers.find(s => s.Supplier_Name === supplierSearchTerm || s.name === supplierSearchTerm); if (!exactMatch) { const similarSupplier = activeSuppliers.find(s => { const sName = (s.Supplier_Name || s.name || '').toLowerCase(); const tName = supplierSearchTerm.toLowerCase(); return sName.includes(tName) || tName.includes(sName); }); if (similarSupplier) { if (window.confirm(`هل تقصد [${similarSupplier.Supplier_Name || similarSupplier.name}]؟`)) { selectSupplier(similarSupplier); return; } } setNewSupplierName(supplierSearchTerm); setIsAddSupplierModalOpen(true); } else selectSupplier(exactMatch); } catch (error) { console.error("Checking DB for supplier failed", error); } } }, 200); }, [supplierSearchTerm, selectSupplier]);
  const confirmAddSupplier = useCallback(async () => { try { const newId = `SUP-${Date.now()}`; const newSup: Supplier = { id: newId, Supplier_ID: newId, Supplier_Name: newSupplierName, Phone: '', Address: '', balance: 0, openingBalance: 0, Is_Active: true, Created_At: new Date().toISOString() }; await db.saveSupplier(newSup); await refreshGlobal(); setHeader(prev => ({ ...prev, supplier_id: newId })); setSupplierSearchTerm(newSupplierName); setIsAddSupplierModalOpen(false); addToast(`تم إضافة المورد ${newSupplierName} بنجاح`, "success"); } catch (error) { console.error("Failed to add supplier", error); addToast("فشل في إضافة المورد", "error"); } }, [newSupplierName, refreshGlobal, addToast]);
  const cancelAddSupplier = useCallback(() => { setIsAddSupplierModalOpen(false); setSupplierSearchTerm(''); setHeader(prev => ({ ...prev, supplier_id: '' })); }, []);
  const safeNavigate = useCallback((path: string) => { try { onNavigate?.(path); } catch (error) { console.error("Navigation failed, falling back to window.location", error); window.location.hash = path; } }, [onNavigate]);
  const importAbortControllerRef = useRef<AbortController | null>(null);
  const cancelSmartImport = useCallback(() => { if (importAbortControllerRef.current) { importAbortControllerRef.current.abort(); importAbortControllerRef.current = null; } setIsProcessingAI(false); setShowAIConfirmModal(false); addToast("تم إلغاء عملية الاستيراد الذكي", "info"); }, [addToast]);

  const handleAIImport = async (file: File | string) => { if (importAbortControllerRef.current) importAbortControllerRef.current.abort(); const abortController = new AbortController(); importAbortControllerRef.current = abortController; setIsProcessingAI(true); setImportProgressPercent(10); setImportProgressStage('DETECTING_SOURCE'); setImportProgressMessage('جاري فحص مصدر وصيغة المستند...'); setShowAIConfirmModal(true); try { const user = authService.getCurrentUser(); const analysis = await SmartImportOrchestrator.analyzeInvoice(file, { tenantId: (user as any)?.tenantId, branchId: (user as any)?.branchId, abortSignal: abortController.signal, onProgress: (stage, percent, message) => { setImportProgressStage(stage); setImportProgressPercent(percent); setImportProgressMessage(message); } }); setSmartAnalysisResult(analysis); setAIParsedData({ invoice_number: analysis.summary.detectedInvoiceNumber, supplier: analysis.summary.detectedSupplier, notes: analysis.rawText, items: analysis.rows.map(r => ({ name: r.productName, quantity: r.quantity, price: r.unitPrice, discountPercent: r.discountPercent, barcode: r.barcode, bonusQty: r.bonusQty, batchNumber: r.batchNumber, notes: r.notes, product_id: r.matchedProductId, expiryDate: r.expiryDate })) }); if (typeof file === 'string') setHeader(prev => ({ ...prev, attachment: file })); else { const reader = new FileReader(); const base64 = await new Promise<string>((resolve) => { reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(file); }); setHeader(prev => ({ ...prev, attachment: base64 })); } setIsProcessingAI(false); } catch (error: any) { if (error?.name === 'AbortError') { console.log('[SMART IMPORT] Import was cancelled by user.'); setIsProcessingAI(false); return; } console.error("[SMART IMPORT ERROR]:", error); addToast(`❌ تعذر استيراد الفاتورة: ${error.message || 'خطأ غير متوقع'}`, "error"); setIsProcessingAI(false); setShowAIConfirmModal(false); } finally { if (importAbortControllerRef.current === abortController) importAbortControllerRef.current = null; } };

  const applySmartImportData = useCallback((approvedRows: ExtractedImportRow[], detectedSupplier?: string, detectedInvoiceNumber?: string, detectedDate?: string) => { if (!approvedRows || approvedRows.length === 0) { addToast("لا توجد أصناف معتمدة للتطبيق", "warning"); return { convertedItems: [], matchedSupplierId: header.supplier_id, invNum: header.invoice_number }; } const invNum = detectedInvoiceNumber || header.invoice_number || `INV-${Math.floor(Math.random() * 100000)}`; const convertedItems = SmartImportOrchestrator.convertToInvoiceItems(approvedRows, invNum); let matchedSupplierId = header.supplier_id; if (detectedSupplier) { const match = suppliers?.find(s => s.Supplier_Name?.toLowerCase().includes(detectedSupplier.toLowerCase()) || detectedSupplier.toLowerCase().includes((s.Supplier_Name || '').toLowerCase())); if (match) { matchedSupplierId = match.id || match.Supplier_ID || ''; setSupplierSearchTerm(match.Supplier_Name || ''); } } setItems(convertedItems); setHeader(prev => ({ ...prev, invoice_number: invNum, supplier_id: matchedSupplierId || prev.supplier_id, date: detectedDate || prev.date, status: 'DRAFT' })); setHasUnsavedAI(true); setShowAIConfirmModal(false); addToast(`✅ تم استيراد ${convertedItems.length} صنف إلى الفاتورة بنجاح للمراجعة والحفظ`, "success"); return { convertedItems, matchedSupplierId, invNum }; }, [header.invoice_number, header.supplier_id, suppliers, addToast]);

  const applyAIParsedData = async () => { if (!aiParsedData) return; if (!aiParsedData.items || aiParsedData.items.length === 0) { addToast("لم يتم التعرف على بيانات الفاتورة", "warning"); setIsProcessingAI(false); return; } const cleanedItems = (aiParsedData.items || []).filter(i => i.name && i.quantity && i.price); if (!cleanedItems.length) { addToast("❌ فشل تحليل الفاتورة في استخراج أصناف صالحة", "error"); setIsProcessingAI(false); return; } const matchedSupplier = suppliers?.find(s => s.Supplier_Name?.toLowerCase().includes((aiParsedData.supplier || '').toLowerCase()) || (aiParsedData.supplier || '').toLowerCase().includes((s.Supplier_Name || '').toLowerCase())); const matchedSupplierId = matchedSupplier ? (matchedSupplier.id || matchedSupplier.Supplier_ID) : (suppliers?.[0]?.id || ''); const mappedItems: any[] = cleanedItems.map((item, idx) => { const q = Number(item.quantity || 1); const p = Number(item.price || 0); const disc = Number(item.discountPercent || 0); const sub = q * p; const finalSum = disc > 0 ? sub * (1 - disc / 100) : sub; const notesParts = [item.barcode ? `باركود: ${item.barcode}` : '', item.bonusQty ? `بونص: +${item.bonusQty}` : '', item.batchNumber ? `تشغيلة: ${item.batchNumber}` : '', item.notes || ''].filter(Boolean); return { id: `PUR-DET-${Date.now()}-${idx}`, parent_id: aiParsedData.invoice_number || `INV-${Math.floor(Math.random() * 100000)}`, product_id: item.product_id || `manual-${Date.now()}-${idx}`, productId: item.product_id || `manual-${Date.now()}-${idx}`, productName: item.name || '', name: item.name || '', quantity: q, qty: q, unitPrice: p, price: p, subtotal: finalSum, sum: finalSum, discount_val: disc, row_order: idx + 1, expiryDate: normalizeToISODate(item.expiryDate || (item as any).ExpiryDate || (item as any).expiry_date || ''), notes: notesParts.join(' | '), category: item.categoryId || '' }; }); setItems(mappedItems as any); setHeader(prev => ({ ...prev, invoice_number: aiParsedData.invoice_number || prev.invoice_number, supplier_id: matchedSupplierId || prev.supplier_id || '', isReturn: aiParsedData.type === 'return', notes: aiParsedData.notes || prev.notes, status: 'DRAFT' as const })); setHasUnsavedAI(true); setIsProcessingAI(false); setShowAIConfirmModal(false); addToast("📝 تم تعبئة شاشة المراجعة الوسيطة بنجاح! يرجى التدقيق يدوياً والموافقة لحفظ الفاتورة المحاسبية 💾", "success"); };

  const vTotalSum = useMemo(() => { const subtotal = items.reduce((sum, item) => sum + (item.qty * item.price), 0); const discount = subtotal * (adjData.discountPercent / 100); return subtotal - discount + adjData.otherFees + adjData.tax; }, [items, adjData]);
  const prevItemsRef = useRef<InvoiceItem[]>(items); const prevSupplierIdRef = useRef<string>(header.supplier_id); const prevNotesRef = useRef<string>(header.notes); const prevAdjDataRef = useRef<{ discountPercent: number; otherFees: number; tax: number }>(adjData);
  useEffect(() => { if (editingInvoiceId) return; if (items.length === 0 && !header.supplier_id && !header.notes) return; const itemsChanged = JSON.stringify(items) !== JSON.stringify(prevItemsRef.current); const supplierChanged = header.supplier_id !== prevSupplierIdRef.current; const notesChanged = header.notes !== prevNotesRef.current; const adjChanged = JSON.stringify(adjData) !== JSON.stringify(prevAdjDataRef.current); if (itemsChanged || supplierChanged || notesChanged || adjChanged) { prevItemsRef.current = items; prevSupplierIdRef.current = header.supplier_id; prevNotesRef.current = header.notes; prevAdjDataRef.current = adjData; const timer = setTimeout(async () => { try { const partner = suppliers.find(s => s.id === header.supplier_id); const partnerName = partner ? partner.Supplier_Name : ''; await DraftService.saveInvoiceDraft('purchases_draft_current', 'PURCHASE', items, { adjData, subtotal: vTotalSum, header, partner: { partnerName } }); } catch (e) { console.error("Debounced auto-save failed:", e); } }, 1000); return () => clearTimeout(timer); } return undefined; }, [items, header, adjData, vTotalSum, editingInvoiceId, suppliers]);

  const selectProduct = useCallback((p: Product) => { setSelectedProduct(p); setManualItemName(p.Name || ''); setTempPrice(p.LastPurchasePrice || p.CostPrice || ''); setTempQty(1); if (p.StockQuantity !== undefined) addToast(`المخزون الحالي: ${p.StockQuantity}`, "info"); if (p.LastPurchasePrice) addToast(`آخر سعر شراء: ${p.LastPurchasePrice} ${currency}`, "info"); setSearchTerm(''); setShowSearchDropdown(false); setSelectedIndex(-1); qtyInputRef.current?.focus(); }, [addToast, currency]);
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(prev => Math.min(prev + 1, filteredProducts.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(prev => Math.max(prev - 1, -1)); } else if (e.key === 'Enter') { if (selectedIndex >= 0) { e.preventDefault(); const prod = filteredProducts[selectedIndex]; if (prod) selectProduct(prod); } else if (manualItemName) { e.preventDefault(); qtyInputRef.current?.focus(); } } else if (e.key === 'Escape') { setShowSearchDropdown(false); setSelectedIndex(-1); } }, [filteredProducts, selectedIndex, selectProduct, manualItemName]);
  const finalizeItemAdd = useCallback(() => { if (!manualItemName || !tempQty || !tempPrice) { addToast("يرجى إكمال بيانات الصنف", "error"); return; } const newItem: InvoiceItem = { id: `PUR-DET-${Date.now()}`, parent_id: header.invoice_number, product_id: selectedProduct?.id || `manual-${Date.now()}`, productId: selectedProduct?.id || `manual-${Date.now()}`, productName: manualItemName, name: manualItemName, quantity: Number(tempQty), qty: Number(tempQty), unitPrice: Number(tempPrice), price: Number(tempPrice), subtotal: Number(tempQty) * Number(tempPrice), sum: Number(tempQty) * Number(tempPrice), row_order: items.length + 1, expiryDate: normalizeToISODate(tempExpiry), notes: tempNote, category: selectedCategoryId || selectedProduct?.categoryId }; setItems(prev => [...prev, newItem]); setSelectedProduct(null); setManualItemName(''); setTempQty(''); setTempPrice(''); setTempExpiry(''); setTempNote(''); setSelectedCategoryId(''); setManualCategoryName(''); setShowCategoryDropdown(false); itemNameInputRef.current?.focus(); addToast("تمت إضافة الصنف ✅", "success"); }, [manualItemName, tempQty, tempPrice, header.invoice_number, selectedProduct, items.length, tempExpiry, tempNote, selectedCategoryId, addToast]);

  const handlePost = useCallback(async (overridePayload?: { items?: InvoiceItem[]; header?: typeof header; adjData?: typeof adjData }) => {
    if (isSavingRef.current || savePhase === 'saving') return;
    const currentItems = overridePayload?.items || items;
    const currentHeader = overridePayload?.header || header;
    const currentAdjData = overridePayload?.adjData || adjData;
    if (!currentHeader.supplier_id) { addToast("يرجى اختيار المورد", "error"); return; }
    if (currentItems.length === 0) { addToast("الفاتورة فارغة", "error"); return; }
    const subtotal = currentItems.reduce((sum: number, item: any) => sum + (item.qty * item.price), 0);
    const discount = subtotal * (currentAdjData.discountPercent / 100);
    const currentTotal = subtotal - discount + currentAdjData.otherFees + currentAdjData.tax;
    isSavingRef.current = true;
    showNotification('⌛ جاري حفظ الفاتورة وتحديث المستودع...', 'info');
    addToast("جاري الحفظ والمزامنة... ⏳", "info");
    setIsSaving(true);
    setSavePhase('saving');
    try {
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
      const itemsForSave = preparedProducts.items as InvoiceItem[];
      setItems(itemsForSave);

      // تنفيذ الحفظ المحلي مباشرة (بدون Promise.race أو مهلة زمنية)
      const res = await addInvoice({
        type: 'PURCHASE',
        payload: {
          supplierId: currentHeader.supplier_id,
          items: itemsForSave.map(item => ({
            ...item,
            expiryDate: normalizeToISODate(item.expiryDate || (item as any).ExpiryDate || (item as any).expiry_date || (item as any).expirationDate || '')
          })),
          total: currentTotal,
          invoiceId: currentHeader.invoice_number,
          invoiceNumber: currentHeader.invoice_number,
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
      }) as { success: boolean; syncStatus?: 'ENQUEUED' | 'SYNCED' | 'FAILED' | 'LOCAL_ONLY' };

      if (res?.success) {
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

        await runPostCommitTask('report-and-provider-refresh', async () => {
          reportCache.purge();
          db.incrementDataVersion();
          await ReportEngine.refresh();
          await refreshGlobal();
        });
        configurationService.set(DRAFT_KEY, null).catch(() => {});
        setHasUnsavedAI(false);
        await runPostCommitTask('audit-log', () =>
          auditLogService.log({ table: 'purchases', action: 'PURCHASE', entityId: editingInvoiceId || header.invoice_number, newData: { items, total: vTotalSum }, details: `Purchase ${header.isReturn ? 'Return' : ''}: ${header.invoice_number}` })
        );
        const supplier = suppliers.find(s => s.id === header.supplier_id);
        const supplierName = supplier ? supplier.Supplier_Name : 'مورد غير محدد';
        await runPostCommitTask('draft-cleanup', async () => {
          await DraftService.clearInvoiceDraft('purchases_draft_current');
          await DraftService.clearDraft('purchases');
        });

        if (res.syncStatus === 'FAILED') {
          showNotification('تم حفظ الفاتورة محلياً، لكن فشلت المزامنة. ستتم المحاولة لاحقاً.', 'warning');
        } else if (postCommitWarnings.length > 0) {
          showNotification('تم حفظ الفاتورة، لكن بعض تحديثات ما بعد الحفظ لم تكتمل.', 'warning');
        }
        setSaveSuccessData({ invoiceNumber: header.invoice_number, totalAmount: vTotalSum, type: 'PURCHASE', date: header.date, partnerName: supplierName, accountingStatus: 'قيد ذمم دائنة مرحل وتلقائي', inventoryStatus: 'قيد المخزون المتاح والوجبات المدخلة', balanceStatus: 'معدل ومرحل لحساب المورد' });
        resetInvoiceState();
        setTimeout(() => { try { onNavigate?.('dashboard'); } catch (error) { window.location.hash = '#/dashboard'; } }, 1000);
      }
    } catch (error: unknown) {
      const failureOperationId = currentOperationRef.current || generateTransactionUuid('PURCHASE_FAILED');
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = rawErrorMessage.match(/[A-Z][A-Z0-9_]{3,}/)?.[0] || 'PURCHASE_SAVE_FAILED';

      // Preserve the failed invoice in a quarantined record, but never expose it
      // as the active purchase draft for the next invoice.
      try {
        const failedDraft = buildFailedPurchaseDraft({
          operationId: failureOperationId,
          header: currentHeader as any,
          items: currentItems,
          adjData: currentAdjData,
          errorCode
        });
        (failedDraft as any).pendingProducts = JSON.parse(JSON.stringify(pendingProductsRef.current));
        await DraftService.quarantineInvoiceDraft(failedDraft);
        await DraftService.clearInvoiceDraft('purchases_draft_current');
        await DraftService.clearDraft('purchases');
        await configurationService.set(DRAFT_KEY, null);
      } catch (quarantineError) {
        console.error('[usePurchases] Failed to quarantine failed invoice safely:', quarantineError);
      }

      currentOperationRef.current = null;
      pendingProductsRef.current = [];
      resetInvoiceState();
      setFilteredProducts([]);
      setSelectedProduct(null);
      setManualItemName('');
      setShowSearchDropdown(false);

      const normalized = ErrorManager.handleError(error, { module: 'PURCHASES', action: 'SAVE_PURCHASE', showToast: false });
      showNotification('❌ تعذر حفظ فاتورة المشتريات. تم عزل بيانات المحاولة الفاشلة.', 'error');
      addToast(normalized.arabicMessage, 'error');
    } finally { isSavingRef.current = false; setIsSaving(false); }
  }, [header, items, aiParsedData, suppliers, vTotalSum, editingInvoiceId, currency, addInvoice, addToast, refreshGlobal, onNavigate, showNotification, savePhase]);

  const handleExport = () => { /* Implementation for export */ };
  const applyAndSaveSmartImport = useCallback(async (approvedRows: ExtractedImportRow[], detectedSupplier?: string, detectedInvoiceNumber?: string, detectedDate?: string) => { const result = applySmartImportData(approvedRows, detectedSupplier, detectedInvoiceNumber, detectedDate); if (!result || !result.convertedItems || result.convertedItems.length === 0) return; const newHeader = { ...header, invoice_number: result.invNum, supplier_id: result.matchedSupplierId || header.supplier_id, date: detectedDate || header.date, status: 'DRAFT' as const }; await handlePost({ items: result.convertedItems, header: newHeader, adjData }); }, [applySmartImportData, handlePost, header, adjData]);
  const printData = { invoiceId: header.invoice_number, title: header.isReturn ? "فاتورة مرتجع مشتريات" : "فاتورة مشتريات", invoiceNumber: header.invoice_number, date: header.date, customerName: suppliers.find(s => s.id === header.supplier_id)?.Supplier_Name || 'مورد عام', items: items.map(i => ({ name: i.name, qty: i.qty, price: i.price, total: i.sum })), total: vTotalSum, currency };
  return { items, setItems, searchTerm, setSearchTerm, isSaving, hasDependencies, isAdjustmentsOpen, setIsAdjustmentsOpen, isCameraOpen, setIsCameraOpen, isViewerOpen, setIsViewerOpen, adjData, setAdjData, selectedProduct, setSelectedProduct, manualItemName, setManualItemName, tempQty, setTempQty, tempPrice, setTempPrice, tempExpiry, setTempExpiry, tempNote, setTempNote, showSearchDropdown, setShowSearchDropdown, manualCategoryName, setManualCategoryName, selectedCategoryId, setSelectedCategoryId, showCategoryDropdown, setShowCategoryDropdown, invNumInputRef, itemNameInputRef, qtyInputRef, priceInputRef, expiryInputRef, noteInputRef, categoryInputRef, header, setHeader, isLocked, vTotalSum, filteredProducts, filteredSuppliers, selectedIndex, setSelectedIndex, supplierSearchTerm, setSupplierSearchTerm, showSupplierDropdown, setShowSupplierDropdown, isAddSupplierModalOpen, setIsAddSupplierModalOpen, newSupplierName, handleSupplierSearch, handleSupplierKeyDown, selectedSupplierIndex, isSearchingSuppliers, selectSupplier, handleSupplierBlur, confirmAddSupplier, cancelAddSupplier, selectProduct, finalizeItemAdd, handleSearchKeyDown, handlePost, safeNavigate, currency, isRecovery, suppliers, categories, addCategory, handleExport, printData, editingInvoiceId, aiParsedData, smartAnalysisResult, importProgressStage, importProgressPercent, importProgressMessage, applySmartImportData, applyAndSaveSmartImport, isProcessingAI, setIsProcessingAI, hasUnsavedAI, showAIConfirmModal, setShowAIConfirmModal, handleAIImport, cancelSmartImport, applyAIParsedData, resetInvoiceState, savePhase, setSavePhase, saveSuccessData, setSaveSuccessData, isConfirmSaveOpen, setIsConfirmSaveOpen, isRecoveryModalOpen, setIsRecoveryModalOpen, recoveryDraftData, restoreDraft, discardDraft };
}
