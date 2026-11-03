import React, { useState, useMemo, useEffect } from 'react';
import { db } from '@/core/db';
import { SupplierRepository } from '@/database/repositories/SupplierRepository';
import { voucherService } from '@features/accounting/services/voucherService';
import { useUI } from '@/contexts/AppContext';
import { Receipt, Payment, Supplier } from '@/types';
import PrintMenu from '@/components/shared/PrintMenu';
import { ArrowDownCircle, ArrowUpRight, Trash2, Calendar, CreditCard, Wallet, X, ChevronLeft, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface VouchersModuleProps {
  onNavigate?: (view: string) => void;
  initialType?: 'RECEIPT' | 'PAYMENT';
}

const getToday = () => new Date().toISOString().split('T')[0];

const formatVoucherDate = (value?: string) => {
  if (!value) return '';
  const raw = value.slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : raw.replace(/-/g, '/');
};

const VouchersModule: React.FC<VouchersModuleProps> = ({ onNavigate, initialType = 'RECEIPT' }) => {
  const { version, refreshGlobal, addToast, currency } = useUI();
  const [vType, setVType] = useState<'RECEIPT' | 'PAYMENT'>(initialType);
  const [searchTerm, setSearchTerm] = useState('');
  const [history, setHistory] = useState<(Receipt | Payment)[]>([]);
  const [customers, setCustomers] = useState<Supplier[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [partnerSearch, setPartnerSearch] = useState('');
  const [showPartnerDropdown, setShowPartnerDropdown] = useState(false);
  const [form, setForm] = useState({ partnerId: '', amount: '', notes: '', paymentMethod: 'CASH' as 'CASH' | 'TRANSFER', date: getToday() });
  const [dateInput, setDateInput] = useState(formatVoucherDate(getToday()));

  useEffect(() => {
    const handleClickOutside = () => setShowPartnerDropdown(false);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  const filteredPartners = useMemo(() => {
    const list = vType === 'RECEIPT' ? customers : suppliers;
    if (!partnerSearch.trim()) return [];
    return list.filter(p => (p.Supplier_Name || '').toLowerCase().includes(partnerSearch.toLowerCase()));
  }, [vType, customers, suppliers, partnerSearch]);

  const selectedPartner = useMemo(() => {
    const list = vType === 'RECEIPT' ? customers : suppliers;
    return list.find(p => p.id === form.partnerId);
  }, [vType, customers, suppliers, form.partnerId]);

  useEffect(() => {
    const fetchData = async () => {
      const custs = await db.customers.toArray();
      const supps = await db.suppliers.toArray();
      const rcpts = await db.receipts.toArray();
      const pymnts = await db.payments.toArray();
      setCustomers(custs);
      setSuppliers(supps);
      setHistory([
        ...rcpts.map(r => ({ ...r, type: 'RECEIPT' as const })),
        ...pymnts.map(p => ({ ...p, type: 'PAYMENT' as const }))
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    };
    fetchData();
  }, [version]);

  const resetForm = () => {
    const today = getToday();
    setForm({ partnerId: '', amount: '', notes: '', paymentMethod: 'CASH', date: today });
    setDateInput(formatVoucherDate(today));
    setPartnerSearch('');
    setShowPartnerDropdown(false);
  };

  const handleSave = async () => {
    let finalPartnerId = form.partnerId;
    if (!form.amount || parseFloat(form.amount) <= 0) {
      addToast('يرجى إدخال مبلغ أكبر من صفر', 'error');
      return;
    }
    if (!form.date) {
      addToast('يرجى إدخال التاريخ بصيغة YYYY/MM/DD', 'error');
      return;
    }
    if (!finalPartnerId) {
      if (!partnerSearch.trim()) {
        addToast('يرجى اختيار أو كتابة اسم المستلم/المسلم', 'error');
        return;
      }
      const exactMatch = (vType === 'RECEIPT' ? customers : suppliers).find(p => p.Supplier_Name === partnerSearch.trim());
      if (exactMatch) {
        finalPartnerId = exactMatch.id;
      } else {
        if (window.confirm(`الاسم \"${partnerSearch}\" غير موجود. هل تريد إضافته كـ ${vType === 'RECEIPT' ? 'عميل جديد' : 'مورد جديد'}؟`)) {
          try {
            const newPartner: Supplier = {
              id: `${vType === 'RECEIPT' ? 'C' : 'S'}-${Date.now()}`,
              Supplier_ID: `${vType === 'RECEIPT' ? 'C' : 'S'}-${Date.now()}`,
              Supplier_Name: partnerSearch.trim(), balance: 0, openingBalance: 0,
              Is_Active: true, updated_at: new Date().toISOString(), version: 1
            };
            finalPartnerId = await SupplierRepository.save(newPartner, vType === 'RECEIPT' ? 'C' : 'S');
            addToast('تم إضافة الاسم الجديد بنجاح', 'success');
          } catch {
            addToast('فشل إضافة الاسم الجديد', 'error');
            return;
          }
        } else return;
      }
    }
    setLoading(true);
    try {
      if (vType === 'RECEIPT') {
        await voucherService.createReceipt({ customer_id: finalPartnerId, amount: parseFloat(form.amount), notes: form.notes, date: new Date(form.date).toISOString(), paymentMethod: form.paymentMethod });
      } else {
        await voucherService.createPayment({ supplier_id: finalPartnerId, amount: parseFloat(form.amount), notes: form.notes, date: new Date(form.date).toISOString(), paymentMethod: form.paymentMethod });
      }
      addToast('تم حفظ السند وتحديث الأرصدة بنجاح', 'success');
      resetForm();
      refreshGlobal();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addToast(errMsg || 'فشل الحفظ', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (item: (Receipt & { type?: string }) | (Payment & { type?: string })) => {
    if (!window.confirm('هل أنت متأكد من حذف هذا السند؟')) return;
    try {
      const isReceipt = 'customer_id' in item;
      const partnerId = isReceipt ? item.customer_id : item.supplier_id;
      await voucherService.cancelVoucher({ id: item.id, type: isReceipt ? 'RECEIPT' : 'PAYMENT', partnerId, amount: item.amount, reason: 'حذف من قبل المستخدم عبر واجهة السندات' });
      addToast('تم الحذف بنجاح ✅', 'success');
      refreshGlobal();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      addToast(`فشل الحذف: ${errMsg}`, 'error');
    }
  };

  const filteredHistory = useMemo(() => {
    if (!searchTerm.trim()) return history;
    const term = searchTerm.toLowerCase();
    return history.filter(h => {
      const partnerName = 'customer_id' in h
        ? customers.find(c => c.id === (h as Receipt).customer_id)?.Supplier_Name
        : suppliers.find(s => s.id === (h as Payment).supplier_id)?.Supplier_Name;
      return partnerName?.toLowerCase().includes(term) || h.notes?.toLowerCase().includes(term) || h.amount.toString().includes(term);
    });
  }, [history, searchTerm, customers, suppliers]);

  return (
    <div className="p-2 sm:p-4 space-y-1 pb-24 font-cairo bg-[#F8FAFA] min-h-full w-full" dir="rtl">
      <header className="bg-[#1E4D4D] text-white p-3 sm:p-5 md:p-6 rounded-2xl sm:rounded-3xl border border-[#1E4D4D] shadow-sm relative z-20 w-full overflow-hidden">
        <div className="flex items-center justify-between gap-2 sm:gap-3 w-full">
          {onNavigate && (
            <button 
              onClick={() => onNavigate('dashboard')} 
              className="w-7 h-7 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center text-[#1E4D4D] hover:bg-slate-100 transition-all shrink-0"
              title="الرجوع للرئيسية"
            >
              <ArrowRight size={16} />
            </button>
          )}
          <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 text-center px-1">
            <div className="w-10 h-10 sm:w-11 sm:h-11 bg-white/10 text-white border border-white/10 rounded-xl flex items-center justify-center shadow-md shadow-black/10 font-black shrink-0"><CreditCard size={20} /></div>
            <div className="w-full min-w-0 flex flex-col items-center text-center">
              <h2 className="w-full text-lg sm:text-xl font-black text-white tracking-tight leading-snug text-center whitespace-normal break-words">سندات القبض والصرف</h2>
              <p className="w-full text-[9px] sm:text-[10px] font-bold text-white/65 uppercase tracking-wider text-center leading-tight">Voucher Management System</p>
            </div>
          </div>
          <div className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 invisible" aria-hidden="true" />
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-1">
        <div className="lg:col-span-1 bg-white rounded-[40px] px-5 sm:px-6 md:px-8 py-5 shadow-sm border border-slate-100 space-y-6 h-fit lg:sticky lg:top-8">
          <div className="flex p-1.5 bg-[#F8FAFA] rounded-3xl border border-slate-100">
            <button onClick={() => { setVType('RECEIPT'); setForm(f => ({...f, partnerId: ''})); setPartnerSearch(''); }} className={`flex-1 py-4 rounded-2xl font-black text-sm transition-all flex items-center justify-center gap-2 ${vType === 'RECEIPT' ? 'bg-emerald-600 text-white shadow-xl' : 'text-slate-400 hover:text-emerald-600'}`}><ArrowDownCircle size={18} />سند قبض</button>
            <button onClick={() => { setVType('PAYMENT'); setForm(f => ({...f, partnerId: ''})); setPartnerSearch(''); }} className={`flex-1 py-4 rounded-2xl font-black text-sm transition-all flex items-center justify-center gap-2 ${vType === 'PAYMENT' ? 'bg-red-500 text-white shadow-xl' : 'text-slate-400 hover:text-red-500'}`}><ArrowUpRight size={18} />سند صرف</button>
          </div>

          <div className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-1">{vType === 'RECEIPT' ? 'يستلم من (العميل)' : 'يصرف لـ (المورد)'}</label>
              <div className="relative" onClick={e => e.stopPropagation()}>
                <input type="text" className="w-full bg-[#F8FAFA] border-2 border-slate-50 rounded-2xl px-5 py-4 font-black text-[#1E4D4D] focus:outline-none focus:border-[#1E4D4D] transition-all" placeholder="ابدأ الكتابة للبحث أو إضافة اسم جديد..." value={partnerSearch} onChange={e => { setPartnerSearch(e.target.value); setForm({...form, partnerId: ''}); setShowPartnerDropdown(true); }} onFocus={e => { e.stopPropagation(); setShowPartnerDropdown(true); }} />
                <AnimatePresence>
                  {showPartnerDropdown && filteredPartners.length > 0 && <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-100 rounded-2xl shadow-2xl z-[110] max-h-60 overflow-y-auto custom-scrollbar" onClick={e => e.stopPropagation()}>
                    {filteredPartners.map(p => <button key={p.id} onClick={e => { e.stopPropagation(); setForm({...form, partnerId: p.id}); setPartnerSearch(p.Supplier_Name || ''); setShowPartnerDropdown(false); }} className="w-full text-right px-5 py-3 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 flex items-center justify-between group"><span className="font-black text-[#1E4D4D]">{p.Supplier_Name}</span><span className="text-[9px] font-bold text-slate-300 group-hover:text-[#1E4D4D]">اختيار</span></button>)}
                  </motion.div>}
                </AnimatePresence>
              </div>
              {selectedPartner && <div className="mt-2 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 flex items-center justify-between gap-3"><span className="text-[10px] font-black text-slate-400">الرصيد الحالي</span><span className={`text-sm font-black ${Number(selectedPartner.balance || 0) < 0 ? 'text-red-600' : 'text-[#1E4D4D]'}`}>{Number(selectedPartner.balance || 0).toLocaleString()} <span className="text-[10px] opacity-60">{currency}</span></span></div>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-1">المبلغ</label><div className="relative"><input type="number" className="w-full bg-[#F8FAFA] border-2 border-slate-50 rounded-2xl px-5 py-4 font-black text-[#1E4D4D] text-center text-xl" placeholder="0.00" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} /><div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-20 font-black text-[11px]">{currency}</div></div></div>
              <div className="space-y-1.5"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-1">التاريخ</label><input type="text" inputMode="numeric" maxLength={10} dir="ltr" placeholder="YYYY/MM/DD" aria-label="التاريخ YYYY/MM/DD" className="w-full bg-[#F8FAFA] border-2 border-slate-50 rounded-2xl px-3 py-4 font-black text-slate-600 text-[11px] text-center" value={dateInput} onChange={e => { const value = e.target.value.replace(/[^\d/]/g, '').slice(0, 10); setDateInput(value); const digits = value.replace(/\D/g, '').slice(0, 8); if (digits.length === 8) { const year = digits.slice(0, 4); const month = digits.slice(4, 6); const day = digits.slice(6, 8); setForm({...form, date: `${year}-${month}-${day}`}); } else { setForm({...form, date: ''}); } }} /></div>
            </div>

            <div className="space-y-1.5"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-1">طريقة الدفع</label><div className="grid grid-cols-2 gap-3"><button onClick={() => setForm({...form, paymentMethod: 'CASH'})} className={`py-3 rounded-xl font-bold text-[11px] border-2 transition-all flex items-center justify-center gap-2 ${form.paymentMethod === 'CASH' ? 'border-[#1E4D4D] bg-[#1E4D4D]/5 text-[#1E4D4D]' : 'border-slate-50 text-slate-400'}`}><Wallet size={14} />نقداً</button><button onClick={() => setForm({...form, paymentMethod: 'TRANSFER'})} className={`py-3 rounded-xl font-bold text-[11px] border-2 transition-all flex items-center justify-center gap-2 ${form.paymentMethod === 'TRANSFER' ? 'border-[#1E4D4D] bg-[#1E4D4D]/5 text-[#1E4D4D]' : 'border-slate-50 text-slate-400'}`}><ArrowUpRight size={14} />تحويل بنكي</button></div></div>

            <div className="space-y-1.5"><label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mr-1">البيان / السبب</label><textarea className="w-full bg-[#F8FAFA] border-2 border-slate-50 rounded-2xl px-5 py-4 font-bold text-slate-700 h-28 focus:outline-none focus:border-[#1E4D4D] transition-all text-[11px]" placeholder="اكتب تفاصيل العملية هنا..." value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          </div>

          <div className="flex flex-row gap-3 items-stretch">
            <button type="button" disabled={loading} onClick={resetForm} className="flex-1 h-11 rounded-xl font-black text-sm text-slate-500 bg-slate-100 hover:bg-slate-200 transition-all active:scale-95 shadow-md flex items-center justify-center gap-2 disabled:opacity-50"><X size={18} />مسح</button>
            <button disabled={loading} onClick={handleSave} className={`flex-[2] h-11 rounded-xl font-black text-sm text-white shadow-md transition-all active:scale-95 flex items-center justify-center gap-3 ${vType === 'RECEIPT' ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-100' : 'bg-red-500 hover:bg-red-600 shadow-red-100'} ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}>{loading ? 'جاري الحفظ...' : 'حفظ السند وإصدار القيد ✨'}</button>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-[40px] p-8 shadow-sm border border-slate-100 overflow-hidden flex flex-col h-full min-h-[600px]">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col md:flex-row items-center justify-between gap-3">
              <div><h3 className="text-xl font-black text-[#1E4D4D]">أرشيف السندات</h3><p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">مراجعة العمليات المالية السابقة</p></div>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <button type="button" className="shrink-0 px-4 py-2 rounded-xl bg-[#1E4D4D] text-white text-[11px] font-black shadow-sm transition-all active:scale-95">الكل</button>
              <button type="button" className="shrink-0 px-4 py-2 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-100 text-[11px] font-black shadow-sm transition-all active:scale-95">قبض</button>
              <button type="button" className="shrink-0 px-4 py-2 rounded-xl bg-red-50 text-red-700 border border-red-100 text-[11px] font-black shadow-sm transition-all active:scale-95">صرف</button>
              <button type="button" className="shrink-0 px-4 py-2 rounded-xl bg-slate-50 text-slate-600 border border-slate-100 text-[11px] font-black shadow-sm transition-all active:scale-95">اليوم</button>
            </div>
            <div className="relative w-full group">
              <input type="text" placeholder="ابحث بالاسم، المبلغ، أو البيان..." className="w-full h-14 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm font-black focus:outline-none focus:border-[#1E4D4D] focus:bg-white shadow-inner transition-all group-hover:border-slate-200" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
          </div>
          <div className="space-y-3 overflow-y-auto custom-scrollbar pr-2 flex-1 pb-4">
            {filteredHistory.map(h => {
              const isReceipt = 'customer_id' in h;
              const partner = isReceipt ? customers.find(c => c.id === (h as Receipt).customer_id) : suppliers.find(s => s.id === (h as Payment).supplier_id);
              return (
                <div key={h.id} className="flex items-center gap-3 p-4 bg-white border border-slate-100 rounded-2xl shadow-sm hover:shadow-md hover:border-slate-200 transition-all group">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${isReceipt ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                    {isReceipt ? <ArrowDownCircle size={22} /> : <ArrowUpRight size={22} />}
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <h4 className="font-black text-[#1E4D4D] truncate">{partner?.Supplier_Name || 'جهة غير معروفة'}</h4>
                    <div className="flex items-center gap-2 mt-1">
                      <Calendar size={11} className="text-slate-300 shrink-0" />
                      <span dir="ltr" className="text-[10px] font-bold text-slate-400">{formatVoucherDate(h.date)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <p dir="ltr" className={`text-base font-black ${isReceipt ? 'text-emerald-600' : 'text-red-500'}`}>{isReceipt ? '+' : '-'}{h.amount.toLocaleString()} <span className="text-[9px] font-bold opacity-50">{currency}</span></p>
                    <ChevronLeft size={18} className="text-slate-300 group-hover:text-[#1E4D4D] transition-colors" />
                  </div>
                </div>
              );
            })}
            {filteredHistory.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                <div className="text-5xl opacity-20">📂</div>
                <p className="text-slate-400 font-black italic">الأرشيف فارغ حالياً</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VouchersModule;
