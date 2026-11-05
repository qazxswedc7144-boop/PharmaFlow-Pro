import React, { useEffect, useMemo, useState } from 'react';
import {
  Users, UserPlus, Edit3, Trash2, X,
  ArrowRight, Shield, KeyRound, Wallet, Plus, Building2, BriefcaseBusiness
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getCurrentUserSession } from '@/core/db';
import { authService } from '@features/auth/services/authService';
import { useUIStore } from '@/store/useUIStore';
import SafeMovementReportUI from './SafeMovementReportUI';

type PermissionSet = { read: boolean; add: boolean; edit: boolean; delete: boolean };
const MODULES = ['الحسابات', 'قبض/صرف', 'المشتريات', 'المبيعات', 'النسخ الاحتياطي', 'الصرف/التوريد المخزني'];
const EMPTY_PERMISSIONS = MODULES.reduce<Record<string, PermissionSet>>((all, name) => {
  all[name] = { read: false, add: false, edit: false, delete: false };
  return all;
}, {});

export const UsersTab: React.FC = () => {
  const [activeView, setActiveView] = useState<'users' | 'permissions' | 'cash-report'>('users');
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);

  const users = useLiveQuery(async () => {
    const session = getCurrentUserSession();
    if (!session.tenantId) return [];
    const all = await db.users.toArray();
    // Filter by tenantId and optionally branchId if users are branch-specific
    return all.filter(u => u.tenantId === session.tenantId);
  }, []) || [];
  const cashboxes = useLiveQuery(async () => {
    const session = getCurrentUserSession();
    if (!session.tenantId) return [];
    const all = await db.cashboxes.toArray();
    return all.filter(c => c.tenantId === session.tenantId);
  }, []) || [];
  const cashMovements = useLiveQuery(async () => {
    if (!selectedUser?.id) return [];
    const session = getCurrentUserSession();
    if (!session.tenantId) return [];

    // Filter by tenantId to prevent leakage if indexes exist, otherwise filter in memory
    const [byCashbox, byUser] = await Promise.all([
      selectedUser.cashboxId
        ? db.cashFlow.where('cashboxId').equals(selectedUser.cashboxId).filter((c: any) => c.tenantId === session.tenantId).toArray()
        : Promise.resolve([]),
      db.cashFlow.where('userId').equals(selectedUser.id).filter((c: any) => c.tenantId === session.tenantId).toArray()
    ]);
    return Array.from(new Map([...byCashbox, ...byUser].map((movement: any) => [movement.id, movement])).values());
  }, [selectedUser?.id, selectedUser?.cashboxId]) || [];
  const reportMovements = useMemo(() => {
    let runningBalance = 0;
    return [...cashMovements]
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((item: any) => {
        const direction = (item.type === 'دخل' ? 'in' : 'out') as 'in' | 'out';
        runningBalance += direction === 'in' ? Number(item.amount) || 0 : -(Number(item.amount) || 0);
        const parsedDate = new Date(item.date);
        return {
          id: String(item.transaction_id || item.id),
          date: Number.isNaN(parsedDate.getTime()) ? String(item.date || '').slice(0, 10) : parsedDate.toISOString().slice(0, 10),
          amount: Number(item.amount) || 0,
          direction,
          note: item.notes || item.name || item.category || '—',
          balance: runningBalance
        };
      });
  }, [cashMovements]);
  const reportBalance = reportMovements[reportMovements.length - 1]?.balance ?? 0;
  const defaultCashboxId = cashboxes.find((cashbox: any) => cashbox.name === 'الصندوق الرئيسي')?.id || cashboxes[0]?.id || 'cashbox-main';

  const getAuthorizedTenantSession = (targetUser?: any) => {
    const session = getCurrentUserSession();
    const currentUser = authService.getCurrentUser();
    const role = String(currentUser?.Role || '').trim().toLowerCase();
    const isAdmin = [
      'admin', 'superadmin', 'super_admin', 'administrator',
      'tenant_admin', 'tenant-admin', 'owner', 'مدير', 'مدير نظام', 'مدير النظام'
    ].includes(role);

    if (!currentUser?.id || !session.tenantId || !isAdmin) {
      useUIStore.getState().addToast('غير مصرح لك بإدارة المستخدمين أو لا توجد مؤسسة نشطة.', 'error');
      return null;
    }

    if (targetUser && (!targetUser.tenantId || targetUser.tenantId !== session.tenantId)) {
      useUIStore.getState().addToast('رفضت العملية: المستخدم لا يحمل سياق المؤسسة الحالية.', 'error');
      return null;
    }

    return session;
  };

  const [formData, setFormData] = useState({
    name: '', username: '', password: '', role: 'صيدلي مسؤول',
    branch: 'الفرع الرئيسي', status: 'active', cashboxId: 'cashbox-main'
  });
  const [modulesPermissions, setModulesPermissions] = useState<Record<string, PermissionSet>>(EMPTY_PERMISSIONS);

  useEffect(() => {
    if (selectedUser) {
      const session = getCurrentUserSession();
      // Security: Ensure selectedUser belongs to current tenant before fetching perms
      if (!session.tenantId || !selectedUser.tenantId || selectedUser.tenantId !== session.tenantId) {
        setSelectedUser(null);
        setActiveView('users');
        return;
      }

      db.userPermissions
        .where('userId').equals(selectedUser.id)
        .and(p => p.tenantId === session.tenantId)
        .first()
        .then((perms) => {
          setModulesPermissions({ ...EMPTY_PERMISSIONS, ...(perms?.permissions || {}) });
        });
    }
  }, [selectedUser]);

  const toggleAction = (moduleName: string, action: keyof PermissionSet) => {
    setModulesPermissions((prev) => {
      const current = prev[moduleName] || { read: false, add: false, edit: false, delete: false };
      return { ...prev, [moduleName]: { ...current, [action]: !current[action] } };
    });
  };

  const handleSelectUserPermissions = (user: any) => {
    if (!getAuthorizedTenantSession(user)) return;
    setSelectedUser(user);
    setActiveView('permissions');
  };

  const handleOpenAddModal = () => {
    setEditingUser(null);
    setFormData({ name: '', username: '', password: '', role: 'صيدلي مسؤول', branch: 'الفرع الرئيسي', status: 'active', cashboxId: defaultCashboxId });
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (user: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingUser(user);
    setFormData({ name: user.name || '', username: user.username || '', password: '', role: user.role || 'صيدلي مسؤول', branch: user.branch || 'الفرع الرئيسي', status: user.status || 'active', cashboxId: user.cashboxId || defaultCashboxId });
    setIsModalOpen(true);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const session = getAuthorizedTenantSession(editingUser || undefined);
    if (!session) return;

    try {
      if (editingUser) {
        // Passwords must be provisioned and hashed by the trusted server, never stored in Dexie.
        await db.users.update(editingUser.id, {
          name: formData.name, role: formData.role, branch: formData.branch,
          status: formData.status, cashboxId: formData.cashboxId || defaultCashboxId,
          tenantId: session.tenantId
        });
        useUIStore.getState().addToast('تم تحديث ملف المستخدم. لم يتم تغيير كلمة مرور الدخول.', 'success');
      } else {
        // This screen creates a local staff profile only. The existing organization
        // endpoint uses a placeholder password hash and is not safe for provisioning.
        const profileData = {
          name: formData.name,
          username: formData.username,
          role: formData.role,
          branch: formData.branch,
          status: formData.status
        };
        await db.users.add({
          ...profileData,
          tenantId: session.tenantId,
          cashboxId: formData.cashboxId || defaultCashboxId,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString()
        });
        useUIStore.getState().addToast('تم حفظ ملف الموظف محلياً. إنشاء حساب دخول وكلمة مروره يحتاج إلى خدمة خادم آمنة.', 'success');
      }
      setFormData((current) => ({ ...current, password: '' }));
      setIsModalOpen(false);
    } catch (err: any) {
      useUIStore.getState().addToast(`فشل حفظ المستخدم: ${err.message}`, 'error');
    }
  };

  const handleDeleteUser = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetUser = users.find((user: any) => user.id === id);
    if (!targetUser || !getAuthorizedTenantSession(targetUser)) return;
    if (window.confirm('هل أنت متأكد من حذف هذا المستخدم؟')) {
      try {
        await db.users.delete(id);
        useUIStore.getState().addToast('تم حذف المستخدم', 'success');
      } catch {
        useUIStore.getState().addToast('فشل حذف المستخدم', 'error');
      }
    }
  };

  const handleSavePermissions = async () => {
    if (!selectedUser) return;
    const session = getAuthorizedTenantSession(selectedUser);
    if (!session) return;

    try {
      const existing = await db.userPermissions
        .where('userId').equals(selectedUser.id)
        .and(p => p.tenantId === session.tenantId)
        .first();
      
      if (existing) {
        await db.userPermissions.update(existing.id, { permissions: modulesPermissions });
      } else {
        await db.userPermissions.add({ 
          id: Date.now().toString(), 
          userId: selectedUser.id, 
          permissions: modulesPermissions, 
          tenantId: session.tenantId 
        });
      }
      useUIStore.getState().addToast('تم حفظ الصلاحيات بنجاح', 'success');
    } catch (err: any) {
      useUIStore.getState().addToast(`فشل حفظ الصلاحيات: ${err.message}`, 'error');
    }
  };

  if (activeView === 'cash-report') {
    return (
      <SafeMovementReportUI
        user={selectedUser}
        movements={reportMovements}
        balance={reportBalance}
        onBack={() => setActiveView('users')}
      />
    );
  }

  return (
    <div className="relative min-h-[420px] space-y-4 dir-rtl pb-24 text-right font-cairo">
      {activeView === 'users' ? (
        <>
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#1E4D4D]/10 text-[#1E4D4D]">
                <Users className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-extrabold text-slate-800">المستخدمون والصلاحيات</h3>
                <p className="mt-1 text-xs text-slate-500">إدارة حسابات فريق العمل والتحكم في الوصول</p>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-[#1E4D4D]/10 px-3 py-1 text-xs font-bold text-[#1E4D4D]">{users.length} مستخدم</span>
          </div>

          {users.length === 0 ? (
            <div className="flex min-h-[340px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-white px-5 py-12 text-center">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-3xl bg-[#1E4D4D]/10 text-[#1E4D4D]">
                <Users className="h-9 w-9" />
              </div>
              <h3 className="text-base font-extrabold text-slate-800">لا يوجد مستخدمون حتى الآن</h3>
              <p className="mt-2 max-w-xs text-sm leading-6 text-slate-500">ابدأ بإضافة أول حساب لموظفي الصيدلية، ثم خصص صلاحيات الوصول المناسبة.</p>
              <button onClick={handleOpenAddModal} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#1E4D4D] px-5 py-3 text-sm font-bold text-white shadow-lg shadow-[#1E4D4D]/20 transition hover:bg-[#163d3d]">
                <Plus className="h-4 w-4" /> إضافة أول مستخدم
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {users.map((u: any) => (
                <article key={u.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-[#1E4D4D]/30 hover:shadow-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#1E4D4D]/10 text-lg font-extrabold text-[#1E4D4D]">{u.name?.charAt(0) || '؟'}</div>
                      <div className="min-w-0">
                        <h4 className="truncate text-sm font-extrabold text-slate-800">{u.name || 'بدون اسم'}</h4>
                        <p className="mt-1 truncate text-xs text-slate-500" dir="ltr">@{u.username || '—'}</p>
                      </div>
                    </div>
                    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${u.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${u.status === 'active' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                      {u.status === 'active' ? 'نشط' : 'معطل'}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="flex min-w-0 items-center gap-2 rounded-xl bg-slate-50 p-2.5">
                      <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0"><p className="text-[10px] text-slate-400">الفرع / المخزن</p><p className="truncate text-xs font-bold text-slate-700">{u.branch || 'غير محدد'}</p></div>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 rounded-xl bg-slate-50 p-2.5">
                      <Wallet className="h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0"><p className="text-[10px] text-slate-400">الصندوق المالي</p><p className="truncate text-xs font-bold text-slate-700">{cashboxes.find((cashbox: any) => cashbox.id === u.cashboxId)?.name || (u.cashboxId === 'cashbox-main' ? 'الصندوق الرئيسي' : 'غير محدد')}</p></div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500"><BriefcaseBusiness className="h-3.5 w-3.5" />{u.role || 'موظف'}</span>
                    <div className="flex items-center gap-1.5">
                      <button type="button" title="تعديل بيانات المستخدم" aria-label="تعديل بيانات المستخدم" onClick={(e) => handleOpenEditModal(u, e)} className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-[#1E4D4D]"><Edit3 className="h-4 w-4" /></button>
                      <button type="button" title="إدارة الصلاحيات" aria-label="إدارة الصلاحيات" onClick={() => handleSelectUserPermissions(u)} className="rounded-lg p-2 text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-700"><KeyRound className="h-4 w-4" /></button>
                      <button type="button" title="تقرير حركة الصندوق (عرض تجريبي)" aria-label="تقرير حركة الصندوق" onClick={() => { setSelectedUser(u); setActiveView('cash-report'); }} className="rounded-lg p-2 text-slate-500 transition hover:bg-amber-50 hover:text-amber-700"><Wallet className="h-4 w-4" /></button>
                      <button type="button" title="حذف المستخدم" aria-label="حذف المستخدم" onClick={(e) => handleDeleteUser(u.id, e)} className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
          <button type="button" onClick={handleOpenAddModal} aria-label="إضافة مستخدم" title="إضافة مستخدم" className="fixed bottom-6 left-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#1E4D4D] text-white shadow-xl shadow-[#1E4D4D]/30 transition hover:scale-105 hover:bg-[#163d3d] focus:outline-none focus:ring-4 focus:ring-emerald-200">
            <Plus className="h-7 w-7" />
          </button>
        </>
      ) : (
        <section className="space-y-4">
          <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#1E4D4D] p-4 text-white shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <Shield className="h-6 w-6 shrink-0 text-emerald-200" />
              <div className="min-w-0"><p className="text-xs text-emerald-100">مصفوفة الصلاحيات</p><h3 className="truncate text-sm font-extrabold">المستخدم: {selectedUser?.name || '—'}</h3></div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleSavePermissions} className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-400">حفظ الصلاحيات</button>
              <button onClick={() => setActiveView('users')} className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-2 text-xs font-bold text-white transition hover:bg-white/20"><ArrowRight className="h-4 w-4" /> رجوع</button>
            </div>
          </header>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {MODULES.map((moduleName) => {
              const perms = modulesPermissions[moduleName] || { read: false, add: false, edit: false, delete: false };
              return (
                <div key={moduleName} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h4 className="mb-3 border-b border-slate-100 pb-3 text-sm font-extrabold text-slate-800">{moduleName}</h4>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(['read', 'add', 'edit', 'delete'] as const).map((action) => (
                      <label key={action} className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border p-3 text-xs font-bold transition ${perms[action] ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'}`}>
                        <span>{{ read: 'قراءة', add: 'إضافة', edit: 'تعديل', delete: 'حذف' }[action]}</span>
                        <input type="checkbox" checked={!!perms[action]} onChange={() => toggleAction(moduleName, action)} className="h-4 w-4 cursor-pointer accent-emerald-600" />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="user-modal-title" className="my-auto w-full max-w-lg space-y-5 rounded-3xl border border-slate-100 bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1E4D4D]/10 text-[#1E4D4D]"><UserPlus className="h-5 w-5" /></div><div><h3 id="user-modal-title" className="text-base font-extrabold text-slate-800">{editingUser ? 'تعديل بيانات المستخدم' : 'إضافة مستخدم جديد'}</h3><p className="mt-1 text-xs text-slate-500">أدخل بيانات الحساب الأساسية</p></div></div>
              <button type="button" onClick={() => setIsModalOpen(false)} aria-label="إغلاق" className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
            </div>
            <form onSubmit={handleSaveUser} className="space-y-4">
              <div><label className="mb-1.5 block text-xs font-bold text-slate-700">الاسم الثلاثي</label><input type="text" required placeholder="الاسم الكامل" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[#1E4D4D] focus:bg-white focus:ring-4 focus:ring-[#1E4D4D]/10" /></div>
              <div><label className="mb-1.5 block text-xs font-bold text-slate-700">اسم المستخدم</label><input type="text" required disabled={!!editingUser} dir="ltr" placeholder="username" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value })} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-left text-sm outline-none transition focus:border-[#1E4D4D] focus:bg-white focus:ring-4 focus:ring-[#1E4D4D]/10 disabled:opacity-50" /></div>
              <div><label className="mb-1.5 block text-xs font-bold text-slate-700">كلمة المرور (لا تُحفظ محلياً)</label><input type="password" autoComplete="new-password" required={false} placeholder="تُدار عبر خدمة الحسابات الآمنة" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm outline-none transition focus:border-[#1E4D4D] focus:bg-white focus:ring-4 focus:ring-[#1E4D4D]/10" /><p className="mt-1 text-[11px] text-amber-700">لن تُحفظ كلمة المرور في قاعدة البيانات المحلية؛ إنشاء بيانات الدخول يحتاج إلى API آمن.</p></div>
              <div><label className="mb-1.5 block text-xs font-bold text-slate-700">الصندوق المالي</label><select value={formData.cashboxId || defaultCashboxId} onChange={(e) => setFormData({ ...formData, cashboxId: e.target.value })} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm outline-none focus:border-[#1E4D4D] focus:bg-white">{cashboxes.length === 0 ? <option value="cashbox-main">الصندوق الرئيسي</option> : cashboxes.filter((cashbox: any) => cashbox.isActive !== false).map((cashbox: any) => <option key={cashbox.id} value={cashbox.id}>{cashbox.name}</option>)}</select></div>
              <div><label className="mb-1.5 block text-xs font-bold text-slate-700">المسمى الوظيفي</label><select value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value })} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm outline-none focus:border-[#1E4D4D] focus:bg-white"><option value="صيدلي مسؤول">صيدلي مسؤول</option><option value="كاشير مبيعات">كاشير مبيعات</option><option value="مدير نظام">مدير نظام</option></select></div>
              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-3.5"><span><span className="block text-sm font-bold text-slate-700">حالة الحساب</span><span className="mt-1 block text-xs text-slate-500">{formData.status === 'active' ? 'الحساب نشط ويمكنه الدخول' : 'الحساب معطل'}</span></span><input type="checkbox" checked={formData.status === 'active'} onChange={(e) => setFormData({ ...formData, status: e.target.checked ? 'active' : 'inactive' })} className="h-5 w-5 accent-emerald-600" /></label>
              <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row"><button type="submit" className="flex-1 rounded-xl bg-[#1E4D4D] px-4 py-3 text-sm font-extrabold text-white transition hover:bg-[#163d3d]">حفظ البيانات</button><button type="button" onClick={() => setIsModalOpen(false)} className="rounded-xl bg-slate-100 px-5 py-3 text-sm font-bold text-slate-600 transition hover:bg-slate-200">إلغاء</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersTab;
