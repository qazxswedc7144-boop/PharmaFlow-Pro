import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Printer, PlusCircle, ArrowRight, ShieldCheck, Eye } from 'lucide-react';

interface SaveSuccessModalProps {
  isOpen: boolean;
  invoiceNumber: string;
  totalAmount: number;
  currency: string;
  type: 'SALE' | 'PURCHASE';
  date?: string;
  partnerName?: string;
  accountingStatus?: string;
  inventoryStatus?: string;
  balanceStatus?: string;
  onClose: () => void;
  onNewInvoice: () => void;
  onViewInvoice?: () => void;
}

export const SaveSuccessModal: React.FC<SaveSuccessModalProps> = ({
  isOpen,
  invoiceNumber,
  totalAmount,
  currency,
  type,
  date,
  partnerName,
  accountingStatus = 'مرحل ومقفل بنجاح',
  onClose,
  onNewInvoice,
  onViewInvoice
}) => {
  if (!isOpen) return null;

  const displayDate = date || new Date().toISOString().split('T')[0];
  const displayPartner = partnerName || (type === 'SALE' ? 'عميل كاشير عام' : 'مورد غير محدد');

  return (
    <AnimatePresence>
      <div 
        className="fixed inset-0 z-[9999] flex items-start justify-center p-4 pt-[15vh] bg-slate-900/50 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        dir="rtl"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ type: "spring", stiffness: 450, damping: 25 }}
          className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 shadow-2xl overflow-hidden text-center"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Top colored visual bar representing high-integrity ERP system state */}
          <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-[#1E4D4D]" />

          <div className="p-5">
            {/* Pulsing Emerald Success Badge */}
            <div className="relative mx-auto w-12 h-12 mb-3 flex items-center justify-center bg-emerald-50 text-emerald-600 rounded-full shadow-inner">
              <CheckCircle2 size={28} className="stroke-[2.5]" />
            </div>

            <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1 leading-tight flex items-center justify-center gap-2">
              <ShieldCheck size={18} className="text-emerald-500" />
              <span>تم حفظ المستند المحاسبي بنجاح ✅</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">
              تم تدوين الحركة وتدقيقها محاسبياً ومستودعياً وفق القيد المزدوج السيادي.
            </p>

            {/* Comprehensive Detail Table 2.0 to deliver professional ERP audit values */}
            <div className="bg-slate-50 dark:bg-gray-800/50 rounded-xl border border-slate-100 dark:border-gray-800/80 p-3.5 space-y-2 text-right text-xs mb-4">
              
              <div className="flex justify-between items-center py-1 border-b border-dashed border-slate-200 dark:border-gray-800">
                <span className="font-extrabold text-slate-400">رقم الفاتورة:</span>
                <span className="font-mono font-black text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-gray-850 px-2 py-0.5 rounded-md">
                  #{invoiceNumber}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-dashed border-slate-200 dark:border-gray-800">
                <span className="font-extrabold text-slate-400">نوع العملية:</span>
                <span className="font-black text-indigo-600 dark:text-indigo-400">
                  {type === 'SALE' ? 'مبيعات نقدية' : 'توريد مشتريات'} — <span className="font-mono text-slate-500">{displayDate}</span>
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-dashed border-slate-200 dark:border-gray-800">
                <span className="font-extrabold text-slate-400">الطرف الآخر:</span>
                <span className="font-black text-slate-600 dark:text-slate-300">
                  {displayPartner}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-dashed border-slate-200 dark:border-gray-800">
                <span className="font-extrabold text-slate-400">القيمة الإجمالية:</span>
                <span className="text-sm font-mono font-black text-emerald-600 dark:text-emerald-400">
                  {Number(totalAmount).toLocaleString()} {currency}
                </span>
              </div>

              <div className="flex justify-between items-center py-1">
                <span className="font-extrabold text-slate-400">الحالة:</span>
                <span className="font-extrabold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  {accountingStatus}
                </span>
              </div>
            </div>

            {/* Quick Actions Panel */}
            <div className="flex flex-col gap-2.5">
              <button
                onClick={onNewInvoice}
                className="w-full py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm font-bold shadow-lg shadow-teal-600/10 active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                <PlusCircle size={15} />
                <span>إنشاء مستند جديد [فارغ]</span>
              </button>

              <div className="flex gap-3 w-full">
                <button
                  onClick={() => {
                    window.print();
                  }}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-xl text-sm font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all active:scale-95 border border-slate-100 dark:border-gray-750"
                >
                  <Printer size={15} className="text-teal-600 dark:text-emerald-400" />
                  <span>طباعة</span>
                </button>

                {onViewInvoice && (
                  <button
                    onClick={onViewInvoice}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-xl text-sm font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all active:scale-95 border border-slate-100 dark:border-gray-750"
                  >
                    <Eye size={15} className="text-indigo-500" />
                    <span>عرض</span>
                  </button>
                )}

                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-xl text-sm font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all active:scale-95 border border-slate-100 dark:border-gray-750"
                >
                  <ArrowRight size={15} className="text-slate-500" />
                  <span>إغلاق</span>
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
