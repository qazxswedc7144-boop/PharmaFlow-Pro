import React from 'react';
import { motion } from 'motion/react';
import { Trash2, Clock } from 'lucide-react';
import { InvoiceItem } from '@/types';
import { normalizeToISODate, formatExpiryDateDisplay, getExpiryStatus } from '@/utils/expiryUtils';

// Compact horizontal row aligned with the purchase invoice item table.
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
}) => {
  const rawExpiry = item.expiryDate || (item as any).ExpiryDate || (item as any).expiry_date || (item as any).expirationDate || '';
  const expiryDate = normalizeToISODate(rawExpiry);
  const formattedExpiry = formatExpiryDateDisplay(expiryDate);
  const expiryStatus = getExpiryStatus(expiryDate);
  const displayName = item.name || item.productName || (item as any).Name || '---';
  const quantity = Number(item.qty ?? (item as any).quantity ?? 0);
  const price = Number(item.price ?? (item as any).unitPrice ?? 0);
  const total = Number(item.sum ?? (item as any).subtotal ?? (quantity * price));

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex items-center px-4 py-2.5 hover:bg-slate-50/50 transition-colors cursor-pointer w-full group relative min-h-[52px]"
      onClick={() => {
        if (!isLocked && !isRecovery) onClick();
      }}
    >
      <div className="flex-[2] flex flex-col min-w-0 pr-1 text-right justify-center">
        <span className="text-[10px] sm:text-[11px] font-black text-[#1E4D4D] leading-snug break-words whitespace-normal select-text">
          {displayName}
        </span>
        {expiryDate && (
          <div className={`text-[9px] font-bold flex items-center gap-1 mt-1 leading-none ${
            expiryStatus.isExpired
              ? 'text-red-600 font-black'
              : expiryStatus.isNearExpiry
                ? 'text-amber-600 font-black'
                : 'text-slate-400 font-medium'
          }`}>
            <Clock size={10} className="shrink-0" />
            <span className="truncate">انتهاء: {formattedExpiry}</span>
          </div>
        )}
      </div>

      <div className="flex-1 text-center font-black">
        <span className={`text-[9px] sm:text-[10px] font-black rounded-md px-1 sm:px-2 py-0.5 inline-block ${
          quantity < 5 ? 'bg-orange-100 text-orange-600' : 'bg-slate-100 text-[#1E4D4D]'
        }`}>
          {quantity.toLocaleString()}
        </span>
      </div>

      <div className="flex-1 text-center text-[9px] sm:text-[10px] font-black text-slate-600">
        {price.toLocaleString()}
      </div>

      <div className="flex-1 text-center text-[9px] sm:text-[10px] font-black text-[#1E4D4D]">
        {total.toLocaleString()}
      </div>

      <div className="w-10 flex items-center justify-center shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(idx);
          }}
          className="p-1.5 text-red-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
          title="حذف الصنف"
          aria-label="حذف الصنف"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </motion.div>
  );
});
