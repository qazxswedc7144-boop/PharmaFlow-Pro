import { useState, useEffect } from 'react';
import { SettingsCard, SettingToggle } from '../shared/SettingsUI';
import { ShieldCheck } from 'lucide-react';
import { settingsService, type SettingValue } from '../../data/SettingsService';
import { authService } from '@features/auth/services/authService'; // 👈 للتحقق من الصلاحيات
import { useUIStore } from '@/store/useUIStore'; // 👈 للإشعارات

export default function SecurityTab() {
  const [settings, setSettings] = useState<Record<string, SettingValue>>({});

  useEffect(() => {
    settingsService.getSettingsGroup([
      'security_require_pin', 'security_session_timeout', 'security_audit_log'
    ]).then(setSettings);
  }, []);

  const handleChange = async (key: string, value: SettingValue) => {
    // 👈 1. التحقق من صلاحيات المستخدم (RBAC)
    const user = authService.getCurrentUser();
    if (user?.Role !== 'Admin' && user?.Role !== 'SuperAdmin') {
      useUIStore.getState().addToast('غير مصرح لك بتعديل إعدادات الأمان. يتطلب صلاحيات مدير.', 'error');
      return;
    }

    // 👈 2. تحذير عند محاولة إيقاف سجل التدقيق (Audit Log)
    if (key === 'security_audit_log' && value === false) {
      const confirmDisable = window.confirm(
        'تحذير: إيقاف سجل التدقيق (Audit Log) سيمنع النظام من تسجيل العمليات الحساسة. هذا الإجراء قد يخالف معايير الامتثال. هل أنت متأكد؟'
      );
      if (!confirmDisable) return;
    }

    try {
      // 3. الحفظ في قاعدة البيانات أولاً
      await settingsService.saveSetting(key, value, true);
      
      // 4. تحديث الحالة في الواجهة بعد نجاح الحفظ
      setSettings((prev) => ({ ...prev, [key]: value }));
    } catch (err) {
      useUIStore.getState().addToast('فشل حفظ إعدادات الأمان، يرجى المحاولة مرة أخرى', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard title="إعدادات الأمان (Security)" description="حماية النظام وتتبع العمليات" icon={ShieldCheck}>
        <div className="space-y-4">
          <SettingToggle 
            label="قفل الشاشة السريع (PIN)" 
            description="طلب رمز PIN عند ترك الجهاز لفترة" 
            checked={!!settings.security_require_pin} 
            onChange={(v: boolean) => handleChange('security_require_pin', v)} 
          />
          <SettingToggle 
            label="انتهاء الجلسة التلقائي" 
            description="تسجيل الخروج التلقائي بعد 30 دقيقة من الخمول" 
            checked={!!settings.security_session_timeout} 
            onChange={(v: boolean) => handleChange('security_session_timeout', v)} 
          />
          <SettingToggle 
            label="تسجيل العمليات (Audit Log)" 
            description="حفظ سجل مفصل لكل عملية وتغيير في النظام" 
            checked={!!settings.security_audit_log} 
            onChange={(v: boolean) => handleChange('security_audit_log', v)} 
          />
        </div>
      </SettingsCard>
    </div>
  );
}
