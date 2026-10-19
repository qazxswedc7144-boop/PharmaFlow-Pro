import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { FileDown, RefreshCw, Trash2, Calendar, FileText } from 'lucide-react';

interface DraftRecoveryDialogProps {
  isOpen: boolean;
  moduleName: string;
  updatedAt: string;
  itemCount: number;
  totalAmount?: number;
  onRestore: () => void;
  onDiscard: () => void;
}

export const DraftRecoveryDialog: React.FC<DraftRecoveryDialogProps> = ({
  isOpen,
  moduleName,
  updatedAt,
  itemCount,
  totalAmount,
  onRestore,
  onDiscard
}) => {
  if (!isOpen) return null;

  const dateStr = new Date(updatedAt).toLocaleString('ar-EG', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  return (
    <AnimatePresence>
      <div 
        className="fixed inset-0 z-[9999] flex items-start justify-center p-4 pt-[15vh] bg-slate-900/50 backdrop-blur-xs text-slate-800 dark:text-slate-100"
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
          {/* Top warning ribbon */}
          <div className="h-1.5 w-full bg-amber-500" />

          <div className="p-5">
            {/* Visual Icon Badge */}
            <div className="mx-auto w-12 h-12 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 rounded-full flex items-center justify-center mb-3 shadow-inner">
              <FileDown size={24} className="stroke-[2.5]" />
            </div>

            <h3 className="text-base font-bold text-slate-800 dark:text-amber-400 mb-1 leading-tight">
              تم العثور على مسودة غير محفوظة 💾
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 leading-relaxed">
              لقد تم الاحتفاظ بنسخة حية احتياطية لجلسة العمل السابقة في <span className="font-extrabold text-[#1E4D4D] dark:text-slate-350">{moduleName}</span> لتجنب فقدان البيانات.
            </p>

            {/* Brief info summary container */}
            <div className="bg-slate-50 dark:bg-gray-800/40 rounded-xl p-3.5 border border-slate-100 dark:border-gray-800/60 text-right text-xs space-y-2.5 mb-4 leading-tight">
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <Calendar size={13} className="text-amber-500" />
                <span className="font-extrabold text-slate-400">آخر تحديث:</span>
                <span className="font-mono font-black select-all ml-auto text-slate-700 dark:text-slate-250">
                  {dateStr}
                </span>
              </div>

              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <FileText size={13} className="text-amber-500" />
                <span className="font-extrabold text-slate-400">محتويات النسخة:</span>
                <span className="font-bold ml-auto text-slate-700 dark:text-slate-250">
                  {itemCount} أصناف محاسبية
                </span>
              </div>

              {totalAmount !== undefined && (
                <div className="flex justify-between items-center pt-2 border-t border-dashed border-slate-200 dark:border-gray-800 text-slate-600 dark:text-slate-300">
                  <span className="font-extrabold text-slate-400">إجمالي الفاتورة:</span>
                  <span className="font-mono font-black text-emerald-600 dark:text-emerald-400">
                    {Number(totalAmount).toLocaleString()}
                  </span>
                </div>
              )}
            </div>

            {/* Bottom actions list */}
            <div className="flex gap-3 w-full mt-5">
              <button
                onClick={onRestore}
                className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 active:scale-[0.98] text-white rounded-xl text-sm font-bold shadow-lg shadow-teal-600/10 transition-all flex items-center justify-center gap-1.5"
              >
                <RefreshCw size={14} />
                <span>استعادة المسودة</span>
              </button>

              <button
                onClick={onDiscard}
                className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-gray-800 dark:hover:bg-gray-700 active:scale-[0.98] border border-slate-100 dark:border-gray-750 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-1.5"
              >
                <Trash2 size={14} className="text-red-500" />
                <span>تجاهل وحذف</span>
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
