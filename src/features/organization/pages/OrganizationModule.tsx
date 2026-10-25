// src/features/organization/pages/OrganizationModule.tsx
import React, { useState } from 'react';
import { 
  Building2, Users, KeyRound, Grid, Layers
} from 'lucide-react';
import { OrganizationDashboard } from '../components/OrganizationDashboard';
import { UserManagement } from '../components/UserManagement';
import { RoleManagement } from '../components/RoleManagement';
import { PermissionMatrix } from '../components/PermissionMatrix';
import { BranchSecurityManager } from '../components/BranchSecurityManager';
import { useAuthStore } from '../../../store/authStore';

export const OrganizationModule: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'users' | 'roles' | 'matrix' | 'branches'>('dashboard');
  const { tenantId, user } = useAuthStore();

  const tabs = [
    { id: 'dashboard', label: 'لوحة الهيكل والمؤشرات', icon: Layers },
    { id: 'users', label: 'المستخدمون والصلاحيات', icon: Users },
    { id: 'roles', label: 'الأدوار والمجموعات', icon: KeyRound },
    { id: 'matrix', label: 'مصفوفة الصلاحيات', icon: Grid },
    { id: 'branches', label: 'أمان وضوابط الفروع', icon: Building2 },
  ] as const;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Top Header Card */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-3xl border border-slate-100 shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#1E4D4D] to-[#2E7272] text-white flex items-center justify-center shadow-lg shadow-emerald-950/15">
            <Building2 size={24} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black text-slate-800">
                إدارة المؤسسة والصلاحيات المتقدمة (RBAC & IAM)
              </h1>
              <span className="bg-emerald-50 text-emerald-700 text-[10px] font-black px-2.5 py-0.5 rounded-full border border-emerald-200">
                Sovereign Enterprise
              </span>
            </div>
            <p className="text-xs text-slate-400 font-medium mt-0.5">
              معرف المؤسسة الحالي: <span className="font-mono text-slate-600 font-bold">{tenantId || 'غير معرف'}</span> | المستخدم: <span className="font-bold text-slate-700">{user?.username || user?.role || 'المشرف'}</span>
            </p>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1.5 bg-slate-50 p-1.5 rounded-2xl border border-slate-200/60 overflow-x-auto custom-scrollbar">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 whitespace-nowrap transition-all ${
                  isActive
                    ? 'bg-[#1E4D4D] text-white shadow-md shadow-emerald-950/10'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white/80'
                }`}
              >
                <Icon size={15} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main View Area */}
      <div>
        {activeTab === 'dashboard' && <OrganizationDashboard onNavigateTab={(tab) => setActiveTab(tab as any)} />}
        {activeTab === 'users' && <UserManagement />}
        {activeTab === 'roles' && <RoleManagement />}
        {activeTab === 'matrix' && <PermissionMatrix />}
        {activeTab === 'branches' && <BranchSecurityManager />}
      </div>
    </div>
  );
};

export default OrganizationModule;
