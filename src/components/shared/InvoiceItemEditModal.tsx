import React, { useState, useEffect } from 'react';
import { normalizeToISODate } from '@/utils/expiryUtils';
import { Edit3, X, Calculator } from 'lucide-react';

export interface InvoiceItem {
  id: string;
  name: string;
  qty: number;
  price: number; // يمثل سعر الشراء أو سعر البيع للمستهلك حسب الشاشة
  expiryDate: string;
  category: string;
  notes?: string;
}

interface InvoiceItemEditModalProps {
  isOpen: boolean;
  item: InvoiceItem | null;
  mode: 'sale' | 'purchase'; // لتخصيص السلوك والعناوين تلقائياً
  currency?: string; // العملة الافتراضية المعتمدة (YER)
  onSave: (updatedItem: InvoiceItem) => void;
  onClose: () => void;
}

export const InvoiceItemEditModal: React.FC<InvoiceItemEditModalProps> = ({
  isOpen,
  item,
  mode,
  currency = "YER",
  onSave,
  onClose
}) => {
  // فصل الحالة الأصلية عن المدخلات للسماح بالتعديل الفوري دون تجميد
  const [localItem, setLocalItem] = useState<InvoiceItem | null>(null);

  useEffect(() => {
    if (item) {
      setLocalItem({ 
        ...item, 
        expiryDate: normalizeToISODate(item.expiryDate),
        notes: item.notes || "" 
      });
    }
  }, [item]);

  if (!isOpen || !localItem) return null;

  const handleFieldChange = (field: keyof InvoiceItem, value: any) => {
    setLocalItem(prev => prev ? { ...prev, [field]: value } : null);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center p-4 pt-[15vh] bg-slate-900/50 backdrop-blur-xs font-sans" dir="rtl">
      <div className="bg-white dark:bg-slate-950 rounded-2xl p-5 w-full max-w-sm max-h-[80vh] overflow-y-auto shadow-2xl border border-slate-100 dark:border-slate-800 animate-in fade-in zoom-in-95 duration-150">
        
        {/* رأس النافذة الديناميكي */}
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <Edit3 size={16} className="text-teal-600" />
            <span>{mode === 'purchase' ? 'تعديل صنف مشتريات' : 'تعديل صنف مبيعات'}</span>
          </h3>
          <button onClick={onClose} className="p-1.5 bg-slate-50 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-all">
            <X size={16} />
          </button>
        </div>
        
        <div className="space-y-3">
          {/* حقل اسم الصنف - مفتوح وقابل للتعديل والتنقل الآن */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">اسم الصنف / الدواء</label>
            <input 
              type="text"
              value={localItem.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              className="w-full p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-white text-xs font-bold focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none transition-all"
              placeholder="أدخل اسم الدواء..."
            />
          </div>

          {/* صف الكمية وتاريخ الصلاحية */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">الكمية</label>
              <input 
                type="number"
                value={localItem.qty === 0 ? '' : localItem.qty}
                onChange={(e) => handleFieldChange('qty', Number(e.target.value))}
                className="w-full p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900 text-center text-slate-800 dark:text-white text-xs font-mono font-bold focus:ring-2 focus:ring-teal-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">تاريخ الصلاحية</label>
              <input 
                type="date"
                value={localItem.expiryDate}
                onChange={(e) => handleFieldChange('expiryDate', e.target.value)}
                disabled={mode === 'sale'} // مقفل في البيع لضمان الارتباط التلقائي برقم الدفعة والمخزن
                className={`w-full p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl text-center text-xs font-mono outline-none ${mode === 'sale' ? 'bg-slate-100 dark:bg-slate-900/50 text-slate-400 cursor-not-allowed' : 'bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-white focus:ring-2 focus:ring-teal-500'}`}
              />
            </div>
          </div>

          {/* صف السعر والمجموعة */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">
                {mode === 'purchase' ? 'سعر الشراء' : 'سعر البيع'}
              </label>
              <input 
                type="number"
                value={localItem.price === 0 ? '' : localItem.price}
                onChange={(e) => handleFieldChange('price', Number(e.target.value))}
                className="w-full p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-white text-xs font-mono font-bold focus:ring-2 focus:ring-teal-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">المجموعة الدوائية</label>
              <input 
                type="text"
                value={localItem.category}
                disabled
                className="w-full p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-100 dark:bg-slate-900/50 text-slate-400 text-xs cursor-not-allowed font-medium"
              />
            </div>
          </div>

          {/* حقل الملاحظات الإضافية السريع */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">ملاحظات الصنف</label>
            <input 
              type="text"
              value={localItem.notes}
              onChange={(e) => handleFieldChange('notes', e.target.value)}
              className="w-full p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-white text-xs outline-none focus:ring-2 focus:ring-teal-500"
              placeholder="أضف ملاحظة هنا..."
            />
          </div>

          {/* شريط احتساب الإجمالي التلقائي الموحد بالعملة المحلية */}
          <div className="bg-teal-50 dark:bg-emerald-950/20 border border-teal-100 dark:border-emerald-900/30 p-2.5 rounded-xl text-center flex items-center justify-center gap-2">
            <Calculator size={14} className="text-teal-600 dark:text-emerald-400" />
            <span className="text-xs font-bold text-teal-600 dark:text-emerald-400 font-mono">
              الإجمالي: { (localItem.qty * localItem.price).toLocaleString() } {currency}
            </span>
          </div>
        </div>

        {/* أزرار الإجراءات */}
        <div className="flex gap-3 w-full mt-5">
          <button 
            onClick={() => onSave(localItem)}
            className="flex-1 bg-teal-600 hover:bg-teal-700 text-white text-sm font-bold py-2.5 rounded-xl shadow-lg shadow-teal-600/10 active:scale-[0.98] transition-all"
          >
            تعديل الصنف
          </button>
          <button 
            onClick={onClose}
            className="flex-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-bold py-2.5 rounded-xl active:scale-[0.98] transition-all border border-slate-100 dark:border-gray-750"
          >
            إلغاء
          </button>
        </div>

      </div>
    </div>
  );
};
