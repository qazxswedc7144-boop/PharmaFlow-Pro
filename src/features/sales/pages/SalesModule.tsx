
import React from 'react';
import { Modal, Button } from '@/components/shared/SharedUI';
import { ItemEntryModal } from '@features/sales/components/ItemEntryModal';
import PrintMenu from '@/components/shared/PrintMenu';
import { 
  Plus, CheckCircle2, Package, RotateCcw, ArrowRight,
  Percent, User, Search
} from 'lucide-react';
import { useSales } from '@features/sales/hooks/useSales';
import { motion, AnimatePresence } from 'motion/react';
import { DocumentViewer } from '@/components/shared/DocumentViewer';
import { AnimatedNumber } from '@/components/shared/AnimatedNumber';

import { SaleItemRow } from '@features/sales/components/SalesInvoiceUI';
import { UnifiedModal } from '@/components/shared/UnifiedModal';
import { SaveSuccessModal } from '@/components/shared/SaveSuccessModal';
import { DraftRecoveryDialog } from '@/components/shared/DraftRecoveryDialog';
import { useUI } from '@/contexts/AppContext';
import { PullToRefresh } from '@/components/shared/PullToRefresh';
import { InvoiceItemEditModal } from '@/components/shared/InvoiceItemEditModal';
import { Customer, InvoiceItem } from '@/types';

const formatDateDisplay = (dateStr: string) => {
  if (!dateStr) return '';
  const parts = dateStr.includes('-') ? dateStr.split('-') : dateStr.split('/');
  const p0 = parts[0];
  const p1 = parts[1];
  const p2 = parts[2];
  if (p0 !== undefined && p1 !== undefined && p2 !== undefined) {
    const year = p0;
    const month = parseInt(p1, 10);
    const day = parseInt(p2, 10);
    return `${year}/${month}/${day}`;
  }
  return dateStr;
};

const SalesModule: React.FC<{ onNavigate?: (view: string, params?: Record<string, unknown>) => void }> = ({ onNavigate }) => {
  const { refreshGlobal } = useUI();
  const {
    items, setItems,
    manualItemName, setManualItemName,
    tempQty,
    tempPrice,
    selectedIndex, setSelectedIndex,
    tempExpiry,
    tempNote,
    showSearchDropdown, setShowSearchDropdown,
    isDetailModalOpen, setIsDetailModalOpen,
    isConfirmSaveOpen, setIsConfirmSaveOpen,
    isAdjustmentsOpen, setIsAdjustmentsOpen,
    isViewerOpen, setIsViewerOpen,
    salesPolicy,
    isSalesPolicyLoading,
    pricingResult,
    pricingError,
    itemNameInputRef,
    header, setHeader,
    isLocked,
    isSaving,
    vTotalSum,
    filteredProducts,
    selectProduct,
    handleSearchKeyDown,
    handlePost,
    currency,
    isDuplicate,
    selectedProduct,
    setSelectedProduct,
    categoryName,
    isRecovery,
    printData,
    customerSearchTerm,
    showCustomerDropdown, setShowCustomerDropdown,
    isAddCustomerModalOpen,
    newCustomerName,
    filteredCustomers,
    handleCustomerSearch,
    handleCustomerKeyDown,
    selectedCustomerIndex,
    isSearchingCustomers,
    selectCustomer,
    handleCustomerBlur,
    confirmAddCustomer,
    cancelAddCustomer,
    customers,
    saveSuccessData,
    setSaveSuccessData,
    resetInvoiceState,
    isRecoveryModalOpen,
    recoveryDraftData,
    restoreDraft,
    discardDraft
  } = useSales(onNavigate);

  const selectedCustomerObj = customers?.find((c: Customer) => c.id === header.customer_id || (c as any).Supplier_ID === header.customer_id);

  const [editingItem, setEditingItem] = React.useState<InvoiceItem | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = React.useState<boolean>(false);

  const handleAddItem = React.useCallback((item: InvoiceItem & { productId?: string }) => {
    const newItem: InvoiceItem = {
      ...item,
      product_id: item.productId || item.product_id || '',
      parent_id: header.invoice_number,
      row_order: items.length + 1
    };
    
    setItems(prev => {
      // Check if we are updating an existing row in the table
      const existingRowIdx = prev.findIndex(i => i.id === newItem.id);
      const existingRow = prev[existingRowIdx];
      if (existingRowIdx > -1 && existingRow) {
        const updated = [...prev];
        updated[existingRowIdx] = {
          ...existingRow,
          ...newItem,
          row_order: existingRow.row_order
        };
        return updated;
      }

      // Check if item is already present under another index to merge quantities
      const existingIdx = prev.findIndex(i => 
        (i.product_id === newItem.product_id && i.product_id && !i.product_id.startsWith('manual-')) || 
        (i.name === newItem.name && (!i.product_id || i.product_id.startsWith('manual-')))
      );

      const existingItem = prev[existingIdx];
      if (existingIdx > -1 && existingItem) {
        const updated = [...prev];
        updated[existingIdx] = {
          ...existingItem,
          qty: (existingItem.qty || 0) + newItem.qty,
          sum: ((existingItem.qty || 0) + newItem.qty) * (existingItem.price || 0)
        };
        return updated;
      } else {
        return [...prev, newItem];
      }
    });
  }, [header.invoice_number, items.length, setItems]);

  const handleDeleteItem = React.useCallback((idx: number) => {
    setItems(prev => prev.filter((_, i) => i !== idx));
  }, [setItems]);

  const handleRowClick = React.useCallback((item: InvoiceItem) => {
    setEditingItem(item);
    setIsEditModalOpen(true);
  }, []);

  const handleSaveModalData = React.useCallback((updatedItem: InvoiceItem) => {
    setItems((prev: InvoiceItem[]) => prev.map(i => {
      if (i.id === updatedItem.id) {
        return {
          ...i,
          name: updatedItem.name,
          qty: updatedItem.qty,
          price: updatedItem.price,
          expiryDate: updatedItem.expiryDate,
          notes: updatedItem.notes,
          sum: updatedItem.qty * updatedItem.price
        };
      }
      return i;
    }));
    setIsEditModalOpen(false);
    setEditingItem(null);
  }, [setItems]);

  return (
    <div className="flex flex-col h-[100dvh] h-dvh min-h-dvh max-h-dvh bg-white font-cairo w-full relative overflow-hidden select-none" dir="rtl">
      {/* HEADER SECTION - FLAT & FULL WIDTH */}
      <div className="shrink-0 z-30 border-b border-slate-100 bg-white">
        <div className="py-2 px-2 flex items-center justify-between gap-[4px] w-full overflow-hidden">
          {/* Main Toolbar Row */}
          <div className="flex items-center gap-[4px] flex-1">
            <button 
              onClick={() => onNavigate?.('dashboard')} 
              className="w-7 h-7 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center text-[#1E4D4D] hover:bg-slate-100 transition-all shrink-0"
              title="الرجوع للرئيسية"
            >
              <ArrowRight size={16} />
            </button>

            {/* Print and Return buttons container */}
            <div className="flex items-center justify-center gap-[5%] flex-1">
              {/* Print Menu (compact) */}
              <div className="shrink-0 scale-90 origin-right">
                <PrintMenu data={printData} type="SALE" items={items} />
              </div>

              {/* Return Button */}
              <button 
                onClick={() => setHeader({...header, isReturn: !header.isReturn})}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg border transition-all text-[10px] font-black select-none shrink-0 ${
                  header.isReturn 
                    ? 'bg-red-50 border-red-200 text-red-700 shadow-sm' 
                    : 'bg-white border-slate-200 text-slate-400 hover:border-slate-300'
                }`}
              >
                <RotateCcw size={12} className={header.isReturn ? 'animate-spin-slow' : ''} />
                <span>المرتجع</span>
              </button>
            </div>
          </div>

          {/* Right side: Payment Toggle (smaller) */}
          <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 w-[132px] shrink-0">
            <button 
              onClick={() => setHeader({...header, payment_method: 'Cash'})}
              className={`flex-1 py-2 rounded-lg text-xs font-black transition-all relative z-10 ${header.payment_method === 'Cash' ? 'text-white' : 'text-slate-400'}`}
            >
              {header.payment_method === 'Cash' && (
                <motion.div layoutId="payment-bg-sale" className="absolute inset-0 bg-[#1E4D4D] rounded-md -z-10 shadow-sm" />
              )}
              نقداً
            </button>
            <button 
              onClick={() => setHeader({...header, payment_method: 'Credit'})}
              className={`flex-1 py-1 rounded-md text-[9px] font-black transition-all relative z-10 ${header.payment_method === 'Credit' ? 'text-white' : 'text-slate-400'}`}
            >
              {header.payment_method === 'Credit' && (
                <motion.div layoutId="payment-bg-sale" className="absolute inset-0 bg-[#7f1d1d] rounded-md -z-10 shadow-sm" />
              )}
              آجل
            </button>
          </div>
        </div>

        {/* DATA DIVIDERS SECTION */}
        <div className="border-t border-slate-50 overflow-x-visible bg-white">
          <div className="flex flex-row gap-2 items-center w-full px-3 py-2">
            {/* Customer Name Field - Flex expansion */}
            <div className="flex-1 min-w-0 relative bg-white">
              <input 
                disabled={isLocked || isRecovery}
                value={customerSearchTerm ?? ''}
                onChange={(e) => handleCustomerSearch(e.target.value)}
                onKeyDown={handleCustomerKeyDown}
                onFocus={() => setShowCustomerDropdown(true)}
                onBlur={handleCustomerBlur}
                placeholder="اسم العميل..."
                className="w-full h-10 border-b border-gray-400 focus:outline-none focus:border-green-500 rounded-none text-black text-right placeholder-gray-400 bg-transparent pr-1"
              />
              {selectedCustomerObj && (
                <div className="absolute left-1 bottom-1 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-950/45 dark:text-emerald-300 font-sans text-[10px] font-bold border border-emerald-100/50 dark:border-emerald-900/40 shadow-sm pointer-events-none select-none z-10 transition-all">
                  <span>الرصيد:</span>
                  <span className="font-mono">{(selectedCustomerObj.balance || 0).toLocaleString()}</span>
                  <span className="text-[8px] opacity-80">{currency}</span>
                </div>
              )}
              <AnimatePresence>
                {showCustomerDropdown && filteredCustomers.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    className="absolute top-full mt-1 right-0 bg-white border border-slate-100 shadow-2xl z-[9999] overflow-hidden rounded-xl w-[200%] max-w-[450px]"
                  >
                    {isSearchingCustomers ? (
                      <div className="p-4 text-center text-sm font-medium text-slate-400">
                        <div className="w-4 h-4 border-2 border-[#1E4D4D] border-t-transparent rounded-full animate-spin mx-auto mb-1"></div>
                        جاري البحث...
                      </div>
                    ) : filteredCustomers.map((c, idx) => (
                      <button 
                        key={c.id} 
                        onMouseDown={() => selectCustomer(c)}
                        className={`w-full p-2.5 flex items-center gap-3 transition-colors border-b border-slate-50 last:border-0 text-right ${selectedCustomerIndex === idx ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
                      >
                        <span className="text-base font-semibold text-[#1E4D4D]">{c.Supplier_Name}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Date Field - fixed and improved width & padding */}
            <div className="w-[95px] shrink-0 relative h-10 bg-white">
              <input 
                type="date"
                disabled={isLocked || isRecovery}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                value={header.date ?? ''}
                onChange={(e) => setHeader({...header, date: e.target.value})}
              />
              <div className="absolute inset-0 border-b border-gray-400 text-black text-center bg-transparent px-[2px] flex items-center justify-center text-sm font-semibold pointer-events-none">
                {formatDateDisplay(header.date || "") || "التاريخ..."}
              </div>
            </div>
          </div>
          
          <div className="flex border-b border-slate-100 flex-row gap-[2%] px-3 py-2 bg-white">
            <div className="basis-[25%] relative">
               <input 
                type="text"
                value={header.invoice_number ?? ''}
                onChange={(e) => setHeader({...header, invoice_number: e.target.value})}
                placeholder="رقم الفاتورة..."
                className="w-full h-10 border-b border-gray-400 focus:outline-none focus:border-green-500 rounded-none text-black text-right placeholder-gray-400 bg-transparent"
              />
            </div>
            <div className="basis-[73%] relative flex items-center">
              <textarea 
                placeholder="ملاحظات الفاتورة..."
                rows={1}
                value={header.notes || ''}
                onChange={(e) => setHeader({...header, notes: e.target.value})}
                className="w-full h-10 border-b border-gray-400 focus:outline-none focus:border-green-500 rounded-none text-black text-right placeholder-gray-400 resize-none pt-2 bg-transparent pr-2"
              />
              <div className="absolute left-3 flex items-center gap-2">
                {header.attachment && (
                  <button 
                    onClick={() => setIsViewerOpen(true)}
                    className="w-6 h-6 rounded-md overflow-hidden border border-[#1E4D4D]/20 shadow-sm active:scale-95 transition-transform"
                  >
                    <img src={header.attachment} className="w-full h-full object-cover" alt="Thumbnail" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {header.attachment && (
        <DocumentViewer 
          isOpen={isViewerOpen} 
          onClose={() => setIsViewerOpen(false)} 
          image={header.attachment} 
          onDelete={() => setHeader({ ...header, attachment: '' })}
        />
      )}

      {/* ITEM ENTRY AREA - FLATTENED & FIXED */}
      <div className="p-3 border-b border-slate-100 flex items-center justify-between gap-2 shrink-0 bg-white z-20 flex-nowrap">
        <div className="relative flex-1">
          <input 
            ref={itemNameInputRef}
            disabled={isLocked || isRecovery}
            className="w-full h-12 bg-slate-50 border border-slate-100 rounded-xl pr-10 pl-4 text-[11px] font-bold text-[#1E4D4D] focus:bg-white focus:ring-2 focus:ring-[#1E4D4D]/10 transition-all outline-none text-right" 
            placeholder="ابحث عن صنف..." 
            value={manualItemName ?? ''} 
            onChange={e => { setManualItemName(e.target.value); setShowSearchDropdown(true); setSelectedIndex(-1); }} 
            onFocus={() => setShowSearchDropdown(true)}
            onKeyDown={handleSearchKeyDown}
          />
          
          <Search size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 pointer-events-none" />
          <AnimatePresence>
            {showSearchDropdown && filteredProducts.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                className="absolute top-full left-0 right-0 bg-white border border-slate-100 rounded-xl shadow-xl z-[100] mt-1 overflow-hidden"
              >
                {filteredProducts.map((p, idx) => (
                  <button 
                    key={p.id} 
                    onClick={() => selectProduct(p)}
                    className={`w-full px-4 py-3 text-right flex justify-between items-center border-b border-slate-50 last:border-0 transition-colors ${selectedIndex === idx ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
                  >
                    <div>
                      <p className="text-[11px] font-black text-[#1E4D4D]">{p.Name}</p>
                      <p className="text-[11px] font-bold text-slate-400">{p.categoryName || 'عام'}</p>
                    </div>
                    <div className="text-left">
                      <p className="text-[11px] font-black text-emerald-600">{(p as any).price ?? p.UnitPrice ?? 0} {currency}</p>
                    </div>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button 
          disabled={isLocked || isRecovery} 
          onClick={() => setIsDetailModalOpen(true)}
          className="w-12 h-12 bg-[#10B981] text-white rounded-xl flex items-center justify-center shadow-sm hover:bg-emerald-600 active:scale-95 transition-all shrink-0"
        >
          <Plus size={24} />
        </button>
      </div>

      {/* ITEMS LIST SECTION - ONLY SCROLLABLE AREA */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-white">
        <PullToRefresh onRefresh={async () => { await refreshGlobal(); }} className="flex-1 min-h-0 overflow-y-auto bg-white custom-scrollbar flex flex-col">
          <div className="sticky top-0 bg-white/95 backdrop-blur-sm z-10 border-b border-slate-50 flex items-center px-4 py-2 shrink-0">
            <span className="flex-[2] text-[11px] font-black text-slate-400 uppercase tracking-widest text-right">الصنف</span>
            <span className="flex-1 text-[9px] font-black text-slate-400 uppercase tracking-widest text-center">الكمية</span>
            <span className="flex-1 text-[9px] font-black text-slate-400 uppercase tracking-widest text-center">السعر</span>
            <span className="flex-1 text-[9px] font-black text-slate-400 uppercase tracking-widest text-center">الإجمالي</span>
            <span className="w-10"></span>
          </div>
          
          <div className="flex-1 min-h-0 divide-y divide-slate-50">
            <AnimatePresence initial={false}>
              {items.length === 0 ? (
                <div className="py-16 flex flex-col items-center justify-center text-center opacity-25 select-none">
                  <Package size={40} className="mb-2 text-slate-400" />
                  <p className="text-[11px] font-black text-slate-500">قائمة الأصناف فارغة</p>
                </div>
              ) : (
                items.map((item, idx) => (
                  <SaleItemRow 
                    key={item.id || idx}
                    item={item}
                    idx={idx}
                    isLocked={isLocked}
                    isRecovery={isRecovery}
                    onDelete={handleDeleteItem}
                    onClick={() => handleRowClick(item)}
                  />
                ))
              )}
            </AnimatePresence>
          </div>
        </PullToRefresh>
      </div>

      {/* PERFECTLY ALIGNED STICKY FOOTER SECTION - FIXED AT BOTTOM */}
      <div className="shrink-0 sticky bottom-0 w-full z-40 bg-white border-t border-gray-200 p-3 shadow-lg space-y-2 pb-[calc(12px+env(safe-area-inset-bottom,0px))] px-4">
        <div className="flex items-center justify-between flex-nowrap px-2">
          <div className="flex flex-col items-center">
            <span className="text-[10px] font-black text-slate-400 uppercase">الخصم</span>
            <AnimatedNumber value={Number(pricingResult?.discountAmount || 0)} className="text-[10px] font-black text-red-500" />
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[10px] font-black text-slate-400 uppercase">الضريبة</span>
            <AnimatedNumber value={Number(pricingResult?.taxAmount || 0)} className="text-[10px] font-black text-slate-600" />
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[10px] font-black text-slate-500 uppercase">الصافي</span>
            <div className="flex items-baseline gap-1">
              <AnimatedNumber value={vTotalSum} className="text-[10px] font-black text-[#1E4D4D]" />
              <span className="text-[9px] font-black text-slate-500">{currency}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-2 flex-nowrap">
          <button 
            type="button"
            onClick={() => setIsAdjustmentsOpen(true)}
            className="flex-1 h-11 bg-slate-100 text-[#1E4D4D] rounded-xl font-black text-[9px] flex items-center justify-center gap-2 hover:bg-slate-200 active:scale-95 transition-all"
          >
            <div className="flex items-center -space-x-1 rtl:space-x-reverse text-emerald-600">
              <Percent size={15} />
              <Plus size={11} className="mb-0.5" />
            </div>
            <span>سياسة التسعير</span>
          </button>
          <button 
            type="button"
            onClick={() => setIsConfirmSaveOpen(true)} 
            disabled={items.length === 0 || isLocked || isDuplicate || isSaving || isRecovery || isSalesPolicyLoading || !salesPolicy || !!pricingError} 
            className={`flex-[2] h-11 rounded-xl font-black text-[11px] text-white shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 ${isLocked || isDuplicate || isRecovery ? 'bg-red-500 shadow-red-900/20' : 'bg-[#1E4D4D] shadow-emerald-900/20'} disabled:opacity-50`}
          >
            {isSaving ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <CheckCircle2 size={18} />
                <span>حفظ الفاتورة</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* POPUP ITEM ENTRY */}
      <ItemEntryModal 
        isOpen={isDetailModalOpen}
        onClose={() => {
          setIsDetailModalOpen(false);
          setEditingItem(null);
          setSelectedProduct(null);
        }}
        onAdd={(item: any) => handleAddItem(item)}
        mode="sale"
        isReturnMode={header.isReturn}
        customerId={header.customer_id || undefined}
        initialData={editingItem ? {
          id: editingItem.id,
          productId: editingItem.product_id,
          name: editingItem.name,
          qty: editingItem.qty,
          price: editingItem.price,
          expiryDate: editingItem.expiryDate,
          note: (editingItem as any).note || editingItem.notes,
          category: editingItem.category
        } : (selectedProduct ? {
          productId: selectedProduct.id,
          name: manualItemName || selectedProduct.Name || selectedProduct.name,
          qty: tempQty,
          price: tempPrice || selectedProduct.UnitPrice,
          expiryDate: tempExpiry || selectedProduct.ExpiryDate,
          category: categoryName || selectedProduct.categoryName,
          note: tempNote,
          product: { ...selectedProduct, Name: selectedProduct.Name || selectedProduct.name }
        } : null)}
      />

      {/* MODALS - FLATTENED DESIGN */}
      <AnimatePresence>
        {isAddCustomerModalOpen && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" dir="rtl">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ duration: 0.2 }}
              className="bg-white rounded-2xl w-full max-w-[340px] shadow-2xl overflow-hidden p-5 relative"
            >
              <div className="pt-[2px] px-[2px] pb-4 text-center space-y-1 bg-white">
                <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-emerald-500">
                  <User size={24} />
                </div>
                <div className="space-y-[2px]">
                  <h3 className="text-sm font-black text-[#1E4D4D]">عميل جديد؟</h3>
                  <p className="text-[11px] font-bold text-slate-500 leading-relaxed px-2">
                    هل تريد إضافة <span className="text-[#1E4D4D] underline">{newCustomerName}</span> كعميل جديد في النظام؟
                  </p>
                </div>
                <div className="flex gap-[2px] pt-1 px-2">
                  <button
                    onClick={confirmAddCustomer}
                    className="flex-[2] h-10 bg-[#1E4D4D] text-white rounded-xl text-[11px] font-black shadow-md active:scale-95 transition-all"
                  >
                    نعم
                  </button>
                  <button
                    onClick={cancelAddCustomer}
                    className="flex-1 h-10 bg-slate-100 text-slate-500 rounded-xl text-[11px] font-black active:scale-95 transition-all"
                  >
                    لا
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Confirmation Save Modal - Unified Pattern */}
      <AnimatePresence>
        {isConfirmSaveOpen && (
          <UnifiedModal
            saveFunction={handlePost}
            requiredFields={['customer_id', 'invoice_number']}
            formData={header}
            setFormData={setHeader}
            onClose={() => setIsConfirmSaveOpen(false)}
            title="تأكيد حفظ الفاتورة"
            isInvoiceSaveConfirm={true}
            invoiceType="SALE"
            invoiceTotal={vTotalSum}
          >
            <div className="space-y-4">
              <p className="text-[11px] font-bold text-slate-400 text-center">سيتم ترحيل الفاتورة وتحديث المخزون والحسابات.</p>
            </div>
          </UnifiedModal>
        )}

        {/* Save Success Flow overlay */}
        {saveSuccessData && (
          <SaveSuccessModal
            isOpen={!!saveSuccessData}
            invoiceNumber={saveSuccessData.invoiceNumber}
            totalAmount={saveSuccessData.totalAmount}
            currency={currency}
            type="SALE"
            date={saveSuccessData.date}
            partnerName={saveSuccessData.partnerName}
            accountingStatus={saveSuccessData.accountingStatus}
            inventoryStatus={saveSuccessData.inventoryStatus}
            balanceStatus={saveSuccessData.balanceStatus}
            onClose={() => {
              setSaveSuccessData(null);
            }}
            onNewInvoice={() => {
              setSaveSuccessData(null);
              resetInvoiceState();
            }}
          />
        )}

        {/* Live Draft Recovery Dialogue (Task 5) */}
        {isRecoveryModalOpen && recoveryDraftData && (
          <DraftRecoveryDialog
            isOpen={isRecoveryModalOpen}
            moduleName="فاتورة مبيعات الكاشير"
            updatedAt={(recoveryDraftData as any).updatedAt || (recoveryDraftData as any).timestamp || new Date().toISOString()}
            itemCount={((recoveryDraftData as any).payload?.items || (recoveryDraftData as any).items)?.length || 0}
            onRestore={restoreDraft}
            onDiscard={discardDraft}
          />
        )}
      </AnimatePresence>

      {/* TENANT SALES POLICY — read-only */}
      <Modal
        isOpen={isAdjustmentsOpen}
        onClose={() => setIsAdjustmentsOpen(false)}
        title="سياسة تسعير المبيعات"
        maxWidth="max-w-[340px] w-[92vw]"
        positionClass="items-center"
        noPadding={true}
      >
        <div dir="rtl" className="space-y-3 p-4 bg-white rounded-b-3xl">
          {isSalesPolicyLoading ? (
            <p className="text-center text-xs font-bold text-slate-400">جاري تحميل سياسة المؤسسة...</p>
          ) : !salesPolicy ? (
            <p className="text-center text-xs font-bold text-red-600">تعذر تحميل سياسة التسعير. لا يمكن حفظ الفاتورة دون سياسة موثوقة.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-50 p-3 text-center">
                  <span className="block text-[10px] font-bold text-slate-500">الحد الأقصى للخصم</span>
                  <strong className="text-sm text-[#1E4D4D]">{salesPolicy.maxDiscountPercent}%</strong>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 text-center">
                  <span className="block text-[10px] font-bold text-slate-500">نسبة الضريبة</span>
                  <strong className="text-sm text-[#1E4D4D]">{salesPolicy.taxMode === 'NONE' ? '0' : salesPolicy.taxRatePercent}%</strong>
                </div>
              </div>
              <div className="rounded-xl border border-slate-100 p-3 space-y-2">
                <div className="flex justify-between text-xs"><span className="text-slate-500">طريقة الضريبة</span><strong>{salesPolicy.taxMode === 'NONE' ? 'بدون ضريبة' : salesPolicy.taxMode === 'INCLUSIVE' ? 'شاملة' : 'إضافية'}</strong></div>
                <div className="flex justify-between text-xs"><span className="text-slate-500">الخصم المطبق</span><strong>{pricingResult?.discountAmount || '0'} {currency}</strong></div>
                <div className="flex justify-between text-xs"><span className="text-slate-500">الضريبة المحسوبة</span><strong>{pricingResult?.taxAmount || '0'} {currency}</strong></div>
                <div className="flex justify-between text-xs"><span className="text-slate-500">إجمالي الفاتورة</span><strong className="text-[#1E4D4D]">{vTotalSum.toLocaleString()} {currency}</strong></div>
              </div>
              {pricingError && <p className="text-[11px] font-bold text-red-600">تعذر احتساب السعر: {pricingError}</p>}
            </>
          )}
          <Button onClick={() => setIsAdjustmentsOpen(false)} className="w-full !h-11 bg-[#1E4D4D] text-white !rounded-xl font-black text-[13px] mt-1">
            إغلاق
          </Button>
        </div>
      </Modal>

      {/* Item edit modal */}
      <InvoiceItemEditModal 
        isOpen={isEditModalOpen}
        item={editingItem as any}
        mode="sale"
        currency={currency || "YER"}
        onSave={(updatedItem: any) => handleSaveModalData(updatedItem)}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingItem(null);
        }}
      />
    </div>
  );
};
export default SalesModule;
