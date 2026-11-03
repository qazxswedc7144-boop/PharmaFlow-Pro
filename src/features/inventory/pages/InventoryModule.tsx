
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useInventory, useUI, useAccounting } from '@/contexts/AppContext';
import { Product, PriceHistory, Purchase, InventoryTransaction, WarehouseStock } from '@/types';
import { ProductRepository } from '@features/inventory/services/ProductRepository';
import { db } from '@/core/db';
import { PurchaseRepository } from '@/database/repositories/PurchaseRepository';
import { InventoryService } from '@features/inventory/services/InventoryService';
import { authService } from '@features/auth/services/authService';
import { Modal, Badge } from '@/components/shared/SharedUI';
import { FixedSizeList as List } from 'react-window';
import { 
  TrendingUp, Layers, ArrowRight, Plus, 
  AlertCircle, History, 
  Warehouse as WarehouseIcon, Settings2, ArrowRightLeft, MinusCircle, PlusCircle,
  ChevronRight, Box, ClipboardCheck, Save, Users, ShoppingCart, Search, ScanBarcode, PackageSearch,
  AlertTriangle, XCircle, Clock3
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PullToRefresh } from '@/components/shared/PullToRefresh';

import { AutoReorderModal } from '../components/AutoReorderModal';
import { ProductDrillDownModal } from '../components/ProductDrillDownModal';

const InventoryModule: React.FC<{ onNavigate?: (view: string, params?: Record<string, unknown>) => void }> = ({ onNavigate }) => {
  const { products, categories } = useInventory();
  const { suppliers } = useAccounting();
  const { refreshGlobal, addToast, currency } = useUI();
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isLoading, setIsLoading] = useState(true);
  const [drillDownProductId, setDrillDownProductId] = useState<string | null>(null);

  // Optimize loading state - use products.length as dependency to avoid flickering on reference changes
  useEffect(() => {
    if (products.length > 0) {
      setIsLoading(false);
    } else {
      // Small timeout to allow async products to load before showing empty state
      const timer = setTimeout(() => setIsLoading(false), 800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [products.length]);

  const handleProductClick = useCallback((product: Product) => {
    setEditingProduct(product);
    setActiveTab('details');
  }, []);
  
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isBarcodeScannerOpen, setIsBarcodeScannerOpen] = useState(false);
  const [barcodeScannerError, setBarcodeScannerError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!isBarcodeScannerOpen) return;

    let cancelled = false;
    let animationFrameId: number | null = null;
    let isDetecting = false;

    const stopCamera = () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      scannerStreamRef.current?.getTracks().forEach(track => track.stop());
      scannerStreamRef.current = null;
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
    };

    const startScanner = async () => {
      const BarcodeDetectorConstructor = (window as Window & {
        BarcodeDetector?: new (options?: { formats?: string[] }) => {
          detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
        };
      }).BarcodeDetector;

      if (!navigator.mediaDevices?.getUserMedia) {
        setBarcodeScannerError('يتطلب تشغيل الكاميرا اتصالاً آمناً (HTTPS) ومتصفحاً يدعم الوصول إلى الكاميرا.');
        return;
      }

      if (!BarcodeDetectorConstructor) {
        setBarcodeScannerError('ميزة قراءة الباركود غير مدعومة في هذا المتصفح. جرّب أحدث إصدار من Chrome على الهاتف.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } }
        });

        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        scannerStreamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play();

        const detector = new BarcodeDetectorConstructor({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code']
        });

        const scanFrame = async () => {
          if (cancelled || isDetecting || !videoRef.current) return;
          isDetecting = true;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes.find(code => code.rawValue)?.rawValue?.trim();
            if (value) {
              setSearch(value);
              setDebouncedSearch(value);
              setIsBarcodeScannerOpen(false);
              return;
            }
          } catch (error) {
            console.warn('Barcode detection frame failed:', error);
          } finally {
            isDetecting = false;
          }
          if (!cancelled) animationFrameId = requestAnimationFrame(scanFrame);
        };

        animationFrameId = requestAnimationFrame(scanFrame);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof DOMException ? error.name : '';
        setBarcodeScannerError(
          name === 'NotAllowedError' || name === 'PermissionDeniedError'
            ? 'لم يتم السماح بالوصول إلى الكاميرا. امنح المتصفح إذن الكاميرا ثم حاول مجدداً.'
            : name === 'NotFoundError'
              ? 'لم يتم العثور على كاميرا متاحة في هذا الجهاز.'
              : 'تعذر تشغيل الكاميرا. تحقق من الأذونات ثم حاول مرة أخرى.'
        );
        stopCamera();
      }
    };

    setBarcodeScannerError('');
    void startScanner();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [isBarcodeScannerOpen]);
  const [sortAsc] = useState(true);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [filterBy] = useState<'all' | 'low' | 'out' | 'expired'>('all');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'all' | 'low' | 'out' | 'expiring'>('all');
  const [isAutoReorderOpen, setIsAutoReorderOpen] = useState(false);

  const lowStockProducts = useMemo(() => {
    return products.filter(p => {
      const currentStock = p.stock ?? p.StockQuantity ?? p.stock_qty ?? 0;
      const minLevel = p.MinLevel ?? p.minStockLevel ?? p.minStock ?? 5;
      return currentStock <= minLevel;
    });
  }, [products]);

  const handleAutoReorderClick = useCallback(() => {
    if (lowStockProducts.length === 0) {
      addToast("جميع الأصناف رصيدها أعلى من الحد الأدنى، لا يوجد أصناف بحاجة لإعادة الطلب 👍", "info");
      return;
    }
    setIsAutoReorderOpen(true);
  }, [lowStockProducts.length, addToast]);

  const [activeTab, setActiveTab] = useState<'details' | 'history' | 'warehouses' | 'adjust' | 'suppliers'>('details');
  const [priceHistory, setPriceHistory] = useState<PriceHistory[]>([]);
  const [purchaseHistory, setPurchaseHistory] = useState<Purchase[]>([]);
  const [movements, setMovements] = useState<InventoryTransaction[]>([]);
  const [warehouseStocks, setWarehouseStocks] = useState<WarehouseStock[]>([]);
  
  const [adjustment, setAdjustment] = useState<{ qty: number; reason: string; type: 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN' }>({ qty: 0, reason: '', type: 'ADJUSTMENT' });

  useEffect(() => {
    const loadProductData = async () => {
      if (editingProduct?.id) {
        try {
          const details = await InventoryService.getProductDetails(editingProduct.id);
          setPriceHistory(details.priceHist);
          setPurchaseHistory(details.purchHist);
          setMovements(details.moves);
          setWarehouseStocks(details.stocks);
        } catch (e) {
          console.error("loadProductData in Inventory failed:", e);
        }
      }
    };
    loadProductData();
  }, [editingProduct]);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(handler);
  }, [search]);

  const categoryFilteredProducts = useMemo(() => {
    const categorizedProducts = InventoryService.filterProducts(products, {
      search: '',
      categoryId: selectedCategoryId,
      filterBy,
      sortAsc
    });

    const normalizedSearch = debouncedSearch.trim().toLowerCase();
    if (!normalizedSearch) return categorizedProducts;

    return categorizedProducts.filter(product =>
      [
        product.Name,
        product.name,
        (product as any).barcode,
        (product as any).sku,
        product.id
      ].some(value =>
        String(value ?? '').toLowerCase().includes(normalizedSearch)
      )
    );
  }, [products, debouncedSearch, sortAsc, filterBy, selectedCategoryId]);

  const isExpiringSoon = useCallback((product: Product) => {
    const rawExpiry = (product as any).expiryDate || (product as any).ExpiryDate || (product as any).expiry_date || (product as any).expirationDate || '';
    if (!rawExpiry) return false;
    const expiryTime = new Date(rawExpiry).getTime();
    if (!Number.isFinite(expiryTime)) return false;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const thirtyDaysFromNow = today + (30 * 24 * 60 * 60 * 1000);
    return expiryTime >= today && expiryTime <= thirtyDaysFromNow;
  }, []);

  const inventoryKpis = useMemo(() => {
    let low = 0;
    let out = 0;
    let expiring = 0;

    categoryFilteredProducts.forEach(product => {
      const currentStock = Number(product.stock ?? product.StockQuantity ?? product.stock_qty ?? 0);
      const minLevel = Number(product.MinLevel ?? product.minStockLevel ?? product.minStock ?? 10);
      if (currentStock <= 0) {
        out += 1;
      } else if (currentStock <= minLevel) {
        low += 1;
      }
      if (isExpiringSoon(product)) {
        expiring += 1;
      }
    });

    return {
      total: categoryFilteredProducts.length,
      low,
      out,
      expiring
    };
  }, [categoryFilteredProducts, isExpiringSoon]);

  const filteredProducts = useMemo(() => {
    if (statusFilter === 'all') return categoryFilteredProducts;

    return categoryFilteredProducts.filter(product => {
      const currentStock = Number(product.stock ?? product.StockQuantity ?? product.stock_qty ?? 0);
      const minLevel = Number(product.MinLevel ?? product.minStockLevel ?? product.minStock ?? 10);

      if (statusFilter === 'out') return currentStock <= 0;
      if (statusFilter === 'low') return currentStock > 0 && currentStock <= minLevel;
      if (statusFilter === 'expiring') return isExpiringSoon(product);
      return true;
    });
  }, [categoryFilteredProducts, statusFilter, isExpiringSoon]);

  const handleAdjustment = async () => {
    if (!editingProduct || adjustment.qty === 0) return;
    
    try {
      const user = authService.getCurrentUser();
      await InventoryService.recordMovement({
        type: 'ADJUSTMENT',
        productId: editingProduct.id,
        warehouseId: 'WH-MAIN',
        quantity: adjustment.qty,
        sourceDocId: `ADJ-${Date.now()}`,
        sourceDocType: 'ADJUSTMENT',
        userId: user?.User_Email || 'SYSTEM',
        notes: adjustment.reason || 'Manual Adjustment'
      });
      
      addToast("تم تنفيذ التسوية المخزنية بنجاح ✅", "success");
      
      refreshGlobal();
      setEditingProduct(null);
      setAdjustment({ qty: 0, reason: '', type: 'ADJUSTMENT' });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addToast(errMsg || "فشل تنفيذ التسوية", "error");
    }
  };

const ProductItem = React.memo(({ product, currency, onClick, onInspect }: { product: Product, currency: string, onClick: () => void, onInspect: (e: React.MouseEvent) => void }) => {
  const lastRealPurchasePrice = PurchaseRepository.getLastPurchasePriceForItem(product.id);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white border border-slate-100 rounded-3xl h-full flex items-center justify-between px-4 sm:px-10 shadow-sm hover:shadow-xl hover:border-[#1E4D4D]/20 transition-all group cursor-pointer active:scale-[0.99]"
      onClick={onClick}
    >
        <div className="flex items-center gap-3 sm:gap-8 flex-1 min-w-0">
          <div className="w-12 sm:w-16 h-12 sm:h-16 shrink-0 bg-slate-50 text-[#1E4D4D] rounded-2xl flex items-center justify-center text-2xl shadow-inner group-hover:scale-105 transition-transform">
            <Box size={26} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 
              onClick={(e) => {
                e.stopPropagation();
                onInspect(e);
              }}
              className="text-base sm:text-lg font-black text-[#1E4D4D] hover:text-emerald-700 hover:underline cursor-pointer truncate leading-tight mb-1"
              title="انقر لعرض تفاصيل التتبع والعملاء والموردين"
            >
              {product.name || product.Name}
            </h3>
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-nowrap">
                <p className="hidden sm:block text-[10px] font-black text-slate-400 uppercase tracking-widest truncate">ID: {product.id}</p>
                <div className="hidden sm:block w-1.5 h-1.5 bg-slate-200 rounded-full"></div>
                <Badge variant={(product.stock || product.StockQuantity || 0) <= (product.MinLevel || 5) ? 'danger' : 'info'} className="!rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-tight truncate">
                {product.categoryName || 'بدون تصنيف'}
                </Badge>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-10 shrink-0">
          <button
            type="button"
            onClick={onInspect}
            title="تتبع الصنف والموردين وحركات المخزون والمطابقة"
            className="p-2 sm:px-3.5 sm:py-2 rounded-2xl bg-emerald-50 text-emerald-800 hover:bg-[#1E4D4D] hover:text-white border border-emerald-100/80 transition-all text-xs font-black flex items-center gap-1.5 shadow-sm active:scale-95 z-10"
          >
            <History size={14} />
            <span className="hidden md:inline">تتبع ومطابقة</span>
          </button>

          <div className="text-center hidden lg:block border-r border-slate-50 pr-8">
              <p className="text-[11px] font-black text-slate-300 uppercase mb-1 tracking-tight flex items-center justify-center gap-2">
              <TrendingUp size={12}/> آخر تكلفة
              </p>
              <p className="text-[11px] font-black text-[#1E4D4D]">
                {lastRealPurchasePrice ? `${lastRealPurchasePrice.toLocaleString()} ${currency}` : '---'}
              </p>
          </div>
          <div className="text-center w-20 sm:w-32">
              <p className="text-[10px] sm:text-[11px] font-black text-slate-300 uppercase mb-1 tracking-tight">الرصيد الحالي</p>
              <div className="flex items-center justify-center gap-1 sm:gap-2">
                <p className={`text-xl sm:text-[12px] font-black ${(product.stock || product.StockQuantity || 0) <= (product.MinLevel || 5) ? 'text-red-500' : 'text-[#1E4D4D]'}`}>{product.stock || product.StockQuantity}</p>
                <span className="hidden sm:inline text-[11px] font-black text-slate-400 uppercase">{product.DefaultUnit || 'حبة'}</span>
              </div>
          </div>
          <div className="w-9 sm:w-12 h-9 sm:h-12 bg-slate-50 text-slate-300 rounded-xl sm:rounded-2xl flex items-center justify-center group-hover:bg-[#1E4D4D] group-hover:text-white transition-all shadow-sm">
            <ChevronRight size={20} />
          </div>
        </div>
    </motion.div>
  );
});

  return (
    <div className="flex flex-col min-h-full h-full bg-[#F8FAFA] font-cairo w-full relative" dir="rtl">
      <header className="p-3 sm:p-8 pb-3 sm:pb-5 shrink-0 bg-white border-b border-slate-100 z-20">
        <div className="flex items-center w-full mb-3 sm:mb-5 relative">
          <button 
            onClick={() => onNavigate?.('dashboard')}
            className="w-11 h-11 sm:w-14 sm:h-14 bg-white border-2 border-slate-50 text-[#1E4D4D] rounded-2xl sm:rounded-[24px] flex items-center justify-center shadow-lg shadow-slate-200/40 active:scale-95 active:bg-slate-100 hover:bg-slate-50 transition-all z-10"
          >
            <ArrowRight size={22} strokeWidth={3.5} />
          </button>
          <div className="w-[8%] sm:w-[15%] shrink-0" />
          <div className="flex-1 flex items-center justify-center gap-2 sm:gap-4 min-w-0">
            <div className="w-11 h-11 sm:w-14 sm:h-14 shrink-0 bg-[#1E4D4D] text-white rounded-2xl sm:rounded-[24px] flex items-center justify-center shadow-2xl shadow-emerald-900/30">
              <Layers size={24} />
            </div>
            <div className="flex min-w-0 flex-col items-start pb-2">
              <h2 className="text-base sm:text-2xl font-black text-[#1E4D4D] tracking-tight leading-tight whitespace-nowrap">المستودع الرقمي</h2>
              <p className="text-[9px] sm:text-[11px] text-slate-300 font-bold uppercase tracking-widest mt-1.5 sm:mt-2 truncate">Digital Inventory System</p>
            </div>
          </div>
          <div className="w-[8%] sm:w-[15%] shrink-0" />
          <div className="w-11 sm:w-14 shrink-0" />
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-wrap lg:flex-nowrap">
          <div className="basis-full lg:basis-[45%] relative group">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={18} />
            <input 
              className="w-full h-14 sm:h-16 bg-slate-50 border-2 border-slate-50 rounded-2xl sm:rounded-[32px] pr-11 pl-12 text-sm sm:text-[11px] font-black focus:bg-white focus:border-[#1E4D4D] outline-none shadow-sm transition-all" 
              placeholder="بحث عن صنف..." 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
            />
            <button
              type="button"
              onClick={() => setIsBarcodeScannerOpen(true)}
              title="مسح الباركود بالكاميرا"
              aria-label="مسح الباركود بالكاميرا"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl bg-white border border-slate-100 text-[#1E4D4D] flex items-center justify-center hover:bg-emerald-50 active:scale-95 transition-all"
            >
              <ScanBarcode size={18} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:gap-3 flex-1 w-full lg:w-auto min-w-0">
            <button onClick={() => { 
              const newId = db.generateId('PROD');
              setEditingProduct({ id: newId, name: '', Name: '', DefaultUnit: 'حبة', LastPurchasePrice: 0, TaxDefault: 15, price: 0, CostPrice: 0, stock: 0, StockQuantity: 0, ExpiryDate: '', MinLevel: 5, categoryName: 'أدوية', categoryId: 'CAT-MED' } as any); 
              setActiveTab('details'); 
            }} className="min-w-0 h-14 sm:h-16 bg-[#1E4D4D] text-white rounded-2xl sm:rounded-[32px] flex items-center justify-center gap-1 sm:gap-2 text-[10px] sm:text-[11px] font-black shadow-xl shadow-emerald-900/20 hover:scale-[1.02] active:scale-95 transition-all px-2 sm:px-4">
              <Plus size={19} /><span className="truncate">إضافة</span>
            </button>
            <button onClick={() => onNavigate?.('inventory-audit')} className="min-w-0 h-14 sm:h-16 bg-white border-2 border-slate-50 text-[#1E4D4D] rounded-2xl sm:rounded-[32px] flex items-center justify-center gap-1 sm:gap-2 text-[10px] sm:text-[11px] font-black shadow-sm hover:bg-slate-50 active:scale-95 transition-all px-2 sm:px-4">
              <ClipboardCheck size={19} /><span className="truncate">جرد</span>
            </button>
            <button onClick={handleAutoReorderClick} className={`min-w-0 h-14 sm:h-16 border-2 rounded-2xl sm:rounded-[32px] flex items-center justify-center gap-1 sm:gap-2 text-[10px] sm:text-[11px] font-black shadow-sm active:scale-95 transition-all px-2 sm:px-4 relative group ${lowStockProducts.length > 0 ? 'bg-emerald-50 text-[#1E4D4D] border-emerald-200 hover:bg-[#1E4D4D] hover:text-white' : 'bg-white border-slate-50 text-slate-500 hover:bg-slate-50'}`} title="إنشاء مسودة طلب شراء تلقائي بناءً على الحد الأدنى للرصيد">
              <ShoppingCart size={18} className={lowStockProducts.length > 0 ? 'text-emerald-700 group-hover:text-white transition-colors shrink-0' : 'text-slate-400 shrink-0'} />
              <span className="truncate">طلب</span>
              {lowStockProducts.length > 0 && <span className="bg-red-500 text-white text-[9px] sm:text-[10px] font-black px-1.5 sm:px-2 py-0.5 rounded-full shadow-md animate-pulse shrink-0">{lowStockProducts.length}</span>}
            </button>
          </div>
        </div>

        <div className="mt-4 sm:mt-5 grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <div className="bg-white border border-slate-100 rounded-2xl p-3 sm:p-4 shadow-sm flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-slate-50 text-[#1E4D4D] flex items-center justify-center shrink-0"><Box size={18} /></div>
            <div className="min-w-0"><p className="text-[9px] sm:text-[10px] font-black text-slate-400">إجمالي الأصناف</p><p className="text-lg sm:text-xl font-black text-[#1E4D4D] leading-tight">{inventoryKpis.total}</p></div>
          </div>
          <div className="bg-orange-50 border border-orange-100 rounded-2xl p-3 sm:p-4 shadow-sm flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center shrink-0"><AlertTriangle size={18} /></div>
            <div className="min-w-0"><p className="text-[9px] sm:text-[10px] font-black text-orange-700">منخفض المخزون</p><p className="text-lg sm:text-xl font-black text-orange-700 leading-tight">{inventoryKpis.low}</p></div>
          </div>
          <div className="bg-red-50 border border-red-100 rounded-2xl p-3 sm:p-4 shadow-sm flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center shrink-0"><XCircle size={18} /></div>
            <div className="min-w-0"><p className="text-[9px] sm:text-[10px] font-black text-red-700">نافد المخزون</p><p className="text-lg sm:text-xl font-black text-red-700 leading-tight">{inventoryKpis.out}</p></div>
          </div>
          <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3 sm:p-4 shadow-sm flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0"><Clock3 size={18} /></div>
            <div className="min-w-0"><p className="text-[9px] sm:text-[10px] font-black text-amber-700">قريب الانتهاء</p><p className="text-lg sm:text-xl font-black text-amber-700 leading-tight">{inventoryKpis.expiring}</p></div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1 sm:gap-2 pt-4 sm:pt-5 pb-1">
          {([
            { id: 'all', label: 'الكل', count: inventoryKpis.total },
            { id: 'low', label: 'منخفض', count: inventoryKpis.low },
            { id: 'out', label: 'نافد', count: inventoryKpis.out },
            { id: 'expiring', label: 'قريب الانتهاء', count: inventoryKpis.expiring }
          ] as const).map(filter => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setStatusFilter(filter.id)}
              className={`min-w-0 px-1 sm:px-3 py-2 rounded-xl sm:rounded-full text-[9px] sm:text-[11px] font-black border transition-all flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 text-center leading-tight ${statusFilter === filter.id ? 'bg-[#1E4D4D] text-white border-[#1E4D4D] shadow-md' : 'bg-white text-slate-500 border-slate-100 hover:border-slate-200'}`}
            >
              <span className="truncate max-w-full">{filter.label}</span><span className={statusFilter === filter.id ? 'text-white/70' : 'text-slate-300'}>{filter.count}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto pt-3 pb-2 no-scrollbar scroll-smooth flex-nowrap">
          <button onClick={() => setSelectedCategoryId('ALL')} className={`px-5 sm:px-8 py-2.5 sm:py-3 rounded-full text-[10px] sm:text-[11px] font-black transition-all whitespace-nowrap border-2 ${selectedCategoryId === 'ALL' ? 'bg-[#1E4D4D] text-white border-[#1E4D4D] shadow-lg' : 'bg-white text-slate-400 border-slate-100 hover:border-slate-200'}`}>جميع التصنيفات</button>
          {categories.map(cat => (
            <button key={cat.id} onClick={() => setSelectedCategoryId(cat.id)} className={`px-5 sm:px-8 py-2.5 sm:py-3 rounded-full text-[10px] sm:text-[11px] font-black transition-all whitespace-nowrap border-2 ${selectedCategoryId === cat.id ? 'bg-[#1E4D4D] text-white border-[#1E4D4D] shadow-lg' : 'bg-white text-slate-400 border-slate-100 hover:border-slate-200'}`}>{cat.categoryName}</button>
          ))}
        </div>
      </header>

      {isBarcodeScannerOpen && (
        <div className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="ماسح الباركود">
          <div className="w-full max-w-lg bg-white rounded-3xl overflow-hidden shadow-2xl" dir="rtl">
            <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-100">
              <div>
                <h3 className="text-base font-black text-[#1E4D4D]">مسح الباركود</h3>
                <p className="text-xs text-slate-400 mt-1">وجّه الكاميرا نحو باركود الصنف</p>
              </div>
              <button type="button" onClick={() => setIsBarcodeScannerOpen(false)} className="w-10 h-10 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center" aria-label="إغلاق ماسح الباركود">
                <XCircle size={20} />
              </button>
            </div>
            <div className="p-4">
              {barcodeScannerError ? (
                <div className="min-h-48 flex flex-col items-center justify-center text-center gap-3">
                  <AlertCircle size={30} className="text-amber-500" />
                  <p className="text-sm font-bold text-slate-600">{barcodeScannerError}</p>
                  <button type="button" onClick={() => { setBarcodeScannerError(''); setIsBarcodeScannerOpen(false); window.setTimeout(() => setIsBarcodeScannerOpen(true), 0); }} className="px-5 py-2.5 rounded-xl bg-[#1E4D4D] text-white text-xs font-black">إعادة المحاولة</button>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-2xl bg-black aspect-[4/3]">
                  <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
                  <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-24 border-2 border-emerald-400 rounded-lg shadow-[0_0_0_999px_rgba(0,0,0,0.25)] pointer-events-none" />
                  <p className="absolute bottom-3 inset-x-3 text-center text-xs font-bold text-white drop-shadow">ثبّت الباركود داخل الإطار</p>
                </div>
              )}
              <p className="text-[11px] text-slate-400 text-center mt-3">سيتم إدخال الرقم المقروء في البحث وعرض الصنف المطابق.</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 bg-[#F8FAFA] pt-4 sm:pt-6" ref={containerRef}>
        <PullToRefresh onRefresh={async () => { await refreshGlobal(); }} className="h-full w-full">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 font-black gap-4">
              <div className="w-10 h-10 border-4 border-slate-200 border-t-[#1E4D4D] rounded-full animate-spin"></div>
              <span>جاري التحميل...</span>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[240px] px-6 text-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center">
                <PackageSearch size={30} />
              </div>
              <p className="text-sm sm:text-base font-bold text-slate-500">
                لا توجد أصناف مطابقة لبحثك أو الفلتر المحدد.
              </p>
            </div>
          ) : (
            <List height={containerRef.current?.offsetHeight || 600} itemCount={filteredProducts.length} itemSize={120} width="100%" className="custom-scrollbar" itemKey={(index) => { const p = filteredProducts[index]; return p ? p.id : index.toString(); }}>
              {({ index, style }) => {
                const prod = filteredProducts[index];
                if (!prod) return null;
                return (
                  <div style={style} className="px-3 sm:px-8 py-2 sm:py-3" key={prod.id}>
                    <ProductItem product={prod} currency={currency} onClick={() => handleProductClick(prod)} onInspect={(e) => { e.stopPropagation(); setDrillDownProductId(prod.id); }} />
                  </div>
                );
              }}
            </List>
          )}
        </PullToRefresh>
      </div>

      <AnimatePresence>
        {editingProduct && (
          <Modal isOpen={!!editingProduct} onClose={() => setEditingProduct(null)} title="بطاقات بيانات الأصناف" noPadding>
            <div className="flex flex-col h-[85vh] font-sans" dir="rtl">
              <div className="grid grid-cols-5 gap-1 bg-slate-50 p-2 shrink-0">
                <button onClick={() => setActiveTab('details')} className={`min-w-0 py-2 px-1 rounded-xl text-[9px] sm:text-[11px] font-black flex flex-col items-center justify-center gap-1 transition-all leading-tight ${activeTab === 'details' ? 'bg-white text-[#1E4D4D] shadow-sm' : 'text-slate-400'}`}><Settings2 size={17} /><span>التفاصيل</span></button>
                <button onClick={() => setActiveTab('history')} className={`min-w-0 py-2 px-1 rounded-xl text-[9px] sm:text-[11px] font-black flex flex-col items-center justify-center gap-1 transition-all leading-tight ${activeTab === 'history' ? 'bg-white text-[#1E4D4D] shadow-sm' : 'text-slate-400'}`}><History size={17} /><span>السجل</span></button>
                <button onClick={() => setActiveTab('warehouses')} className={`min-w-0 py-2 px-1 rounded-xl text-[9px] sm:text-[11px] font-black flex flex-col items-center justify-center gap-1 transition-all leading-tight ${activeTab === 'warehouses' ? 'bg-white text-[#1E4D4D] shadow-sm' : 'text-slate-400'}`}><WarehouseIcon size={17} /><span>المستودعات</span></button>
                <button onClick={() => setActiveTab('suppliers')} className={`min-w-0 py-2 px-1 rounded-xl text-[9px] sm:text-[11px] font-black flex flex-col items-center justify-center gap-1 transition-all leading-tight ${activeTab === 'suppliers' ? 'bg-white text-[#1E4D4D] shadow-sm' : 'text-slate-400'}`}><Users size={17} /><span>الموردين</span></button>
                <button onClick={() => setActiveTab('adjust')} className={`min-w-0 py-2 px-1 rounded-xl text-[9px] sm:text-[11px] font-black flex flex-col items-center justify-center gap-1 transition-all leading-tight ${activeTab === 'adjust' ? 'bg-white text-[#1E4D4D] shadow-sm' : 'text-slate-400'}`}><ArrowRightLeft size={17} /><span>تسوية</span></button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 space-y-3 custom-scrollbar">
                {activeTab === 'details' && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      
                      <input className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-[11px] font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all text-right" value={editingProduct.name || editingProduct.Name} onChange={e => setEditingProduct({...editingProduct, name: e.target.value, Name: e.target.value})} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                       <div className="space-y-2">
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">سعر البيع للجمهور</label>
                        <input type="number" className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-[11px] font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all text-center" value={editingProduct.price || editingProduct.UnitPrice} onChange={e => setEditingProduct({...editingProduct, price: parseFloat(e.target.value) || 0, UnitPrice: parseFloat(e.target.value) || 0})} />
                       </div>
                       <div className="space-y-2">
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">الرصيد المتاح</label>
                        <div className="w-full h-14 bg-slate-100 border border-slate-200 rounded-2xl flex items-center px-6 text-[11px] font-black text-slate-500">{editingProduct.stock || editingProduct.StockQuantity}</div>
                       </div>
                    </div>
                    <div className="grid grid-cols-2 gap-8">
                       <div className="space-y-2">
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">الحد الأدنى للطلب</label>
                        <input type="number" className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-[11px] font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all text-center" value={editingProduct.MinLevel} onChange={e => setEditingProduct({...editingProduct, MinLevel: parseFloat(e.target.value) || 0})} />
                       </div>
                       <div className="space-y-2">
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">المورد الرئيسي</label>
                        <select className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-[11px] font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all appearance-none" value={editingProduct.supplierId || ''} onChange={e => { const s = suppliers.find(sup => sup.Supplier_ID === e.target.value); setEditingProduct({...editingProduct, supplierId: e.target.value, supplierName: s?.Supplier_Name || ''}); }}>
                          <option value="">اختر مورداً...</option>
                          {suppliers.map(s => (<option key={s.Supplier_ID} value={s.Supplier_ID}>{s.Supplier_Name}</option>))}
                        </select>
                       </div>
                    </div>
                    <div className="grid grid-cols-2 gap-8">
                       <div className="space-y-2">
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">تاريخ الصلاحية</label>
                        <input type="date" className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-[11px] font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all" value={editingProduct.ExpiryDate} onChange={e => setEditingProduct({...editingProduct, ExpiryDate: e.target.value})} />
                       </div>
                       <div className="space-y-2">
                        <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">التصنيف</label>
                        <select className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-[11px] font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all appearance-none" value={editingProduct.categoryId || ''} onChange={e => { const c = categories.find(cat => cat.id === e.target.value); setEditingProduct({...editingProduct, categoryId: e.target.value, categoryName: c?.categoryName || ''}); }}>
                          <option value="">اختر تصنيفاً...</option>
                          {categories.map(c => (<option key={c.id} value={c.id}>{c.categoryName}</option>))}
                        </select>
                       </div>
                    </div>
                    <div className="pt-4 border-t border-slate-100 space-y-3">
                       <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-[3px]">إحصائيات الأسعار</h4>
                       <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                         <div className="bg-slate-50 rounded-3xl p-4 border border-slate-100">
                           <p className="text-[11px] font-black text-slate-400 mb-2 uppercase tracking-widest">تغيرات الأسعار الأخيرة</p>
                           {priceHistory.length === 0 ? <p className="text-xs font-bold text-slate-300 italic">لا يوجد سجل أسعار متاح</p> : <div className="space-y-3">{priceHistory.map(ph => (<div key={ph.id} className="flex justify-between items-center"><span className="text-[11px] font-bold text-slate-400">{ph.Invoice_Date}</span><span className="text-sm font-black text-[#1E4D4D]">{ph.Price} {currency}</span></div>))}</div>}
                         </div>
                         <div className="bg-slate-50 rounded-3xl p-6 border border-slate-100">
                           <p className="text-[11px] font-black text-slate-400 mb-4 uppercase tracking-widest">آخر عمليات الشراء</p>
                           {purchaseHistory.length === 0 ? <p className="text-xs font-bold text-slate-300 italic">لا يوجد سجل مشتريات متاح</p> : <div className="space-y-3">{purchaseHistory.map(ph => (<div key={ph.id} className="flex justify-between items-center"><span className="text-[11px] font-bold text-slate-400">{(ph.date || '').split('T')[0]}</span><span className="text-sm font-black text-blue-600">{ph.items?.find((it: any) => it.product_id === editingProduct.id)?.price || 0} {currency}</span></div>))}</div>}
                         </div>
                       </div>
                    </div>
                  </div>
                )}

                {activeTab === 'history' && (
                  <div className="space-y-4">
                    <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-[3px]">سجل حركات المخزون</h4>
                    {movements.length === 0 ? (
                      <div className="min-h-[220px] flex items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-bold text-slate-400 text-center px-4">لا توجد حركات مسجلة لهذا الصنف</div>
                    ) : (
                      <>
                    <div className="md:hidden space-y-3">
                      {movements.map(mv => (
                        <div key={mv.TransactionID} className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <Badge variant={mv.TransactionType === 'SALE' ? 'warning' : mv.TransactionType === 'PURCHASE' ? 'success' : 'info'} className="!rounded-full px-3 py-1 text-[10px] font-black">{mv.TransactionType}</Badge>
                            <span className="text-xs font-bold text-slate-500">{new Date(mv.TransactionDate).toLocaleDateString()}</span>
                          </div>
                          <div className="flex items-center justify-between border-t border-slate-50 pt-3">
                            <span className="text-xs font-bold text-slate-400">الكمية</span>
                            <span className={`text-lg font-black ${mv.QuantityChange > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{mv.QuantityChange > 0 ? '+' : ''}{mv.QuantityChange}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="hidden md:block bg-white border border-slate-100 rounded-[32px] overflow-x-auto custom-scrollbar shadow-sm">
                      <table className="w-full text-right min-w-[450px]"><thead className="bg-slate-50 text-[11px] font-black text-slate-400 uppercase tracking-widest"><tr><th className="px-8 py-5">التاريخ</th><th className="px-8 py-5">النوع</th><th className="px-8 py-5 text-center">الكمية</th><th className="px-8 py-5">المستند</th></tr></thead>
                        <tbody className="divide-y divide-slate-50">
                          {movements.map(mv => (<tr key={mv.TransactionID} className="hover:bg-slate-50 transition-colors"><td className="px-8 py-5 text-xs font-bold text-slate-500">{new Date(mv.TransactionDate).toLocaleDateString()}</td><td className="px-8 py-5"><Badge variant={mv.TransactionType === 'SALE' ? 'warning' : mv.TransactionType === 'PURCHASE' ? 'success' : 'info'} className="!rounded-full px-3 py-0.5 text-[9px] font-black">{mv.TransactionType}</Badge></td><td className={`px-8 py-5 text-center text-sm font-black ${mv.QuantityChange > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{mv.QuantityChange > 0 ? '+' : ''}{mv.QuantityChange}</td><td className="px-8 py-5 text-[11px] font-bold text-slate-400">{mv.SourceDocumentID}</td></tr>))}
                        </tbody></table>
                    </div>
                      </>
                    )}
                  </div>
                )}

                {activeTab === 'warehouses' && (
                  <div className="space-y-6">
                    <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-[3px]">توزيع المخزون</h4>
                    <div className="grid grid-cols-1 gap-4">
                      {warehouseStocks.map(ws => (<div key={ws.id} className="bg-white p-8 rounded-[32px] border border-slate-100 flex justify-between items-center shadow-sm"><div className="flex items-center gap-6"><div className="w-14 h-14 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center shadow-inner"><WarehouseIcon size={24} /></div><div><p className="text-sm font-black text-[#1E4D4D]">{ws.warehouseId === 'WH-MAIN' ? 'المستودع الرئيسي' : ws.warehouseId}</p><p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mt-1">آخر تحديث: {new Date(ws.lastUpdated).toLocaleDateString()}</p></div></div><div className="text-left"><p className="text-3xl font-black text-[#1E4D4D]">{ws.quantity}</p><p className="text-[11px] text-slate-300 uppercase font-bold tracking-widest mt-1">Available Units</p></div></div>))}
                      {warehouseStocks.length === 0 && <div className="min-h-[220px] flex items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-bold text-slate-400 text-center px-4">لا توجد بيانات مستودعات متاحة</div>}
                    </div>
                  </div>
                )}

                {activeTab === 'suppliers' && (
                  <div className="space-y-4">
                    <h4 className="text-sm font-black text-[#1E4D4D]">الموردون المرتبطون بهذا الصنف</h4>
                    {editingProduct.supplierId && suppliers.some(s => (s.Supplier_ID || s.id) === editingProduct.supplierId) ? (
                      suppliers.filter(s => (s.Supplier_ID || s.id) === editingProduct.supplierId).map(s => (
                        <div key={s.Supplier_ID || s.id} className="flex items-center gap-3 bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
                          <div className="w-10 h-10 rounded-xl bg-emerald-50 text-[#1E4D4D] flex items-center justify-center shrink-0"><Users size={18} /></div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-black text-[#1E4D4D] truncate">{s.Supplier_Name || s.name || 'مورد'}</p>
                            {(s.Phone || s.phone) && <p className="text-xs text-slate-400 mt-1" dir="ltr">{s.Phone || s.phone}</p>}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="min-h-[180px] flex items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-bold text-slate-400 text-center px-4">لا يوجد مورد مرتبط بهذا الصنف</div>
                    )}
                  </div>
                )}

                {activeTab === 'adjust' && (
                  <div className="space-y-5">
                    <div className="bg-amber-50 border border-amber-100 p-3 sm:p-4 rounded-2xl flex items-start gap-3"><AlertCircle className="text-amber-500 shrink-0" size={20} /><div className="space-y-1"><p className="text-xs font-black text-amber-900">تحذير أمني</p><p className="text-[11px] font-bold text-amber-700 leading-relaxed">عمليات التسوية المخزنية تؤثر مباشرة على الأرصدة والقيود المحاسبية. يرجى التأكد من الكميات والأسباب قبل التأكيد.</p></div></div>
                    <div className="grid grid-cols-1 gap-4">
                      <div className="space-y-3"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-2">نوع التسوية</label><div className="flex bg-slate-100 p-1.5 rounded-2xl gap-2"><button onClick={() => setAdjustment({...adjustment, qty: Math.abs(adjustment.qty)})} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-2 ${adjustment.qty >= 0 ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400'}`}><PlusCircle size={16} /> إضافة</button><button onClick={() => setAdjustment({...adjustment, qty: -Math.abs(adjustment.qty)})} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-2 ${adjustment.qty < 0 ? 'bg-white text-red-500 shadow-sm' : 'text-slate-400'}`}><MinusCircle size={16} /> خصم</button></div></div>
                      <div className="space-y-3"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-2">الكمية</label><input type="number" className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-lg font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all" placeholder="0" value={Math.abs(adjustment.qty)} onChange={e => setAdjustment({...adjustment, qty: (parseFloat(e.target.value) || 0) * (adjustment.qty < 0 ? -1 : 1)})} /></div>
                    </div>
                    <div className="space-y-3"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-2">سبب التسوية</label><input className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-6 text-sm font-black text-[#1E4D4D] outline-none focus:bg-white focus:border-emerald-500 transition-all" placeholder="مثال: تلف، خطأ جرد، هدايا..." value={adjustment.reason} onChange={e => setAdjustment({...adjustment, reason: e.target.value})} /></div>
                    <button onClick={handleAdjustment} className="w-full h-14 rounded-2xl bg-[#1E4D4D] text-white font-black text-sm shadow-lg shadow-emerald-900/20 active:scale-95 transition-all">تأكيد التسوية المخزنية</button>
                  </div>
                )}
              </div>

              {activeTab === 'details' && <div className="p-3 sm:p-5 border-t border-slate-50 shrink-0 flex"><button onClick={async () => { await ProductRepository.save(editingProduct); refreshGlobal(); setEditingProduct(null); addToast("تم تحديث البيانات بنجاح ✅", "success"); }} className="w-fit mr-auto px-8 h-14 bg-[#1E4D4D] text-white rounded-[24px] font-black text-sm shadow-2xl shadow-emerald-900/40 active:scale-95 transition-all flex items-center justify-center gap-3"><Save size={20} /><span>تأكيد وحفظ بيانات الصنف</span></button></div>}
            </div>
          </Modal>
        )}
      </AnimatePresence>

      <AutoReorderModal isOpen={isAutoReorderOpen} onClose={() => setIsAutoReorderOpen(false)} lowStockProducts={lowStockProducts} suppliers={suppliers} onSuccess={() => { refreshGlobal(); }} onNavigateToPurchases={() => onNavigate?.('purchases')} />

      <ProductDrillDownModal isOpen={!!drillDownProductId} onClose={() => setDrillDownProductId(null)} productId={drillDownProductId} currency={currency} onNavigateToInvoice={(invId, type) => { setDrillDownProductId(null); if (type === 'PURCHASE') { onNavigate?.('purchases', { id: invId }); } else { onNavigate?.('sales', { id: invId }); } }} />
    </div>
  );
};

export default InventoryModule;
