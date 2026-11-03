import { useState, useEffect } from 'react';
import { SettingsCard, Accordion, SettingInput, SettingToggle, SettingSelect } from '../shared/SettingsUI';
import { Building2, Printer, Download, Image as ImageIcon } from 'lucide-react';
import { settingsService, type SettingValue } from '../../data/SettingsService';
import { authService } from '@features/auth/services/authService'; // 👈 للتحقق من الصلاحيات
import { useUIStore } from '../../../../store/useUIStore'; // 👈 للإشعارات

export default function PharmacyTab() {
  const [settings, setSettings] = useState<Record<string, SettingValue>>({});

  useEffect(() => {
    settingsService.getSettingsGroup([
      'pharmacy_name', 'pharmacy_logo', 'pharmacy_icon', 'pharmacy_address', 'pharmacy_phone', 
      'tax_number', 'commercial_record', 'invoice_qr', 'print_paper_size',
      'print_margin', 'print_copies', 'print_logo', 'invoice_footer'
    ]).then(setSettings);
  }, []);

  const handleChange = async (key: string, value: SettingValue) => {
    // 👈 1. التحقق من صلاحيات المستخدم (RBAC)
    const user = authService.getCurrentUser();
    if (user?.Role !== 'Admin' && user?.Role !== 'SuperAdmin') {
      useUIStore.getState().addToast('غير مصرح لك بتعديل الإعدادات. يتطلب صلاحيات مدير.', 'error');
      return;
    }

    setSettings((prev) => ({ ...prev, [key]: value }));
    
    try {
      await settingsService.saveSetting(key, value, true);
    } catch (err) {
      useUIStore.getState().addToast('فشل حفظ الإعداد، يرجى المحاولة مرة أخرى', 'error');
    }
  };

  // 👈 2. دالة مساعدة لمعالجة رفع الصور (تحويلها إلى Base64 لحفظها في Dexie)
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, key: string) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      handleChange(key, reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  // استخراج مسارات الصور من الإعدادات (إذا وجدت) أو استخدام الافتراضية
  const logoSrc = (settings.pharmacy_logo as string) || '/pharmaflow_logo.jpg';
  const iconSrc = (settings.pharmacy_icon as string) || '/pharmaflow_icon.jpg';

  return (
    <div className="space-y-6">
      <SettingsCard title="شعار وأيقونة الهوية الموحدة" description="معاينة وتحميل الشعار والأيقونة الرسمية مباشرة للطباعة والوثائق والتطبيقات" icon={ImageIcon}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* الشعار (Logo) */}
          <div className="flex items-center gap-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700">
            <div className="w-16 h-16 rounded-2xl overflow-hidden border-2 border-[#1E4D4D]/20 shadow-sm bg-white shrink-0 p-1">
              <img src={logoSrc} alt="PharmaFlow Logo" className="w-full h-full object-cover rounded-xl" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm truncate">شعار الصيدلية (Logo)</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">يظهر في الفواتير والتقارير</p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <label className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg text-[10px] font-bold cursor-pointer transition-all shadow-sm">
                <ImageIcon size={12} />
                <span>تغيير</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'pharmacy_logo')} />
              </label>
              <a
                href={logoSrc}
                download="pharmacy_logo.jpg"
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 rounded-lg text-[10px] font-bold transition-all shadow-sm"
              >
                <Download size={12} />
                <span>تحميل</span>
              </a>
            </div>
          </div>

          {/* الأيقونة (Icon) */}
          <div className="flex items-center gap-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700">
            <div className="w-16 h-16 rounded-2xl overflow-hidden border-2 border-[#1E4D4D]/20 shadow-sm bg-white shrink-0 p-1">
              <img src={iconSrc} alt="PharmaFlow Icon" className="w-full h-full object-cover rounded-xl" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm truncate">أيقونة النظام (Icon)</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">تظهر كأيقونة للتطبيق</p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <label className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg text-[10px] font-bold cursor-pointer transition-all shadow-sm">
                <ImageIcon size={12} />
                <span>تغيير</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'pharmacy_icon')} />
              </label>
              <a
                href={iconSrc}
                download="pharmacy_icon.jpg"
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 rounded-lg text-[10px] font-bold transition-all shadow-sm"
              >
                <Download size={12} />
                <span>تحميل</span>
              </a>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="بيانات الصيدلية" description="تظهر هذه البيانات في الفواتير والتقارير" icon={Building2}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingInput label="اسم الصيدلية" value={settings.pharmacy_name} onChange={(v: string) => handleChange('pharmacy_name', v)} />
          <SettingInput label="رقم الهاتف" value={settings.pharmacy_phone} onChange={(v: string) => handleChange('pharmacy_phone', v)} />
          <SettingInput label="الرقم الضريبي" value={settings.tax_number} onChange={(v: string) => handleChange('tax_number', v)} />
          <SettingInput label="السجل التجاري" value={settings.commercial_record} onChange={(v: string) => handleChange('commercial_record', v)} />
          <div className="md:col-span-2">
             <SettingInput label="العنوان التفصيلي" value={settings.pharmacy_address} onChange={(v: string) => handleChange('pharmacy_address', v)} />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="إعدادات الطباعة والفواتير" description="التحكم في شكل وطباعة الفاتورة" icon={Printer}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <SettingSelect
            label="مقاس الورق الافتراضي"
            value={(settings.print_paper_size as string) || 'receipt_80'}
            onChange={(v: string) => handleChange('print_paper_size', v)}
            options={[
              { value: 'receipt_80', label: 'رول إيصالات (80mm)' },
              { value: 'receipt_58', label: 'رول إيصالات (58mm)' },
              { value: 'a4', label: 'A4 كامل' },
              { value: 'a5', label: 'A5 نصف ورقة' }
            ]}
          />
          <SettingInput type="number" label="عدد النسخ الافتراضي" value={(settings.print_copies as string) || '1'} onChange={(v: string) => handleChange('print_copies', v)} />
        </div>
        
        <Accordion title="خيارات إضافية للطباعة">
          <div className="space-y-4">
            <SettingToggle label="طباعة الشعار على الفاتورة" checked={settings.print_logo} onChange={(v: boolean) => handleChange('print_logo', v)} />
            <SettingToggle label="توليد رمز QR للفاتورة (متوافق مع هيئة الزكاة)" checked={settings.invoice_qr} onChange={(v: boolean) => handleChange('invoice_qr', v)} />
            <SettingInput label="تذييل الفاتورة (رسالة ترحيبية)" value={(settings.invoice_footer as string) || 'نتمنى لكم دوام الصحة والعافية'} onChange={(v: string) => handleChange('invoice_footer', v)} />
          </div>
        </Accordion>
      </SettingsCard>
    </div>
  );
}
