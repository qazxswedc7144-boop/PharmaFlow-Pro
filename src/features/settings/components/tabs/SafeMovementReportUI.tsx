import React, { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, FileText, Search, Wallet } from 'lucide-react';

type Movement = {
  id: string;
  date: string;
  amount: number;
  direction: 'in' | 'out';
  note: string;
  balance: number;
};

// بيانات تجريبية للعرض فقط — لا تُقرأ من قاعدة البيانات ولا تُستخدم في أي قيد مالي.
const MOCK_MOVEMENTS: Movement[] = [
  { id: 'M-001', date: '2026-11-04', amount: 125000, direction: 'in', note: 'مبيعات نقدية - الفترة الصباحية', balance: 125000 },
  { id: 'M-002', date: '2026-11-04', amount: 18500, direction: 'out', note: 'مصروفات تشغيلية', balance: 106500 },
  { id: 'M-003', date: '2026-11-03', amount: 87500, direction: 'in', note: 'توريد نقدية من نقطة البيع', balance: 194000 },
  { id: 'M-004', date: '2026-11-03', amount: 42000, direction: 'out', note: 'سند صرف تجريبي', balance: 152000 },
  { id: 'M-005', date: '2026-11-02', amount: 64000, direction: 'in', note: 'مبيعات نقدية - الفترة المسائية', balance: 216000 },
];

interface SafeMovementReportUIProps {
  user?: { name?: string; username?: string } | null;
  onBack: () => void;
}

const formatAmount = (value: number) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value);

const SafeMovementReportUI: React.FC<SafeMovementReportUIProps> = ({ user, onBack }) => {
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const movements = useMemo(() => MOCK_MOVEMENTS.filter((item) => {
    const matchesSearch = !search || item.note.toLowerCase().includes(search.toLowerCase()) || item.id.toLowerCase().includes(search.toLowerCase());
    const matchesDirection = direction === 'all' || item.direction === direction;
    const matchesFrom = !fromDate || item.date >= fromDate;
    const matchesTo = !toDate || item.date <= toDate;
    return matchesSearch && matchesDirection && matchesFrom && matchesTo;
  }), [search, direction, fromDate, toDate]);

  const currentBalance = MOCK_MOVEMENTS[0]?.balance ?? 0;

  return (
    <section dir="rtl" className="space-y-4 pb-24 font-cairo text-right">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .safe-report-print, .safe-report-print * { visibility: visible !important; }
          .safe-report-print { position: absolute; inset: 0; width: 100%; padding: 16px; }
          .safe-report-no-print { display: none !important; }
        }
      `}</style>
      <header className="safe-report-no-print flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#1E4D4D] p-4 text-white shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={onBack} aria-label="رجوع" className="rounded-xl bg-white/10 p-2 transition hover:bg-white/20"><ArrowLeft className="h-5 w-5" /></button>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10"><Wallet className="h-5 w-5" /></div>
          <div className="min-w-0"><p className="text-xs text-emerald-100">تقرير تجريبي — بيانات وهمية</p><h2 className="truncate text-sm font-extrabold">حركة الصندوق · {user?.name || user?.username || 'المستخدم'}</h2></div>
        </div>
        <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-xl bg-white px-3.5 py-2.5 text-xs font-extrabold text-[#1E4D4D] transition hover:bg-emerald-50"><FileText className="h-4 w-4" /> تصدير PDF</button>
      </header>

      <div className="safe-report-no-print rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
        هذه شاشة معاينة فقط. الأرقام والحركات أدناه بيانات تجريبية وليست أرصدة فعلية أو سجلات محاسبية.
      </div>

      <div className="safe-report-no-print grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-4">
        <label className="relative md:col-span-2"><span className="mb-1.5 block text-xs font-bold text-slate-600">بحث في البيان أو المرجع</span><Search className="absolute right-3 top-9 h-4 w-4 text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="اكتب كلمة للبحث..." className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-3 pr-9 text-sm outline-none focus:border-[#1E4D4D] focus:bg-white" /></label>
        <label><span className="mb-1.5 block text-xs font-bold text-slate-600">نوع الحركة</span><select value={direction} onChange={(e) => setDirection(e.target.value as 'all' | 'in' | 'out')} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#1E4D4D]"><option value="all">كل الحركات</option><option value="in">مقبوضات</option><option value="out">مصروفات</option></select></label>
        <div className="grid grid-cols-2 gap-2"><label><span className="mb-1.5 block text-xs font-bold text-slate-600">من تاريخ</span><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2.5 text-xs outline-none focus:border-[#1E4D4D]" /></label><label><span className="mb-1.5 block text-xs font-bold text-slate-600">إلى تاريخ</span><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2.5 text-xs outline-none focus:border-[#1E4D4D]" /></label></div>
      </div>

      <div className="safe-report-print space-y-3">
        <div className="hidden items-center justify-between print:flex"><h1 className="text-lg font-bold">تقرير حركة الصندوق — بيانات تجريبية</h1><span className="text-sm">{user?.name || user?.username || ''}</span></div>
        <div className="hidden print:block text-xs text-slate-500">تقرير توضيحي غير مرتبط بقاعدة البيانات.</div>
        <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white md:block print:block">
          <table className="w-full border-collapse text-right">
            <thead className="bg-slate-50 text-xs font-bold text-slate-600"><tr><th className="p-3">التاريخ</th><th className="p-3">المبلغ</th><th className="p-3">الملاحظات / البيان</th><th className="p-3">الرصيد التراكمي</th></tr></thead>
            <tbody>{movements.map((item) => <tr key={item.id} className="border-t border-slate-100 text-xs"><td className="p-3 text-slate-600" dir="ltr">{item.date}</td><td className={`p-3 font-extrabold ${item.direction === 'in' ? 'text-emerald-700' : 'text-rose-600'}`} dir="ltr">{item.direction === 'in' ? '+' : '−'}{formatAmount(item.amount)}</td><td className="p-3 text-slate-700">{item.note}</td><td className="p-3 font-bold text-slate-800" dir="ltr">{formatAmount(item.balance)}</td></tr>)}</tbody>
          </table>
          {movements.length === 0 && <p className="p-8 text-center text-sm text-slate-400">لا توجد حركات مطابقة لخيارات التصفية</p>}
        </div>
        <div className="space-y-2 md:hidden print:hidden">{movements.map((item) => <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between gap-3"><span className="text-xs text-slate-500" dir="ltr">{item.date}</span><span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold ${item.direction === 'in' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{item.direction === 'in' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}{item.direction === 'in' ? 'داخل' : 'خارج'}</span></div><p className="mt-3 text-sm font-bold text-slate-800">{item.note}</p><div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3"><div><p className="text-[10px] text-slate-400">المبلغ</p><p className={`mt-1 text-sm font-extrabold ${item.direction === 'in' ? 'text-emerald-700' : 'text-rose-600'}`} dir="ltr">{item.direction === 'in' ? '+' : '−'}{formatAmount(item.amount)}</p></div><div className="text-left"><p className="text-[10px] text-slate-400">الرصيد التراكمي</p><p className="mt-1 text-sm font-bold text-slate-800" dir="ltr">{formatAmount(item.balance)}</p></div></div></article>)}</div>
        {movements.length === 0 && <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400 md:hidden">لا توجد حركات مطابقة لخيارات التصفية</div>}
      </div>

      <footer className="safe-report-no-print fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur sm:static sm:rounded-2xl sm:border sm:shadow-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3"><div><p className="text-xs text-slate-500">الرصيد الإجمالي الحالي (تجريبي)</p><p className="mt-1 text-lg font-extrabold text-[#1E4D4D]" dir="ltr">{formatAmount(currentBalance)}</p></div><span className="rounded-full bg-amber-50 px-3 py-1.5 text-[10px] font-bold text-amber-700">Mock Data</span></div>
      </footer>
    </section>
  );
};

export default SafeMovementReportUI;
