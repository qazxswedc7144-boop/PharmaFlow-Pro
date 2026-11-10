import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, Button } from '@/components/shared/SharedUI';
import { db } from '@/core/db';
import { WorkflowOrchestrator } from '@/core/workflow';
import { productApplicationWorkflow } from '@features/catalog/workflows/ProductApplicationWorkflow';
import { Package, Lock, TrendingUp, Box } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '@/hooks/useAppStore';
import { normalizeToISODate, getExpiryStatus, formatDateDisplay } from '@/utils/expiryUtils';
import { priceIntelligenceService } from '@/features/inventory/services/priceIntelligenceService';
import { useToast } from '@/hooks/useToast';

interface ProductItem {
  id: string;
  Name: string;
  categoryName?: string;
  Category?: string;
  category?: string;
  ExpiryDate?: string;
  Expiry_Date?: string;
  expiryDate?: string;
  UnitPrice?: number;
  StockQuantity?: number;
  stock?: number;
}

interface FinalItemPayload {
  id: string;
  productId: string | null;
  name: string;
  qty: number;
  price: number;
  expiryDate: string;
  note: string;
  category: string;
  sum: number;
}

interface ItemEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (item: FinalItemPayload) => void;
  mode: 'purchase' | 'sale';
  isReturnMode?: boolean;
  customerId?: string;
  initialData?: {
    id?: string;
    name?: string;
    qty?: string | number;
    price?: string | number;
    expiryDate?: string;
    note?: string;
    category?: string;
    productId?: string | null;
    product?: ProductItem | null;
  } | null;
}

export const ItemEntryModal: React.FC<ItemEntryModalProps> = ({
  isOpen, onClose, onAdd, mode, initialData, isReturnMode = false, customerId
}) => {
  const [manualItemName, setManualItemName] = useState<string>('');
  const [tempQty, setTempQty] = useState<string | number>('');
  const [tempPrice, setTempPrice] = useState<string | number>('');
  const [tempExpiry, setTempExpiry] = useState<string>(new Date().toISOString().split('T')[0] || '');
  const [tempNote, setTempNote] = useState<string>('');
  const [categoryName, setCategoryName] = useState<string>('');
  const [showSearchDropdown, setShowSearchDropdown] = useState<boolean>(false);
  const [filteredProducts, setFilteredProducts] = useState<ProductItem[]>([]);
  const [isConfirmNewProductOpen, setIsConfirmNewProductOpen] = useState<boolean>(false);
  const [isConfirmedNewProduct, setIsConfirmedNewProduct] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  
  // Phase 3.1A - Sales Intelligence State
  const [availableStock, setAvailableStock] = useState<number | null>(null);
  const [lastSellingPriceSuggestion, setLastSellingPriceSuggestion] = useState<number | null>(null);
  const [priceInsight, setPriceInsight] = useState<string>('');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  // تتبع الارتفاع المتبقي ديناميكياً للتعامل مع كيبورد الموبايل
  const [isKeyboardUp, setIsKeyboardUp] = useState<boolean>(false);

  const { currency } = useAppStore();
  const { success, error } = useToast();
  
  const itemNameInputRef = useRef<HTMLInputElement>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const expiryInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const categoryInputRef = useRef<HTMLSelectElement>(null);
  const requestIdRef = useRef<number>(0); // منع تسابق طلبات بيانات الصنف
  const manualPriceEditedRef = useRef<boolean>(false); // حماية السعر الذي أدخله المستخدم من التحميلات المتأخرة

  // Mobile IMEs do not always expose Enter consistently through event.key alone.
  // Defer focus until React has committed dropdown/state updates.
  const focusNextField = (
    event: React.KeyboardEvent<HTMLInputElement>,
    getNextField: () => HTMLElement | null
  ) => {
    const nativeEvent = event.nativeEvent;
    const isEnter = event.key === 'Enter' || nativeEvent.keyCode === 13 || nativeEvent.which === 13;

    if (!isEnter || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;

    event.preventDefault();
    event.stopPropagation();

    requestAnimationFrame(() => {
      const nextField = getNextField();
      if (!nextField || !nextField.isConnected) return;
      nextField.focus({ preventScroll: true });
      nextField.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  const createAndSaveNewProduct = useCallback((name: string, price: string | number, qty: string | number, cat: string): string => {
    const newProdId = 'PROD-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    const newProd = {
      id: newProdId,
      ProductID: newProdId,
      Name: name,
      name: name,
      categoryName: cat || 'عام',
      UnitPrice: parseFloat(price as string) || 0,
      price: parseFloat(price as string) || 0,
      StockQuantity: parseFloat(qty as string) || 0,
      stock: parseFloat(qty as string) || 0,
      Is_Active: 1,
      created_at: new Date().toISOString()
    };
    WorkflowOrchestrator.execute(productApplicationWorkflow, { product: newProd as any, isNew: true })
      .then(() => db.products.put(newProd as any))
      .catch(err => {
        console.error("Background save failed:", err);
        error("فشل حفظ الصنف في قاعدة البيانات، يرجى المحاولة مرة أخرى");
      });
    return newProdId;
  }, [error]);

  // Load live stock, expiry, and price intelligence for the selected product
  const loadProductIntelligence = useCallback(async (prodId: string, currentProd?: ProductItem) => {
    if (!prodId) return;
    const currentRequestId = ++requestIdRef.current;
    try {
      // 1. Fetch live stock from product master & inventory layers
      const prod = currentProd || (await db.products.get(prodId)) as ProductItem;
      let stock = prod?.StockQuantity ?? prod?.stock ?? 0;
      
      // Also query available active layers for batches and expiry
      const layers = await db.inventory_layers.where('product_id').equals(prodId).toArray().catch(() => []);
      let activeLayers = layers.filter((l: any) => (l.remaining_qty || l.remainingQty || 0) > 0);
      
      // In sales mode: Filter out expired layers
      if (mode === 'sale' && activeLayers.length > 0) {
        const nonExpiredLayers = activeLayers.filter((l: any) => {
          const exp = l.expiry_date || l.expiryDate;
          return !getExpiryStatus(exp).isExpired;
        });
        
        if (nonExpiredLayers.length > 0) {
          activeLayers = nonExpiredLayers;
          const layerStock = activeLayers.reduce((sum: number, l: any) => sum + (l.remaining_qty || l.remainingQty || 0), 0);
          stock = layerStock;
        } else {
          // All active layers are expired
          stock = 0;
          activeLayers = [];
        }
      } else if (activeLayers.length > 0) {
        const layerStock = activeLayers.reduce((sum: number, l: any) => sum + (l.remaining_qty || l.remainingQty || 0), 0);
        if (layerStock > 0) stock = layerStock;
      }

      if (activeLayers.length > 0) {
        // Find earliest expiry date among active valid batches
        const sortedBatches = [...activeLayers].sort((a: any, b: any) => {
          const d1 = new Date(a.expiry_date || a.expiryDate || '9999-12-31').getTime();
          const d2 = new Date(b.expiry_date || b.expiryDate || '9999-12-31').getTime();
          return d1 - d2;
        });
        const earliestBatch = sortedBatches[0];
        if (earliestBatch && (earliestBatch.expiry_date || earliestBatch.expiryDate)) {
          setTempExpiry(normalizeToISODate(earliestBatch.expiry_date || earliestBatch.expiryDate));
        }
      } else if (prod?.ExpiryDate || prod?.expiryDate) {
        const pExp = prod.ExpiryDate || prod.expiryDate;
        if (mode === 'sale' && getExpiryStatus(pExp).isExpired) {
          stock = 0;
          setTempExpiry(normalizeToISODate(pExp));
        } else {
          setTempExpiry(normalizeToISODate(pExp));
        }
      }

      // ✅ التحقق من أن هذا الطلب هو الأحدث قبل تحديث الشاشة
if (currentRequestId !== requestIdRef.current) return;

setAvailableStock(stock);

// 2. Fetch last actual selling price / price intelligence
if (mode === 'sale') {
  const suggested = await priceIntelligenceService.getSuggestedPrice(prodId, 'SALE');
  
  // ✅ التحقق مرة أخرى بعد الانتظار (لأن جلب السعر قد يستغرق وقتاً)
  if (currentRequestId !== requestIdRef.current) return;

  if (suggested?.suggestedPrice && suggested.suggestedPrice > 0) {
    setLastSellingPriceSuggestion(suggested.suggestedPrice);
    setPriceInsight(suggested.insight || `آخر سعر بيع: ${suggested.suggestedPrice} ${currency}`);
  }
  // The posting workflow uses products.price as the authoritative amount.
  // Keep the preview aligned; intelligence suggestions remain informational only.
  const authoritativePrice = (prod as any)?.price;
  if (authoritativePrice !== undefined && authoritativePrice !== null && !manualPriceEditedRef.current) {
    setTempPrice(authoritativePrice);
  }
}
    } catch (err) {
      console.warn('[ItemEntryModal] Failed to fetch product intelligence:', err);
    }
  }, [mode, currency]);

  // مراقبة الـ Visual Viewport للتعامل مع كيبورد أندرويد كروم
  useEffect(() => {
    if (!window.visualViewport) return;

    const handleViewportChange = () => {
      const vv = window.visualViewport;
      if (!vv) return;

      const totalHeight = window.innerHeight;
      const currentVisualHeight = vv.height;
      const keyboardHeight = totalHeight - currentVisualHeight;

      if (keyboardHeight > 120) {
        setIsKeyboardUp(true);
      } else {
        setIsKeyboardUp(false);
      }
    };

    window.visualViewport.addEventListener('resize', handleViewportChange);
    window.visualViewport.addEventListener('scroll', handleViewportChange);
    
    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setManualItemName(initialData.name || '');
        setTempQty(initialData.qty || '');
        setTempPrice(initialData.price ?? '');
        manualPriceEditedRef.current = initialData.price !== undefined && initialData.price !== null && initialData.price !== '';
        setTempExpiry(normalizeToISODate(initialData.expiryDate));
        setTempNote(initialData.note || '');
        setCategoryName(initialData.category || '');
        const pId = initialData.productId || (initialData.product as any)?.id || null;
        setSelectedProductId(pId);
        if (pId) {
          loadProductIntelligence(pId, initialData.product || undefined);
        }
      } else {
        resetForm();
      }
      setTimeout(() => itemNameInputRef.current?.focus(), 120);
    }
  }, [isOpen, initialData, loadProductIntelligence]);

  const resetForm = () => {
    manualPriceEditedRef.current = false;
    setManualItemName('');
    setTempQty('');
    setTempPrice('');
    setTempExpiry(new Date().toISOString().split('T')[0] || '');
    setTempNote('');
    setCategoryName('');
    setIsConfirmedNewProduct(false);
    setAvailableStock(null);
    setLastSellingPriceSuggestion(null);
    setPriceInsight('');
      setSelectedProductId(null);
  setFilteredProducts([]);
  setShowSearchDropdown(false);
};
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (manualItemName.length > 1) {
        const nameResults = await db.products
          .where('Name')
          .startsWithIgnoreCase(manualItemName)
          .limit(20)
          .toArray();

        const barcodeResults = await db.products
          .where('barcode')
          .equals(manualItemName)
          .limit(20)
          .toArray();

        const nameLowerResults = await db.products
          .where('name')
          .startsWithIgnoreCase(manualItemName)
          .limit(20)
          .toArray();

        const combinedMap = new Map<string, any>();
        [...nameResults, ...barcodeResults, ...nameLowerResults].forEach(p => {
          if (p && (p.id || p.ProductID)) {
            combinedMap.set(p.id || p.ProductID, p);
          }
        });
        let results = Array.from(combinedMap.values());

        if (mode === 'sale' && !isReturnMode) {
          results = results.filter(p => (p.StockQuantity || p.stock || 0) > 0);
        }

        results = results.slice(0, 20);
        
        // ✅ إزالة الأصناف المكررة بناءً على الاسم
        const uniqueResults = results.filter((product, index, self) =>
          index === self.findIndex((p) => (p.Name || p.name || '').trim() === (product.Name || product.name || '').trim())
        );
        
        setFilteredProducts(uniqueResults as ProductItem[]);
      } else { 
        setFilteredProducts([]); 
      } 
    }, 300);

    return () => clearTimeout(timer);
  }, [manualItemName, mode, isReturnMode]);

  const loadLastSaleDetails = useCallback(async (productId: string) => {
    try {
      let saleItems = await db.invoiceItems
        .where('product_id')
        .equals(productId)
        .toArray()
        .catch(() => []);
      if (saleItems.length === 0) {
        saleItems = await db.invoiceItems
          .filter((item: any) => item.productId === productId)
          .toArray();
      }
      const matchingSales = (await Promise.all(saleItems.map(async (item: any) => {
        const invoiceId = item.parent_id || item.invoiceId || item.invoice_id;
        const invoice = invoiceId ? await db.invoices.get(invoiceId).catch(() => null) : null;
        return { item, invoice };
      })))
        .filter(({ invoice }: any) => {
          if (!invoice) return false;
          const type = String(invoice.type || invoice.Type || '').toUpperCase();
          if (type !== 'SALE' || invoice.isReturn === true) return false;
          if (!customerId) return true;
          return (invoice.customer_id || invoice.customerId || invoice.partner_id || invoice.partnerId) === customerId;
        })
        .sort((a: any, b: any) => {
          const dateA = new Date(a.invoice.date || a.invoice.Date || a.invoice.createdAt || 0).getTime();
          const dateB = new Date(b.invoice.date || b.invoice.Date || b.invoice.createdAt || 0).getTime();
          return dateB - dateA;
        });

      const latest = matchingSales[0]?.item;
      if (!latest) return;

      const lastPrice = Number(latest.unitPrice ?? latest.unit_price ?? latest.price);
      if (Number.isFinite(lastPrice) && lastPrice > 0) {
        if (!manualPriceEditedRef.current) setTempPrice(lastPrice);
        setLastSellingPriceSuggestion(lastPrice);
        setPriceInsight(`آخر سعر بيع مسجل: ${lastPrice} ${currency}`);
      }

      const expiry = latest.expiryDate || latest.expiry_date;
      if (expiry) setTempExpiry(normalizeToISODate(expiry));

      const category = latest.category || latest.categoryName;
      if (category) setCategoryName(category);
    } catch (err) {
      console.warn('[ItemEntryModal] Failed to load last sale details:', err);
    }
  }, [customerId, currency]);

  const selectProduct = (p: ProductItem) => {
    manualPriceEditedRef.current = false;
    setManualItemName(p.Name || '');
    setCategoryName(p.categoryName || p.category || p.Category || '');
    setSelectedProductId(p.id);
    setShowSearchDropdown(false);

    if (isReturnMode && mode === 'sale') {
      setTempQty(1);
      void loadProductIntelligence(p.id, p).then(() => loadLastSaleDetails(p.id));
    } else {
      setTempExpiry(normalizeToISODate(p.ExpiryDate || p.expiryDate || ''));
      loadProductIntelligence(p.id, p);
    }
    qtyInputRef.current?.focus();
  };

  const handleFinalize = async () => {
    if (!manualItemName || !tempQty || !tempPrice) return;
    
    const searchName = manualItemName.trim().toLowerCase();
    let existing = await db.products.filter(p => 
      ((p.Name || p.name || '')).trim().toLowerCase() === searchName
    ).first().catch(() => null);

    let finalProductId = selectedProductId || existing?.id || null;

    if (!existing && mode === 'sale') {
      finalProductId = finalProductId || ('manual-' + Date.now());
    }

    if (!existing && mode === 'purchase' && !isConfirmedNewProduct) { 
      setIsConfirmNewProductOpen(true); 
      return; 
    }

    setIsSubmitting(true);
    try {
      if (!existing && mode === 'purchase' && isConfirmedNewProduct) {
        finalProductId = createAndSaveNewProduct(manualItemName, tempPrice, tempQty, categoryName);
      }

      // ✅ إرسال الصنف للجدول فوراً (سيظهر مباشرة)
      onAdd({ 
        id: initialData?.id || Date.now().toString(), 
        productId: finalProductId, 
        name: manualItemName, 
        qty: parseFloat(tempQty as string), 
        price: parseFloat(tempPrice as string), 
        expiryDate: normalizeToISODate(tempExpiry), 
        note: tempNote, 
        category: categoryName || 'عام', 
        sum: parseFloat(tempQty as string) * parseFloat(tempPrice as string) 
      });
      success("تم إضافة الصنف بنجاح");
      
      if (initialData) {
        onClose();
      } else {
        resetForm();
        setTimeout(() => itemNameInputRef.current?.focus(), 100);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmRegister = async () => {
    setIsConfirmNewProductOpen(false);
    setIsConfirmedNewProduct(true);
    setIsSubmitting(true);
    try {
      const newProdId = createAndSaveNewProduct(manualItemName, tempPrice, tempQty, categoryName);
      onAdd({ 
        id: initialData?.id || Date.now().toString(), 
        productId: newProdId, 
        name: manualItemName, 
        qty: parseFloat(tempQty as string), 
        price: parseFloat(tempPrice as string), 
        expiryDate: normalizeToISODate(tempExpiry), 
        note: tempNote, 
        category: categoryName || 'عام', 
        sum: parseFloat(tempQty as string) * parseFloat(tempPrice as string) 
      });
      success("تم إضافة الصنف بنجاح");
      if (initialData) {
        onClose();
      } else {
        resetForm();
        setTimeout(() => itemNameInputRef.current?.focus(), 100);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Modal 
        isOpen={isOpen} 
        onClose={onClose} 
        title="" 
        showCloseButton={false} 
        isCompact={false} 
        noPadding={true} 
        noOuterPadding={true}
        maxWidth="w-[calc(100%-10px)] mx-auto max-w-md"
        transparentContainer={true}
        positionClass="items-center"
      >
        <div 
          dir="rtl" 
          className="w-[calc(100%-10px)] mx-auto sm:max-w-md bg-white rounded-[28px] overflow-hidden flex flex-col box-border p-0 border-0 shadow-2xl transition-all duration-150 ease-out font-cairo"
          style={{ 
            maxHeight: isKeyboardUp ? '56vh' : '90vh',
            transform: isKeyboardUp ? 'translateY(-4vh)' : 'none'
          }}
        >
          {/* حقل البحث والمطابقة */}
          <div className="px-3.5 pt-3.5 pb-2 border-b border-slate-100 flex-shrink-0 w-full box-border">
            <label className="text-[11px] font-bold text-slate-400 mb-1 block text-right">اسم الصنف</label>
            <div className="relative w-full box-border">
              <input 
                ref={itemNameInputRef} 
                value={manualItemName} 
                onChange={e => { 
  setManualItemName(e.target.value); 
  setSelectedProductId(null); 
  setShowSearchDropdown(true); 
}}
                onFocus={() => setShowSearchDropdown(true)}
                className="w-full box-border h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-[14px] font-semibold text-[#1E4D4D] outline-none focus:bg-white text-right"
                placeholder="ابحث عن صنف أو اكتب اسماً..." 
                enterKeyHint="next"
                onKeyDown={e => {
                  setShowSearchDropdown(false);
                  focusNextField(e, () => qtyInputRef.current);
                }}
              />
              <AnimatePresence>
                {showSearchDropdown && filteredProducts.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 3 }} 
                    animate={{ opacity: 1, y: 0 }} 
                    exit={{ opacity: 0, y: 3 }} 
                    className="absolute top-full left-0 right-0 bg-white border border-slate-200 rounded-xl shadow-xl z-[100] mt-1 max-h-36 overflow-y-auto box-border"
                  >
                    {filteredProducts.map(p => (
                      <button 
                        key={p.id} 
                        type="button" 
                        onClick={() => selectProduct(p)} 
                        className="w-full px-3 py-2 text-right hover:bg-slate-50 border-b border-slate-50 last:border-0 text-[13px] font-semibold text-[#1E4D4D] flex items-center justify-between"
                      >
                        <span>{p.Name}</span>
                        <span className="text-[11px] font-bold text-slate-400">
                          رصيد: {p.StockQuantity ?? p.stock ?? 0}
                        </span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* شريط ذكاء المنتج للمبيعات (Sales Intelligence Badge) */}
            {mode === 'sale' && availableStock !== null && (
              <div className="mt-2 flex items-center justify-between bg-teal-50/80 border border-teal-100 px-2.5 py-1 rounded-lg text-[11px]">
                <div className="flex items-center gap-1.5 font-bold text-teal-800">
                  <Box size={13} className="text-teal-600" />
                  <span>المتوفر بالمخزن:</span>
                  <span className={`font-black ${availableStock <= 0 ? 'text-red-500' : 'text-teal-900'}`}>
                    {availableStock}
                  </span>
                </div>
                {lastSellingPriceSuggestion !== null && (
                  <div className="flex items-center gap-1 text-slate-600 font-bold" title={priceInsight || undefined}>
                    <TrendingUp size={12} className="text-emerald-600" />
                    <span>آخر بيع:</span>
                    <span className="font-mono text-emerald-800 font-bold">{lastSellingPriceSuggestion} {currency}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* الحقول المدمجة */}
          <div className="px-3.5 py-2 space-y-2.5 overflow-y-auto flex-1 box-border w-full min-w-0 scrollbar-none">
            {/* صف 1: الكمية | الصلاحية (Read-only expiry in sales) */}
            <div className="grid grid-cols-2 gap-2.5 w-full min-w-0 box-border">
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-slate-400 text-right block">الكمية المطلوبة</label>
                  {availableStock !== null && mode === 'sale' && (
                    <span className="text-[10px] font-bold text-slate-400">متاح ({availableStock})</span>
                  )}
                </div>
                <input 
                  ref={qtyInputRef} 
                  type="number" 
                  value={tempQty} 
                  onChange={e => setTempQty(e.target.value)} 
                  onKeyDown={e => focusNextField(e, () => priceInputRef.current)}
                  inputMode="decimal"
                  enterKeyHint="next"
                  className={`w-full box-border h-10 bg-slate-50 border rounded-xl px-2 text-center text-[14px] font-semibold text-[#1E4D4D] outline-none ${
                    mode === 'sale' && availableStock !== null && Number(tempQty) > availableStock
                      ? 'border-red-400 bg-red-50 text-red-600' 
                      : 'border-slate-200'
                  }`} 
                  placeholder="0" 
                />
              </div>

              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-slate-400 text-right block">تاريخ الصلاحية</label>
                  {mode === 'sale' && (
                    <span className="text-[10px] text-teal-700 font-bold flex items-center gap-0.5">
                      <Lock size={10} /> نظامي
                    </span>
                  )}
                </div>
                <div className="relative w-full h-10">
  <input 
    ref={expiryInputRef} 
    type="date" 
    disabled={mode === 'sale'} 
    readOnly={mode === 'sale'} 
    value={tempExpiry} 
    onChange={e => setTempExpiry(e.target.value)} 
    onKeyDown={e => e.key === 'Enter' && priceInputRef.current?.focus()} 
    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 disabled:cursor-not-allowed" 
  />
  <div className={`absolute inset-0 border border-slate-200 rounded-xl px-2 text-[13px] font-semibold text-[#1E4D4D] flex items-center justify-center pointer-events-none ${
    mode === 'sale' ? 'bg-slate-100/80 opacity-85' : 'bg-slate-50'
  }`}>
    {formatDateDisplay(tempExpiry) || 'يوم / شهر / سنة'}
  </div>
</div>
              </div>
            </div>

            {/* صف 2: السعر | التصنيف */}
            <div className="grid grid-cols-2 gap-2.5 w-full min-w-0 box-border">
              <div className="space-y-0.5 min-w-0">
                <label className="text-[11px] font-bold text-slate-400 text-right block">
                  {mode === 'purchase' ? 'سعر الشراء' : 'سعر البيع'}
                </label>
                <input 
                  ref={priceInputRef} 
                  type="number" 
                  step="any" 
                  value={tempPrice} 
                  onChange={e => {
                    manualPriceEditedRef.current = true;
                    setTempPrice(e.target.value);
                  }}
                  onKeyDown={e => focusNextField(e, () => noteInputRef.current)}
                  inputMode="decimal"
                  enterKeyHint="next"
                  className="w-full box-border h-10 bg-slate-50 border border-slate-200 rounded-xl px-2 text-center text-[14px] font-semibold text-[#1E4D4D] outline-none focus:bg-white"
                  placeholder="0.00" 
                />
              </div>

              <div className="space-y-0.5 min-w-0">
                <label className="text-[11px] font-bold text-slate-400 text-right block">التصنيف</label>
                <select 
                  ref={categoryInputRef} 
                  disabled={mode === 'sale'} 
                  value={categoryName} 
                  onChange={e => setCategoryName(e.target.value)} 
                  onKeyDown={e => e.key === 'Enter' && noteInputRef.current?.focus()} 
                  className={`w-full box-border h-10 border border-slate-200 rounded-xl px-2 text-[13px] font-semibold text-[#1E4D4D] outline-none text-right appearance-none ${
                    mode === 'sale' ? 'bg-slate-100/80 cursor-not-allowed opacity-85' : 'bg-slate-50'
                  }`}
                >
                  <option value="">{mode === 'sale' ? categoryName || 'عام' : 'اختر تصنيفاً...'}</option>
                  {categoryName && !['أدوية', 'مستلزمات طبية', 'مستحضر تجميلي', 'مكملات غذائية', 'أجهزة طبية', 'مواد استهلاكية', 'أصناف أخرى'].includes(categoryName) && (
                    <option value={categoryName}>{categoryName}</option>
                  )}
                  {['أدوية', 'مستلزمات طبية', 'مستحضر تجميلي', 'مكملات غذائية', 'أجهزة طبية', 'مواد استهلاكية', 'أصناف أخرى'].map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* شريط الإجمالي المحسوب كبسولة مدمجة */}
            <div className="w-full box-border h-9 bg-emerald-50 border border-emerald-100 rounded-xl flex items-center justify-between px-3.5 flex-shrink-0">
              <span className="text-[11px] font-bold text-emerald-700">إجمالي البند:</span>
              <span className="text-[13px] font-black text-emerald-900">
                {((parseFloat(tempQty as string) || 0) * (parseFloat(tempPrice as string) || 0)).toLocaleString()} {currency}
              </span>
            </div>

            {/* حقل الملاحظة الموفر للمساحة */}
            <div className="w-full box-border">
              <input 
                ref={noteInputRef} 
                value={tempNote} 
                onChange={e => setTempNote(e.target.value)} 
                onKeyDown={e => focusNextField(
                  e,
                  () => document.getElementById('item-entry-modal-save') as HTMLButtonElement | null
                )}
                enterKeyHint="done"
                className="w-full box-border h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-[13px] font-semibold text-[#1E4D4D] outline-none focus:bg-white text-right" 
                placeholder="أضف ملاحظة هنا (اختياري)..." 
              />
            </div>
          </div>

          {/* الأزرار الأساسية */}
          <div className="flex gap-2 px-3.5 pt-2 pb-3 border-t border-slate-100 flex-nowrap w-full box-border bg-white flex-shrink-0 m-0">
            <Button id="item-entry-modal-save" type="button" className="flex-[2] !h-10 !rounded-xl !text-[14px] font-bold" variant="primary" disabled={isSubmitting} onClick={handleFinalize}>
              {isSubmitting ? (
                <div className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>جاري الحفظ...</span>
                </div>
              ) : (
                initialData ? 'تعديل الصنف' : 'إضافة الصنف'
              )}
            </Button>
            <Button className="flex-1 !h-10 !rounded-xl !text-[14px] font-bold" variant="neutral" disabled={isSubmitting} onClick={onClose}>
              إلغاء
            </Button>
          </div>
        </div>
      </Modal>

      {/* نافذة التأكيد للمشتريات */}
      <Modal isOpen={isConfirmNewProductOpen} onClose={() => setIsConfirmNewProductOpen(false)} title="" maxWidth="max-w-[320px] w-[90vw]" noPadding={true} showCloseButton={false} positionClass="items-center">
        <div dir="rtl" className="p-4 text-center space-y-3 bg-white rounded-2xl box-border w-full font-cairo">
          <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-emerald-600">
            <Package size={24} />
          </div>
          <div className="space-y-1">
            <h3 className="text-[15px] font-black text-[#1E4D4D]">صنف غير مسجل!</h3>
            <p className="text-[12px] font-medium text-slate-500 leading-relaxed">
              هل ترغب في تسجيل <span className="text-[#1E4D4D] font-bold underline">{manualItemName}</span> كمنتج جديد في المخزون؟
            </p>
          </div>
          <div className="flex gap-2 pt-1 box-border">
            <button type="button" disabled={isSubmitting} onClick={handleConfirmRegister} className="flex-[2] h-10 bg-[#1E4D4D] text-white rounded-xl text-[13px] font-bold active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
              {isSubmitting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>جاري الحفظ...</span>
                </>
              ) : (
                'نعم، سجل الآن'
              )}
            </button>
            <button type="button" disabled={isSubmitting} onClick={() => setIsConfirmNewProductOpen(false)} className="flex-1 h-10 bg-slate-100 text-slate-600 rounded-xl text-[13px] font-bold active:scale-95 transition-all disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default ItemEntryModal;
