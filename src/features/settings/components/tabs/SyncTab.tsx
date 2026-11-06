import { SettingsCard } from '../shared/SettingsUI';
import { RefreshCw, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { db, getCurrentUserSession } from '@/core/db';
import { useLiveQuery } from 'dexie-react-hooks';

export default function SyncTab() {
  const pendingCount = useLiveQuery(async () => {
    try {
      const session = getCurrentUserSession();
      if (!session.tenantId) return 0;
      // 🚨 CONSISTENCY: Count both camelCase and UPPERCASE statuses used by engine
      return await db.outbox
        .where('status')
        .anyOf('pending', 'PENDING')
        .and(item => item.tenantId === session.tenantId)
        .count();
    } catch {
      return 0;
    }
  }) || 0;

  const failedCount = useLiveQuery(async () => {
    try {
      const session = getCurrentUserSession();
      if (!session.tenantId) return 0;
      // 🚨 CONSISTENCY: Include RETRYING in failed/warning count
      return await db.outbox
        .where('status')
        .anyOf('failed', 'FAILED', 'RETRYING')
        .and(item => item.tenantId === session.tenantId)
        .count();
    } catch {
      return 0;
    }
  }) || 0;
  
  const handleForceSync = () => {
    // Dispatch a custom event to wake up the sync engine
    window.dispatchEvent(new CustomEvent('SYNC_WAKEUP'));
  };

  const handleClearFailed = async () => {
    const session = getCurrentUserSession();
    if (!session.tenantId) return;
    const tenantId = session.tenantId;
    const userId = session.userId;
    
    // 🚨 SECURITY: Only delete failed records belonging to the current tenant
    const failedIds = await db.outbox
      .where('status')
        .anyOf('failed', 'FAILED', 'RETRYING')
        .and(item => item.tenantId === tenantId)
      .primaryKeys();

    const latestSession = getCurrentUserSession();
    if (latestSession.tenantId !== tenantId || latestSession.userId !== userId) return;
      
    if (failedIds.length > 0) {
      await db.outbox.bulkDelete(failedIds);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard title="لوحة المزامنة (Synchronization)" description="مراقبة الاتصال السحابي ومعالجة الطابور" icon={RefreshCw}>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-emerald-700 font-bold font-cairo">حالة الاتصال</p>
              <p className="text-sm text-emerald-600 font-cairo">متصل (Firebase)</p>
            </div>
            <CheckCircle2 size={24} className="text-emerald-500" />
          </div>
          
          <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-blue-700 font-bold font-cairo">قيد الانتظار</p>
              <p className="text-sm text-blue-600 font-cairo">{pendingCount} عملية (Outbox)</p>
            </div>
            <Clock size={24} className="text-blue-500" />
          </div>

          <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-red-700 font-bold font-cairo">فشل في المزامنة</p>
              <p className="text-sm text-red-600 font-cairo">{failedCount} عملية (Retrying)</p>
            </div>
            <AlertCircle size={24} className="text-red-500" />
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button 
            onClick={handleForceSync}
            className="px-6 py-2.5 bg-[#1E4D4D] text-white font-bold rounded-xl hover:bg-[#153737] transition-colors font-cairo flex items-center gap-2 shadow-sm"
          >
            <RefreshCw size={18} />
            إعادة محاولة المزامنة
          </button>
          
          {failedCount > 0 && (
            <button 
              onClick={handleClearFailed}
              className="px-6 py-2.5 bg-red-50 text-red-600 font-bold rounded-xl border border-red-200 hover:bg-red-100 transition-colors font-cairo"
            >
              حذف العمليات الفاشلة
            </button>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
