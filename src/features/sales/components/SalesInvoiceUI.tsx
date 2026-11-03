
import React from 'react';
import { motion } from 'motion/react';
import { Trash2 } from 'lucide-react';
import { InvoiceItem } from '@/types';

// Memoized Item Row Component for Sales
export const SaleItemRow = React.memo(({ 
  item, 
  onDelete, 
  onClick,
  idx,
  isLocked,
  isRecovery
}: { 
  item: InvoiceItem; 
  onDelete: (idx: number) => void; 
  onClick: () => void;
  idx: number;
  isLocked: boolean;
  isRecovery: boolean;
}) => (
  <motion.div
    initial={{ opacity: 0, x: 20 }}
    animate={{ opacity: 1, x: 0 }}
    exit={{ opacity: 0, x: -20 }}
    className="m-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm hover:border-slate-200 transition-colors cursor-pointer w-auto group relative flex flex-col gap-3"
    onClick={() => {
      if (!isLocked && !isRecovery) {
        onClick();
      }
    }}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 flex flex-col items-start">
        <span className="text-sm font-black text-[#1E4D4D] w-full text-right break-words">{item.name}</span>
        <span className="mt-1 text-xs font-bold text-slate-500">{item.price.toLocaleString()} / سعر الوحدة</span>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(idx);
        }}
        className="w-10 h-10 shrink-0 flex items-center justify-center text-red-600 bg-red-50 hover:bg-red-100 border border-red-100 rounded-xl transition-all"
        title="حذف الصنف"
      >
        <Trash2 size={18} />
      </button>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-xl bg-slate-50 px-3 py-2 flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-500">الكمية</span>
        <span className={`text-sm font-black rounded-lg px-3 py-1 ${
          item.qty < 5 ? 'bg-orange-100 text-orange-600' : 'bg-white text-[#1E4D4D]'
        }`}>
          {item.qty}
        </span>
      </div>
      <div className="rounded-xl bg-emerald-50 px-3 py-2 flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-emerald-700">المجموع</span>
        <span className="text-sm font-black text-[#1E4D4D]">
          {(item.sum ?? (item.qty * item.price) ?? 0).toLocaleString()}
        </span>
      </div>
    </div>
  </motion.div>));
