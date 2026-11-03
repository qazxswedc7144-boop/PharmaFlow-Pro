import { useState, useEffect } from 'react';
import { SettingsCard, Accordion, SettingInput, SettingSelect, SettingToggle } from '../shared/SettingsUI';
import { Settings, Hash, Cpu, Zap } from 'lucide-react';
import { settingsService, type SettingValue } from '../../data/SettingsService';
import { useTheme } from '../../../../contexts/ThemeContext';
import { useAdaptivePerformance, type EcoModeValue } from '../../../../hooks/useAdaptivePerformance';
import { useUIStore } from '../../../../store/useUIStore';
import { useSettingsStore } from '../../../../store/useSettingsStore';

// 👈 استيراد خدمة المصادقة للتحقق من صلاحيات المستخدم
import { authService } from '@features/auth/services/authService'; 

interface GeneralTabProps {
  activeTab?: string;
}

export default function GeneralTab({ activeTab }: GeneralTabProps = {}) {
  const [settings, setSettings] = useState<Record<string, SettingValue>>({});
  const { themeMode, setThemeMode } = useTheme();
  const currentCurrency = useSettingsStore((state) => state.currency);
  const setStoreCurrency = useSettingsStore((state) => state.setCurrency);

  const {
    specs,
    ecoMode,
    simplifiedAnimations,
    isEcoActive,
    updateSetting,
    requestStateCleanup
  } = useAdaptivePerformance();

  useEffect(() => {
    settingsService.getSettingsGroup(['system_name', 'language', 'timezone', 'currency', 'date_format', 'time_format']).then((res) => {
      setSettings({
        ...res,
        currency: currentCurrency || res.currency || 'YER'
      });
    });
  }, [currentCurrency]);

  const handleChange = (key: string, value: SettingValue) => {
    // 👈 1. التحقق من صلاحيات المستخدم (RBAC)
    const user = authService.getCurrentUser();
    if (user?.Role !== 'Admin' && user?.Role !== 'SuperAdmin') {
      useUIStore.getState().addToast('غير مصرح لك بتعديل الإعدادات. يتطلب صلاحيات مدير.', 'error');
      return; // إيقاف العملية
    }

    // 👈 2. تحذير تغيير العملة الأساسية
    if (key === 'currency' && value !== settings.currency) {
      const confirmChange = window.confirm(
        'تحذير هام: تغيير العملة الأساسية سيؤثر على التقارير المالية التاريخية والأسعار المخزنة. هل أنت متأكد من رغبتك في المتابعة؟'
      );
      if (!confirmChange) return; // إيقاف العملية إذا تراجع المستخدم
    }

    setSettings((prev) => ({ ...prev, [key]: value }));
    settingsService.saveSetting(key, value, true);

    if (key === 'currency' && typeof value === 'string') {
      setStoreCurrency(value);
      useUIStore.getState().addToast(`تم اعتماد العملة: ${value}`, 'success');
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard title="إعدادات النظام العامة" description="تخصيص الهوية الأساسية للنظام" icon={Settings}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingInput
            label="اسم النظام"
            value={(settings.system_name as string) || 'PharmaFlow Pro'}
            onChange={(val: string) => handleChange('system_name', val)}
          />
          <SettingSelect
            label="الوضع (ليلي/نهاري)"
            value={themeMode}
            onChange={(val: string) => setThemeMode(val as 'light' | 'dark' | 'system')}
            options={[
              { value: 'light', label: 'نهاري (Light)' },
              { value: 'dark', label: 'ليلي (Dark)' },
              { value: 'system', label: 'تلقائي (System)' }
            ]}
          />
          <SettingSelect
            label="اللغة الافتراضية"
            value={(settings.language as string) || 'ar'}
            onChange={(val: string) => handleChange('language', val)}
            options={[
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' }
            ]}
          />
        </div>
      </SettingsCard>

      <Accordion title="المنطقة والعملة" defaultOpen={activeTab === 'currency' || !activeTab}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingSelect
            label="العملة الرئيسية"
            value={(settings.currency as string) || currentCurrency || 'YER'}
            onChange={(val: string) => handleChange('currency', val)}
            options={[
              { value: 'YER', label: 'ريال يمني (YER)' },
              { value: 'SAR', label: 'ريال سعودي (SAR)' },
              { value: 'USD', label: 'دولار أمريكي (USD)' },
              { value: 'AED', label: 'درهم إماراتي (AED)' },
              { value: 'EGP', label: 'جنيه مصري (EGP)' }
            ]}
          />
          <SettingSelect
            label="المنطقة الزمنية"
            value={(settings.timezone as string) || 'Asia/Riyadh'}
            onChange={(val: string) => handleChange('timezone', val)}
            options={[
              { value: 'Asia/Riyadh', label: 'توقيت السعودية (الرياض)' },
              { value: 'Africa/Cairo', label: 'توقيت مصر (القاهرة)' },
              { value: 'Asia/Dubai', label: 'توقيت الإمارات (دبي)' }
            ]}
          />
        </div>
      </Accordion>

      <Accordion title="التاريخ والوقت" defaultOpen={activeTab === 'datetime' || !activeTab}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingSelect
            label="صيغة التاريخ"
            value={(settings.date_format as string) || 'YYYY-MM-DD'}
            onChange={(val: string) => handleChange('date_format', val)}
            options={[
              { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2026-12-31)' },
              { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (31/12/2026)' },
              { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (12/31/2026)' }
            ]}
          />
          <SettingSelect
            label="صيغة الوقت"
            value={(settings.time_format as string) || '24h'}
            onChange={(val: string) => handleChange('time_format', val)}
            options={[
              { value: '24h', label: '24 ساعة (14:30)' },
              { value: '12h', label: '12 ساعة (02:30 م)' }
            ]}
          />
        </div>
      </Accordion>

      <Accordion title="توافق الأداء والهواتف والأجهزة الاقتصادية (Eco Mode)" defaultOpen={specs.isMobileSize}>
        <div className="space-y-4 font-cairo">
          <p className="text-xs text-slate-500 leading-relaxed">
            يقوم النظام تلقائياً بتحليل مواصفات جهازك (المعالج والرامات وسرعة الاتصال) لتهيئة التطبيق للعمل بأعلى كفاءة وسلاسة، وتوفير استهلاك الذاكرة والبطارية على الهواتف والأجهزة ذات المواصفات الاقتصادية.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SettingSelect
              label="وضع التوفير والأداء الاقتصادي (Eco Mode)"
              value={ecoMode}
              onChange={(val) => updateSetting('eco_mode', val as EcoModeValue)}
              description="تخفيض استهلاك الذاكرة والمعالج عبر تقليص عمليات الخلفية وتحديد أحجام القوائم."
              options={[
                { value: 'auto', label: 'تلقائي (حسب مواصفات الجهاز)' },
                { value: 'enabled', label: 'مفعل دائماً (توفير أقصى للذاكرة)' },
                { value: 'disabled', label: 'معطل (أداء كامل بدون قيود)' }
              ]}
            />

            <div className="flex flex-col justify-end">
              <SettingToggle
                label="تبسيط وتخفيف الرسومات والحركة"
                description="إيقاف التأثيرات الحركية المعقدة لتسريع الاستجابة على المعالجات القديمة."
                checked={simplifiedAnimations}
                onChange={(val) => updateSetting('simplified_animations', val)}
              />
            </div>
          </div>

          <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700 space-y-3">
            <h4 className="text-sm font-bold text-slate-700 dark:text-slate-200 flex items-center gap-2">
              <Cpu size={16} className="text-indigo-600 dark:text-indigo-400" />
              <span>تحليل مواصفات الجهاز الحالي:</span>
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
              <div className="bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block mb-1">أنوية المعالج (CPU)</span>
                <span className="font-bold text-slate-700 dark:text-slate-300">{specs.hardwareConcurrency} أنوية</span>
              </div>
              <div className="bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block mb-1">ذاكرة الرام (RAM)</span>
                <span className="font-bold text-slate-700 dark:text-slate-300">{specs.deviceMemory >= 8 ? '8+ جيجابايت' : `${specs.deviceMemory} جيجابايت`}</span>
              </div>
              <div className="bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block mb-1">وضع توفير البيانات</span>
                <span className="font-bold text-slate-700 dark:text-slate-300">{specs.saveData ? 'نشط' : 'غير نشط'}</span>
              </div>
              <div className="bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block mb-1">حالة الأداء الفعلية</span>
                <span className={`font-bold ${isEcoActive ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {isEcoActive ? 'نمط اقتصادي (Eco)' : 'نمط الأداء العالي'}
                </span>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => {
                  requestStateCleanup();
                  useUIStore.getState().addToast('تم تحرير وتنظيف ذاكرة التطبيق المؤقتة بنجاح.', 'success');
                }}
                className="px-4 py-2 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <Zap size={14} />
                <span>تحرير الذاكرة الفوري (Memory Clean)</span>
              </button>
            </div>
          </div>
        </div>
      </Accordion>

      <SettingsCard title="بيانات الترخيص والإصدار" description="معلومات النسخة الحالية" icon={Hash}>
         <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingInput label="رقم الإصدار" value="v2.0.0 Enterprise" disabled />
          <SettingInput label="حالة الترخيص" value="مفعل - Enterprise Edition" disabled />
         </div>
      </SettingsCard>
    </div>
  );
}
