import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { db, getCurrentUserSession } from '@/core/db';
import { Account, Cashbox } from '@/types';
import { AccountingRepository } from '@/database/repositories/AccountingRepository';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';
import { cashboxTransferWorkflow } from '../workflows/CashboxTransferWorkflow';
import { generateTransactionUuid } from '@/utils/uuid';
import { BackButton } from '@/components/shared/BackButton';
import { Wallet, Plus, ArrowLeftRight, X, RefreshCw } from 'lucide-react';

interface CashboxesModuleProps {
  onNavigate?: (view: string) => void;
}

type BranchOption = { id: string; name: string };

const today = () => new Date().toISOString().slice(0, 10);
const money = (value: number) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CashboxesModule: React.FC<CashboxesModuleProps> = ({ onNavigate }) => {
  const [cashboxes, setCashboxes] = useState<Cashbox[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'create' | 'transfer' | null>(null);
  const session = getCurrentUserSession();

  const [createForm, setCreateForm] = useState({
    name: '', accountId: '', branchId: session.branchId || '',
    openingBalance: '0', openingAccountId: ''
  });
  const [transferForm, setTransferForm] = useState({
    sourceCashboxId: '', destinationCashboxId: '', amount: '', date: today(), notes: ''
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { tenantId } = session;
      const [allBoxes, allAccounts, allBranches] = await Promise.all([
        db.cashboxes.toArray(),
        db.accounts.toArray(),
        db.branches.toArray()
      ]);
      setCashboxes(allBoxes.filter((b: any) => b.tenantId === tenantId));
      setAccounts(allAccounts.filter((a: any) => a.tenantId === tenantId));
      setBranches(allBranches.filter((b: any) => b.tenantId === tenantId).map((b: any) => ({ id: b.id, name: b.name || b.branchName || b.code || b.id })));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل بيانات الصناديق.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const activeAssetAccounts = useMemo(
    () => accounts.filter(a => a.type === 'ASSET' && a.isActive !== false),
    [accounts]
  );
  const equityAccounts = useMemo(
    () => accounts.filter(a => a.type === 'EQUITY' && a.isActive !== false),
    [accounts]
  );
  const accountById = useMemo(() => new Map<string, Account>(accounts.map(a => [a.id, a] as const)), [accounts]);

  const openCreate = () => {
    setError('');
    setCreateForm({
      name: '', accountId: activeAssetAccounts[0]?.id || '',
      branchId: session.branchId || branches[0]?.id || '',
      openingBalance: '0', openingAccountId: equityAccounts[0]?.id || ''
    });
    setModal('create');
  };

  const openTransfer = () => {
    const active = cashboxes.filter(c => c.isActive !== false && !!c.accountId);
    setError('');
    setTransferForm({
      sourceCashboxId: active[0]?.id || '',
      destinationCashboxId: active.find(c => c.id !== active[0]?.id)?.id || '',
      amount: '', date: today(), notes: ''
    });
    setModal('transfer');
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    const amount = Number(createForm.openingBalance);
    const tenantId = session.tenantId;
    const branchId = createForm.branchId;
    const id = db.generateId('CASHBOX');
    const transactionUuid = generateTransactionUuid('JE');
    try {
      if (!createForm.name.trim()) throw new Error('اسم الصندوق مطلوب.');
      if (!tenantId || !branchId) throw new Error('تعذر تحديد المؤسسة والفرع من الجلسة الحالية.');
      if (session.branchId && session.branchId !== branchId) throw new Error('لا يمكن إنشاء صندوق خارج الفرع المحدد في جلسة المستخدم.');
      if (!createForm.accountId) throw new Error('اختر الحساب المحاسبي المرتبط بالصندوق.');
      if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
        throw new Error('الرصيد الافتتاحي يجب أن يكون صفراً أو مبلغاً موجباً بمنزلتين عشريتين.');
      }
      const cashAccount = await db.accounts.get(createForm.accountId);
      if (!cashAccount || cashAccount.type !== 'ASSET' || cashAccount.isActive === false) {
        throw new Error('الحساب المرتبط يجب أن يكون حساب أصول نشطاً.');
      }
      if (amount > 0) await PeriodLockEngine.validateOperation(today(), 'الرصيد الافتتاحي للصندوق');
      if (amount > 0 && !createForm.openingAccountId) {
        throw new Error('اختر حساب الأرصدة الافتتاحية (حقوق الملكية) لإثبات الطرف المقابل.');
      }
      const openingAccount = amount > 0 ? await db.accounts.get(createForm.openingAccountId) : undefined;
      if (amount > 0 && (!openingAccount || openingAccount.type !== 'EQUITY' || openingAccount.isActive === false || openingAccount.id === cashAccount.id)) {
        throw new Error('حساب الطرف المقابل يجب أن يكون حساب حقوق ملكية نشطاً ومختلفاً عن حساب الصندوق.');
      }

      await db.safeTransaction('rw', ['cashboxes', 'accounts', 'journalEntries', 'journalLines'], async (tx) => {
        const boxesTable = tx.table('cashboxes');
        const accountsTable = tx.table('accounts');
        const currentCashAccount = await accountsTable.get(cashAccount.id);
        const currentOpeningAccount = amount > 0 ? await accountsTable.get(createForm.openingAccountId) : undefined;
        if (!currentCashAccount || currentCashAccount.type !== 'ASSET' || currentCashAccount.isActive === false ||
            (currentCashAccount.tenantId && currentCashAccount.tenantId !== tenantId) ||
            (currentCashAccount.branchId && currentCashAccount.branchId !== branchId)) {
          throw new Error('الحساب النقدي لم يعد صالحاً أو لا يتبع المؤسسة والفرع المحددين.');
        }
        if (amount > 0 && (!currentOpeningAccount || currentOpeningAccount.type !== 'EQUITY' ||
            currentOpeningAccount.isActive === false ||
            (currentOpeningAccount.tenantId && currentOpeningAccount.tenantId !== tenantId) ||
            (currentOpeningAccount.branchId && currentOpeningAccount.branchId !== branchId))) {
          throw new Error('حساب الأرصدة الافتتاحية لم يعد صالحاً أو لا يتبع المؤسسة والفرع المحددين.');
        }
        if (await boxesTable.where('accountId').equals(currentCashAccount.id).and((b: any) => b.tenantId === tenantId).first()) {
          throw new Error('هذا الحساب مرتبط بصندوق آخر بالفعل في هذه المؤسسة. اختر حساباً غير مستخدم.');
        }
        const now = new Date().toISOString();
        const box: Cashbox = {
          id, name: createForm.name.trim(), accountId: currentCashAccount.id, branchId,
          isActive: true, openingBalance: amount, createdAt: now, tenantId
        };
        if (amount > 0 && currentOpeningAccount) {
          const lines = [
            {
              id: `${transactionUuid}-L1`, lineId: `${transactionUuid}-L1`, entryId: transactionUuid,
              accountId: currentCashAccount.id, accountCode: currentCashAccount.code, accountName: currentCashAccount.name,
              debit: amount, credit: 0, type: 'DEBIT' as const, amount,
              description: `الرصيد الافتتاحي للصندوق: ${box.name}`
            },
            {
              id: `${transactionUuid}-L2`, lineId: `${transactionUuid}-L2`, entryId: transactionUuid,
              accountId: currentOpeningAccount.id, accountCode: currentOpeningAccount.code, accountName: currentOpeningAccount.name,
              debit: 0, credit: amount, type: 'CREDIT' as const, amount,
              description: `مقابل الرصيد الافتتاحي للصندوق: ${box.name}`
            }
          ];
          const entry: any = {
            id: transactionUuid, date: today(),
            description: `إثبات الرصيد الافتتاحي للصندوق: ${box.name}`,
            referenceId: transactionUuid, sourceId: transactionUuid,
            sourceType: 'CASHBOX_OPENING_BALANCE', status: 'Posted',
            tenantId, branchId, createdAt: now, lines,
            transactionUuid, cashboxId: id, openingBalance: amount
          };
          await AccountingRepository.addEntry(entry, tx);
          box.openingBalanceJournalId = transactionUuid;
        }
        await boxesTable.add(box);
      });
      setModal(null);
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'فشل إنشاء الصندوق.');
    } finally {
      setSaving(false);
    }
  };

  const handleTransfer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      if (!session.tenantId || !transferForm.sourceCashboxId || !transferForm.destinationCashboxId) {
        throw new Error('بيانات المؤسسة والصندوقين مطلوبة.');
      }
      await cashboxTransferWorkflow.execute({
        ...transferForm,
        amount: Number(transferForm.amount),
        tenantId: session.tenantId,
        branchId: session.branchId || cashboxes.find(c => c.id === transferForm.sourceCashboxId)?.branchId || '',
        transactionUuid: generateTransactionUuid('TRX')
      });
      setModal(null);
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'فشل تنفيذ التحويل.');
    } finally {
      setSaving(false);
    }
  };

  const activeCashboxes = cashboxes.filter(c => c.isActive !== false);
  const branchName = (id: string) => branches.find(b => b.id === id)?.name || id || '—';

  return (
    <div className="w-full space-y-5 py-3 font-cairo" dir="rtl">
      <header className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {onNavigate && <BackButton onClick={() => onNavigate('dashboard')} />}
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#1E4D4D] text-white"><Wallet size={23} /></div>
          <div><h1 className="text-xl font-black text-[#1E4D4D]">إدارة الصناديق</h1><p className="mt-1 text-xs font-semibold text-slate-500">الأرصدة مستمدة من الحسابات المحاسبية المرتبطة</p></div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button onClick={openTransfer} disabled={activeCashboxes.length < 2} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1E4D4D]/20 px-4 py-3 text-xs font-extrabold text-[#1E4D4D] disabled:cursor-not-allowed disabled:opacity-40"><ArrowLeftRight size={16} /> تحويل بين الصناديق</button>
          <button onClick={openCreate} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1E4D4D] px-4 py-3 text-xs font-extrabold text-white shadow-sm hover:bg-[#163d3d]"><Plus size={16} /> إضافة صندوق جديد</button>
          <button onClick={() => void loadData()} className="rounded-xl border border-slate-200 p-3 text-slate-500" title="تحديث"><RefreshCw size={16} /></button>
        </div>
      </header>

      {error && !modal && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</div>}
      {loading ? <div className="rounded-2xl bg-white p-10 text-center text-sm font-bold text-slate-500">جاري تحميل الصناديق...</div> :
        cashboxes.length === 0 ? <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-10 text-center"><Wallet className="mx-auto mb-3 text-[#1E4D4D]" size={32} /><p className="font-extrabold text-[#1E4D4D]">لا توجد صناديق مسجلة</p><p className="mt-1 text-xs text-slate-500">أضف أول صندوق واربطه بحساب أصول نقدي.</p></div> :
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cashboxes.map(box => {
            const account = accountById.get(box.accountId);
            return <article key={box.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1E4D4D]/10 text-[#1E4D4D]"><Wallet size={19} /></span><div className="min-w-0"><h3 className="truncate text-sm font-black text-slate-800">{box.name}</h3><p className="mt-1 truncate text-[11px] text-slate-500">{branchName(box.branchId)}</p></div></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${box.isActive === false ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>{box.isActive === false ? 'معطل' : 'نشط'}</span></div>
              <div className="mt-4 rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold text-slate-500">الحساب المرتبط</p><p className="mt-1 text-xs font-extrabold text-[#1E4D4D]">{account ? `${account.code} — ${account.name}` : 'حساب غير موجود'}</p><p className="mt-3 text-[10px] font-bold text-slate-500">الرصيد الحالي (من الحساب)</p><p className="mt-1 text-xl font-black tabular-nums text-[#1E4D4D]">{money(account?.balance || 0)}</p></div>
            </article>;
          })}
        </div>
      }

      {modal && <div className="fixed inset-0 z-[600] flex items-center justify-center overflow-y-auto bg-slate-950/60 p-3 backdrop-blur-sm">
        <section role="dialog" aria-modal="true" className="my-auto max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
          <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3"><h2 className="text-base font-black text-[#1E4D4D]">{modal === 'create' ? 'إضافة صندوق جديد' : 'تحويل بين الصناديق'}</h2><button onClick={() => { setModal(null); setError(''); }} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="إغلاق"><X size={18} /></button></div>
          {error && <div role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-700">{error}</div>}
          {modal === 'create' ? <form onSubmit={handleCreate} className="space-y-3">
            <Field label="اسم الصندوق"><input required value={createForm.name} onChange={e => setCreateForm(v => ({ ...v, name: e.target.value }))} className={inputClass} placeholder="مثلاً: صندوق الكاشير" /></Field>
            <Field label="الحساب المحاسبي المرتبط"><select required value={createForm.accountId} onChange={e => setCreateForm(v => ({ ...v, accountId: e.target.value }))} className={inputClass}><option value="">اختر حساب أصول</option>{activeAssetAccounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
            <Field label="الفرع"><select required value={createForm.branchId} onChange={e => setCreateForm(v => ({ ...v, branchId: e.target.value }))} className={inputClass}><option value="">اختر الفرع</option>{branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}{createForm.branchId && !branches.some(b => b.id === createForm.branchId) && <option value={createForm.branchId}>{createForm.branchId}</option>}</select></Field>
            <Field label="الرصيد الافتتاحي"><input type="number" min="0" step="0.01" value={createForm.openingBalance} onChange={e => setCreateForm(v => ({ ...v, openingBalance: e.target.value }))} className={inputClass} /></Field>
            {Number(createForm.openingBalance) > 0 && <Field label="الحساب المقابل (حقوق الملكية / الأرصدة الافتتاحية)"><select required value={createForm.openingAccountId} onChange={e => setCreateForm(v => ({ ...v, openingAccountId: e.target.value }))} className={inputClass}><option value="">اختر حساب حقوق ملكية</option>{equityAccounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select><p className="mt-1 text-[10px] text-amber-700">يُرحّل الرصيد بقيد يومية متوازن، ولا يُخزّن كرصيد مستقل.</p></Field>}
            <FormActions saving={saving} onCancel={() => setModal(null)} />
          </form> : <form onSubmit={handleTransfer} className="space-y-3">
            <Field label="من صندوق"><select required value={transferForm.sourceCashboxId} onChange={e => setTransferForm(v => ({ ...v, sourceCashboxId: e.target.value }))} className={inputClass}><option value="">اختر صندوق المصدر</option>{activeCashboxes.filter(c => !!c.accountId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="إلى صندوق"><select required value={transferForm.destinationCashboxId} onChange={e => setTransferForm(v => ({ ...v, destinationCashboxId: e.target.value }))} className={inputClass}><option value="">اختر صندوق الوجهة</option>{activeCashboxes.filter(c => c.id !== transferForm.sourceCashboxId && !!c.accountId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="المبلغ"><input required type="number" min="0.01" step="0.01" value={transferForm.amount} onChange={e => setTransferForm(v => ({ ...v, amount: e.target.value }))} className={inputClass} /></Field>
            <Field label="التاريخ"><input required type="date" value={transferForm.date} onChange={e => setTransferForm(v => ({ ...v, date: e.target.value }))} className={inputClass} /></Field>
            <Field label="ملاحظات"><textarea rows={3} value={transferForm.notes} onChange={e => setTransferForm(v => ({ ...v, notes: e.target.value }))} className={inputClass} /></Field>
            <FormActions saving={saving} onCancel={() => setModal(null)} />
          </form>}
        </section>
      </div>}
    </div>
  );
};

const inputClass = 'w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm outline-none transition focus:border-[#1E4D4D] focus:ring-2 focus:ring-[#1E4D4D]/10';
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => <label className="block space-y-1"><span className="block text-xs font-bold text-slate-700">{label}</span>{children}</label>;
const FormActions: React.FC<{ saving: boolean; onCancel: () => void }> = ({ saving, onCancel }) => <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row"><button type="submit" disabled={saving} className="flex-1 rounded-xl bg-[#1E4D4D] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{saving ? 'جاري الحفظ...' : 'حفظ'}</button><button type="button" onClick={onCancel} disabled={saving} className="rounded-xl bg-slate-100 px-5 py-3 text-sm font-bold text-slate-600">إلغاء</button></div>;

export default CashboxesModule;
