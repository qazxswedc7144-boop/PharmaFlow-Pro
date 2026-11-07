import { useEffect, useState } from 'react';
import { SettingsCard, SettingToggle, SettingInput, SettingSelect } from '../shared/SettingsUI';
import { ShoppingCart } from 'lucide-react';
import { settingsService, type SettingValue } from '../../data/SettingsService';
import { TokenProvider } from '@/services/auth/tokenProvider';

type SalesTaxMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';

function buildAuthHeaders(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(TokenProvider.getAuthHeaders())
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
  );
}

interface SalesPolicy {
  maxDiscountPercent: number;
  taxRatePercent: number;
  taxMode: SalesTaxMode;
}

const DEFAULT_POLICY: SalesPolicy = {
  maxDiscountPercent: 0,
  taxRatePercent: 0,
  taxMode: 'NONE'
};

export default function SalesTab() {
  const [settings, setSettings] = useState<Record<string, SettingValue>>({});
  const [policy, setPolicy] = useState<SalesPolicy>(DEFAULT_POLICY);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const [policySaved, setPolicySaved] = useState(false);

  useEffect(() => {
    settingsService.getSettingsGroup([
      'sales_allow_negative', 'sales_invoice_prefix'
    ]).then(setSettings);

    fetch('/api/sales-policy', {
      headers: buildAuthHeaders()
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.policy) {
          throw new Error(payload.message || payload.error || 'تعذر تحميل سياسة المبيعات من الخادم.');
        }
        setPolicy({
          maxDiscountPercent: Number(payload.policy.maxDiscountPercent ?? 0),
          taxRatePercent: Number(payload.policy.taxRatePercent ?? 0),
          taxMode: payload.policy.taxMode ?? 'NONE'
        });
      })
      .catch((error) => {
        setPolicyError(error instanceof Error ? error.message : 'تعذر تحميل سياسة المبيعات.');
      })
      .finally(() => setPolicyLoading(false));
  }, []);

  const handleChange = (key: string, value: SettingValue) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    settingsService.saveSetting(key, value, true).catch((error) => {
      console.error('[SalesTab] Failed to save local sales preference:', error);
    });
  };

  const savePolicy = async () => {
    setPolicySaving(true);
    setPolicyError('');
    setPolicySaved(false);

    try {
      const response = await fetch('/api/sales-policy', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(buildAuthHeaders().entries())
        },
        body: JSON.stringify(policy)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.policy) {
        throw new Error(payload.message || payload.error || 'تعذر حفظ سياسة المبيعات.');
      }
      setPolicy({
        maxDiscountPercent: Number(payload.policy.maxDiscountPercent ?? 0),
        taxRatePercent: Number(payload.policy.taxRatePercent ?? 0),
        taxMode: payload.policy.taxMode ?? 'NONE'
      });
      setPolicySaved(true);
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : 'تعذر حفظ سياسة المبيعات.');
    } finally {
      setPolicySaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard title="إعدادات المبيعات" description="التحكم في نقاط البيع (POS) والفواتير" icon={ShoppingCart}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <SettingInput label="بادئة الفاتورة (Prefix)" value={(settings.sales_invoice_prefix as string) || 'INV-'} onChange={(v: string) => handleChange('sales_invoice_prefix', v)} />
          <SettingSelect
            label="الضريبة الافتراضية (%)"
            value={String(policy.taxRatePercent)}
            onChange={(v: string) => {
              setPolicy((prev) => ({ ...prev, taxRatePercent: Number(v) }));
              setPolicySaved(false);
            }}
            options={[
              { value: '0', label: '0% (معفى)' },
              { value: '5', label: '5%' },
              { value: '15', label: '15%' }
            ]}
            disabled={policyLoading || policySaving}
          />
          <SettingInput
            type="number"
            label="الحد الأقصى للخصم (%)"
            value={String(policy.maxDiscountPercent)}
            onChange={(v: string) => {
              const parsed = Number(v);
              setPolicy((prev) => ({ ...prev, maxDiscountPercent: Number.isFinite(parsed) ? parsed : 0 }));
              setPolicySaved(false);
            }}
            disabled={policyLoading || policySaving}
          />
          <SettingSelect
            label="طريقة احتساب الضريبة"
            value={policy.taxMode}
            onChange={(v: string) => {
              setPolicy((prev) => ({ ...prev, taxMode: v as SalesTaxMode }));
              setPolicySaved(false);
            }}
            options={[
              { value: 'NONE', label: 'بدون ضريبة' },
              { value: 'EXCLUSIVE', label: 'تضاف إلى السعر (Exclusive)' },
              { value: 'INCLUSIVE', label: 'مضمنة في السعر (Inclusive)' }
            ]}
            disabled={policyLoading || policySaving}
          />
        </div>

        {policy.taxMode === 'NONE' && policy.taxRatePercent !== 0 && (
          <p className="text-xs text-amber-700 font-cairo">اختر طريقة احتساب الضريبة أو اجعل النسبة 0% قبل الحفظ.</p>
        )}

        {policyLoading && <p className="text-xs text-slate-500 font-cairo">جارٍ تحميل السياسة المعتمدة من الخادم...</p>}
        {policyError && <p role="alert" className="text-xs text-red-600 font-cairo">{policyError}</p>}
        {policySaved && <p className="text-xs text-emerald-700 font-cairo">تم حفظ سياسة الخصم والضريبة للمؤسسة.</p>}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={savePolicy}
            disabled={policyLoading || policySaving}
            className="px-5 py-2.5 rounded-xl bg-[#1E4D4D] text-white text-sm font-bold font-cairo disabled:opacity-50"
          >
            {policySaving ? 'جارٍ الحفظ...' : 'حفظ سياسة المبيعات'}
          </button>
        </div>

        <div className="space-y-4 pt-4 border-t border-slate-100">
          <SettingToggle
            label="البيع بالسالب"
            description="السماح ببيع المنتجات حتى لو كان المخزون صفراً"
            checked={!!settings.sales_allow_negative}
            onChange={(v: boolean) => handleChange('sales_allow_negative', v)}
          />
        </div>
      </SettingsCard>
    </div>
  );
}
