import React, { useState, useEffect } from 'react';
import { Users, UserPlus, ShieldCheck, CheckCircle2, Edit3, Trash2, X, ArrowRight, Shield } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/core/db'; // 👈 تأكد من مسار قاعدة البيانات
import { authService } from '@features/auth/services/authService'; // 👈 للتحقق من الصلاحيات
import { useUIStore } from '@/store/useUIStore'; // 👈 للإشعارات

export const UsersTab: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'users' | 'permissions'>('users');
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);

  // 👈 1. جلب المستخدمين الحقيقيين من قاعدة البيانات (Reactive)
  const users = useLiveQuery(() => db.users.toArray(), []) || [];

  // 👈 2. نموذج الموظف
  const [formData, setFormData] = useState({
    name: '',
    username: '',
    password: '',
    role: 'صيدلي مسؤول',
    branch: 'الفرع الرئيسي',
    status: 'active'
  });

  // 👈 3. مصفوفة الصلاحيات (يتم جلبها من قاعدة البيانات للمستخدم المحدد)
  const [modulesPermissions, setModulesPermissions] = useState<Record<string, { read: boolean; add: boolean; edit: boolean; delete: boolean }>>({});

  useEffect(() => {
    if (selectedUser) {
      // جلب الصلاحيات من جدول منفصل أو من كائن المستخدم (سنفترض هنا وجود جدول user_permissions)
      db.userPermissions.where('userId').equals(selectedUser.id).first().then((perms) => {
        if (perms) setModulesPermissions(perms.permissions);
      });
    }
  }, [selectedUser]);

  const toggleAction = (moduleName: string, action: "read" | "add" | "edit" | "delete") => {
    setModulesPermissions((prev) => {
      const current = prev[moduleName] || { read: false, add: false, edit: false, delete: false };
      return {
        ...prev,
        [moduleName]: { ...current, [action]: !current[action] }
      };
    });
  };

  const handleSelectUserPermissions = (user: any) => {
    setSelectedUser(user);
    setActiveSubTab('permissions');
  };

  const handleOpenAddModal = () => {
    setEditingUser(null);
    setFormData({ name: '', username: '', password: '', role: 'صيدلي مسؤول', branch: 'الفرع الرئيسي', status: 'active' });
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (user: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingUser(user);
    setFormData({ name: user.name, username: user.username, password: '', role: user.role, branch: user.branch, status: user.status });
    setIsModalOpen(true);
  };

  // 👈 4. حفظ المستخدم (إضافة أو تعديل) في قاعدة البيانات
  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // التحقق من الصلاحيات
    const currentUser = authService.getCurrentUser();
    if (currentUser?.Role !== 'Admin' && currentUser?.Role !== 'SuperAdmin') {
      useUIStore.getState().addToast('غير مصرح لك بإدارة المستخدمين', 'error');
      return;
    }

    try {
      if (editingUser) {
        // تحديث مستخدم موجود
        await db.users.update(editingUser.id, {
          name: formData.name,
          role: formData.role,
          branch: formData.branch,
          status: formData.status,
          ...(formData.password ? { password: formData.password } : {}) // تحديث كلمة المرور فقط إذا تم إدخالها
        });
        useUIStore.getState().addToast('تم تحديث بيانات المستخدم بنجاح', 'success');
      } else {
        // إضافة مستخدم جديد
        await db.users.add({
          ...formData,
          id: Date.now().toString(),
          createdAt: new Date().toISOString()
        });
        useUIStore.getState().addToast('تمت إضافة المستخدم بنجاح', 'success');
      }
      setIsModalOpen(false);
    } catch (err: any) {
      useUIStore.getState().addToast(`فشل حفظ المستخدم: ${err.message}`, 'error');
    }
  };

  // 👈 5. حذف المستخدم
  const handleDeleteUser = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('هل أنت متأكد من حذف هذا المستخدم؟')) {
      try {
        await db.users.delete(id);
        useUIStore.getState().addToast('تم حذف المستخدم', 'success');
      } catch (err) {
        useUIStore.getState().addToast('فشل حذف المستخدم', 'error');
      }
    }
  };

  // 👈 6. حفظ الصلاحيات
  const handleSavePermissions = async () => {
    if (!selectedUser) return;
    try {
      const existing = await db.userPermissions.where('userId').equals(selectedUser.id).first();
      if (existing) {
        await db.userPermissions.update(existing.id, { permissions: modulesPermissions });
      } else {
        await db.userPermissions.add({ id: Date.now().toString(), userId: selectedUser.id, permissions: modulesPermissions });
      }
      useUIStore.getState().addToast('تم حفظ الصلاحيات بنجاح', 'success');
    } catch (err) {
      useUIStore.getState().addToast('فشل حفظ الصلاحيات', 'error');
    }
  };

  return (
    <div className="space-y-4 dir-rtl text-right font-cairo">
      
      {/* التبويب العلوي */}
      <div className="flex bg-slate-100 p-1 rounded-xl gap-1">
        <button
          onClick={() => setActiveSubTab('users')}
          className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
            activeSubTab === 'users' ? 'bg-white text-emerald-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>حسابات الموظفين</span>
        </button>
        <button
          onClick={() => setActiveSubTab('permissions')}
          className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
            activeSubTab === 'permissions' ? 'bg-white text-emerald-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>مصفوفة الصلاحيات</span>
        </button>
      </div>

      {activeSubTab === 'users' ? (
        <div className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-800">إدارة مستخدمي الصيدلية</h3>
                <p className="text-[10px] text-slate-400">انقر على الموظف للتحكم المباشر بصلاحياته</p>
              </div>
            </div>
            <button
              onClick={handleOpenAddModal}
              className="py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 transition-colors shrink-0 shadow-xs"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>إضافة مستخدم</span>
            </button>
          </div>

          <div className="space-y-2">
            {users.map((u: any) => (
              <div
                key={u.id}
                onClick={() => handleSelectUserPermissions(u)}
                className="p-3 bg-slate-50/70 hover:bg-emerald-50/40 border border-slate-100 hover:border-emerald-200 rounded-xl flex items-center justify-between cursor-pointer transition-all"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center text-xs shrink-0">
                    {u.name?.charAt(0) || '؟'}
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-800">{u.name}</h4>
                    <p className="text-[10px] text-slate-400 font-mono">@{u.username} • {u.branch}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                    {u.role}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
                    u.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                  }`}>
                    <CheckCircle2 className="w-2.5 h-2.5" /> {u.status === 'active' ? 'نشط' : 'معطل'}
                  </span>
                  <button onClick={(e) => handleOpenEditModal(u, e)} className="p-1.5 text-slate-500 hover:text-emerald-700 rounded-lg hover:bg-emerald-100/50 transition-colors">
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button onClick={(e) => handleDeleteUser(u.id, e)} className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg hover:bg-red-100/50 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {users.length === 0 && (
              <p className="text-center text-xs text-slate-400 py-4">لا يوجد مستخدمون مسجلون حالياً.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="bg-emerald-800 text-white p-3 rounded-xl flex items-center justify-between shadow-xs">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-emerald-200" />
              <h3 className="text-sm font-bold">صلاحيات : {selectedUser?.name}</h3>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleSavePermissions} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-bold transition-colors">
                حفظ الصلاحيات
              </button>
              <button onClick={() => setActiveSubTab('users')} className="p-1 hover:bg-emerald-700 rounded-lg transition-colors text-xs flex items-center gap-1">
                <span>رجوع</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            {Object.entries(modulesPermissions).map(([moduleName, perms]) => (
              <div key={moduleName} className="bg-white rounded-xl p-3 border border-slate-200/80 shadow-xs space-y-2.5">
                <h4 className="text-xs font-bold text-center text-slate-800 border-b border-slate-100 pb-1.5">
                  {moduleName}
                </h4>
                <div className="grid grid-cols-4 gap-1.5 dir-rtl text-center">
                  {['read', 'add', 'edit', 'delete'].map((action) => (
                    <label key={action} className="flex flex-col items-center justify-center p-1.5 rounded-lg border border-slate-100 bg-slate-50/50 cursor-pointer hover:bg-emerald-50/30 transition-colors">
                      <span className="text-[10px] font-bold text-slate-600 mb-1">
                        {action === 'read' ? 'قراءة' : action === 'add' ? 'إضافة' : action === 'edit' ? 'تعديل' : 'حذف'}
                      </span>
                      <input
                        type="checkbox"
                        checked={(perms as any)[action]}
                        onChange={() => toggleAction(moduleName, action as any)}
                        className="w-4 h-4 accent-emerald-600 rounded cursor-pointer"
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* النافذة المنبثقة Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white w-full max-w-md rounded-2xl p-5 shadow-2xl border border-slate-100 my-auto space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-emerald-600" />
                <span>{editingUser ? 'تعديل بيانات المستخدم' : 'إضافة مستخدم جديد'}</span>
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveUser} className="space-y-3">
              <div>
                <label className="text-[11px] font-bold text-slate-600 mb-1 block">اسم الموظف الثلاثي:</label>
                <input
                  type="text" required placeholder="مثال: د. عبد الله الخالد"
                  value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full text-xs p-2.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:border-emerald-500 outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 mb-1 block">اسم المستخدم (للدخول):</label>
                <input
                  type="text" required placeholder="مثال: abdullah_pharm" disabled={!!editingUser}
                  value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="w-full text-xs p-2.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:border-emerald-500 outline-none dir-ltr text-right disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 mb-1 block">كلمة السر {editingUser && '(اتركها فارغة للتخطي)'}:</label>
                <input
                  type="password" required={!editingUser} placeholder="••••••••"
                  value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full text-xs p-2.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:border-emerald-500 outline-none dir-ltr text-right"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-bold text-slate-600 mb-1 block">المسمى الوظيفي:</label>
                  <select
                    value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                    className="w-full text-xs p-2.5 rounded-lg border border-slate-200 bg-slate-50 outline-none"
                  >
                    <option value="صيدلي مسؤول">صيدلي مسؤول</option>
                    <option value="كاشير مبيعات">كاشير مبيعات</option>
                    <option value="مدير نظام">مدير نظام</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-bold text-slate-600 mb-1 block">حالة الحساب:</label>
                  <select
                    value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    className="w-full text-xs p-2.5 rounded-lg border border-slate-200 bg-slate-50 outline-none"
                  >
                    <option value="active">نشط 🟢</option>
                    <option value="inactive">معطل 🔴</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
                <button type="submit" className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs transition-colors shadow-xs">
                  حفظ البيانات
                </button>
                <button type="button" onClick={() => setIsModalOpen(false)} className="py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs transition-colors">
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersTab;
