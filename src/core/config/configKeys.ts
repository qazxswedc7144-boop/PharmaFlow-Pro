// src/core/config/configKeys.ts
import { ConfigurationDefinition } from './types';

/**
 * Phase 3.4.5 Canonical Key Registry
 * 
 * ⚠️ RULES:
 * 1. All keys must follow [domain].[snake_case_property] format.
 * 2. 'SERVER_AUTHORITATIVE' means the value is controlled by the backend (read-only locally).
 * 3. 'LOCAL_ONLY' means the value is not synced to the cloud (e.g., device-specific settings).
 */
export const CONFIG_REGISTRY: Record<string, ConfigurationDefinition<any>> = {
  // System / General
  'system.name': {
    key: 'system.name',
    defaultValue: 'PharmaFlow Pro',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['system_name'],
    description: 'اسم المنظومة أو النظام'
  },
  'system.language': {
    key: 'system.language',
    defaultValue: 'ar',
    scope: 'USER',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['language'],
    description: 'لغة الواجهة المفضل للمستخدم'
  },
  'system.timezone': {
    key: 'system.timezone',
    defaultValue: 'Asia/Riyadh',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['timezone'],
    description: 'المنطقة الزمنية للمؤسسة'
  },
  'system.currency': {
    key: 'system.currency',
    defaultValue: 'YER',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['currency', 'ACTIVE_CURRENCY', 'pharmaflow_currency', 'pharma_currency'],
    description: 'رمز العملة الرسمية للمؤسسة'
  },
  'system.currency_label': {
    key: 'system.currency_label',
    defaultValue: 'ريال يمني',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['currencyLabel', 'ACTIVE_CURRENCY_NAME'],
    description: 'اسم العملة الرسمي بالعربي'
  },
  'system.date_format': {
    key: 'system.date_format',
    defaultValue: 'YYYY-MM-DD',
    scope: 'USER',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['date_format'],
    description: 'صيغة عرض التاريخ'
  },
  'system.time_format': {
    key: 'system.time_format',
    defaultValue: '24h',
    scope: 'USER',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['time_format'],
    description: 'صيغة عرض الوقت'
  },
  'system.auto_backup': {
    key: 'system.auto_backup',
    defaultValue: false,
    scope: 'TENANT',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['autoBackupEnabled'],
    description: 'تفعيل النسخ الاحتياطي التلقائي'
  },

  // User UI
  'user.theme': {
    key: 'user.theme',
    defaultValue: 'system',
    scope: 'USER',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['saas_theme_mode'],
    description: 'المظهر المفضل للمستخدم (فاتح / داكن / نظام)'
  },
  'user.print_size': {
    key: 'user.print_size',
    defaultValue: '80mm',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['saas_printer_profile'],
    description: 'حجم الطباعة المحدد للجهاز'
  },

  // Purchases
  'purchases.prefix': {
    key: 'purchases.prefix',
    defaultValue: 'PO-',
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['purchase_invoice_prefix'],
    description: 'بادئة فواتير الشراء'
  },
  'purchases.price_limit_percent': {
    key: 'purchases.price_limit_percent',
    defaultValue: 5,
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['purchase_price_limit'],
    description: 'حد تحذير اختلاف سعر الشراء (%)'
  },

  // Sales / POS
  'sales.invoice_prefix': {
    key: 'sales.invoice_prefix',
    defaultValue: 'INV-',
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['sales_invoice_prefix'],
    description: 'بادئة فواتير البيع'
  },
  'sales.allow_negative_stock': {
    key: 'sales.allow_negative_stock',
    defaultValue: false,
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['allow_negative_stock'],
    description: 'السماح بالبيع على المكشوف (مخزون بالسالب)'
  },
  'sales.max_discount_percent': {
    key: 'sales.max_discount_percent',
    defaultValue: 15,
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['max_discount_percent'],
    description: 'الحد الأقصى المسموح به للخصم (%)'
  },

  // Inventory
  'inventory.allow_negative_stock': { // 👈 تم توحيد النمط إلى snake_case
    key: 'inventory.allow_negative_stock',
    defaultValue: false,
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['allowNegativeStock', 'inventory.allowNegativeStock'], // 👈 الاحتفاظ بالمفتاح القديم للتوافق
    description: 'السماح بالمخزون بالسالب'
  },
  'inventory.expiry_warning_days': {
    key: 'inventory.expiry_warning_days',
    defaultValue: 90,
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['expiry_warning_days'],
    description: 'عدد الأيام المتبقية للانتهاء للتنبيه'
  },
  'inventory.low_stock_threshold': {
    key: 'inventory.low_stock_threshold',
    defaultValue: 10,
    scope: 'BRANCH',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['low_stock_threshold'],
    description: 'حد المخزون المنخفض'
  },

  // Pharmacy Identity
  'pharmacy.name': {
    key: 'pharmacy.name',
    defaultValue: 'صيدلية فارما فلو',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['pharmacy_name'],
    description: 'اسم الصيدلية الرسمي'
  },
  'pharmacy.phone': {
    key: 'pharmacy.phone',
    defaultValue: '',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['pharmacy_phone'],
    description: 'رقم هاتف الصيدلية'
  },
  'pharmacy.address': {
    key: 'pharmacy.address',
    defaultValue: '',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['pharmacy_address'],
    description: 'عنوان الصيدلية'
  },
  'pharmacy.tax_number': {
    key: 'pharmacy.tax_number',
    defaultValue: '',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['pharmacy_tax_number'],
    description: 'الرقم الضريبي للصيدلية'
  },
  'pharmacy.license_number': {
    key: 'pharmacy.license_number',
    defaultValue: '',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['pharmacy_license_number'],
    description: 'رقم ترخيص الصيدلية'
  },

  // Security (Server Authoritative)
  'security.session_timeout_minutes': {
    key: 'security.session_timeout_minutes',
    defaultValue: 30,
    scope: 'SYSTEM',
    syncPolicy: 'SERVER_AUTHORITATIVE',
    readOnly: true,
    legacyKeys: ['session_timeout_minutes'],
    description: 'مدة انتهاء الجلسة بالدقائق'
  },
  'security.require_2fa': {
    key: 'security.require_2fa',
    defaultValue: false,
    scope: 'SYSTEM',
    syncPolicy: 'SERVER_AUTHORITATIVE',
    readOnly: true,
    legacyKeys: ['require_2fa'],
    description: 'فرض المصادقة الثنائية'
  },

  // AI & OCR
  'ai.enabled': {
    key: 'ai.enabled',
    defaultValue: true,
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['ai_enabled'],
    description: 'تفعيل محرك الذكاء الاصطناعي'
  },
  'ai.model': {
    key: 'ai.model',
    defaultValue: 'gemini-flash-latest',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['ai_model'],
    description: 'نموذج الذكاء الاصطناعي المعتمد'
  },
  'ocr.provider': {
    key: 'ocr.provider',
    defaultValue: 'gemini-vision',
    scope: 'TENANT',
    syncPolicy: 'SYNCABLE',
    legacyKeys: ['ocr_provider'],
    description: 'مزود خدمة OCR للمستندات والفواتير'
  },

  // Sync & Network
  'sync.auto_sync_interval': {
    key: 'sync.auto_sync_interval',
    defaultValue: 30,
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['auto_sync_interval'],
    description: 'فترة المزامنة التلقائية بالثواني'
  },
  'sync.wifi_only': {
    key: 'sync.wifi_only',
    defaultValue: false,
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['wifi_only_sync'],
    description: 'المزامنة عبر Wi-Fi فقط'
  },

  // Device Preferences
  'device.uuid': {
    key: 'device.uuid',
    defaultValue: '',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['erp_device_uuid', 'pharmaflow_device_id'],
    description: 'معرف الجهاز الفريد'
  },
  'device.name': {
    key: 'device.name',
    defaultValue: 'Device',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['erp_device_name'],
    description: 'اسم الجهاز المحلي'
  },
  'device.last_sync_time': {
    key: 'device.last_sync_time',
    defaultValue: '',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['pf_last_sync_time'],
    description: 'تاريخ و وقت آخر مزامنة للجهاز'
  },
  'system.auth_enabled': {
    key: 'system.auth_enabled',
    defaultValue: true,
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['pharmaflow_auth_enabled', 'authenticationEnabled'],
    description: 'حالة تفعيل المصادقة محلياً'
  },
  'system.auto_lock': {
    key: 'system.auto_lock',
    defaultValue: false,
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['autoLockEnabled'],
    description: 'حالة القفل التلقائي للشاشة'
  },
  'system.lock_on_startup': {
    key: 'system.lock_on_startup',
    defaultValue: false,
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['lockOnStartup'],
    description: 'القفل التلقائي عند بدء التشغيل'
  },
  'system.crash_record': {
    key: 'system.crash_record',
    defaultValue: null,
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['last_critical_error', 'pf_last_render_crash'],
    description: 'سجلات تشخيص الأعطال المحلية'
  },
  'system.page_refresh': {
    key: 'system.page_refresh',
    defaultValue: '',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['page-force-refresh-timestamp', 'page-has-been-force-refreshed'],
    description: 'تتبع إعادة تحميل الصفحة محلياً'
  },
  'system.db_bypass': {
    key: 'system.db_bypass',
    defaultValue: 'false',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: ['PHARMAFLOW_DB_BYPASS'],
    description: 'تجاوز قاعدة البيانات لأغراض التطوير'
  },
  'gdrive.access_token': {
    key: 'gdrive.access_token',
    defaultValue: '',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: [],
    description: 'رمز وصول Google Drive المحلي'
  },
  'gdrive.user_email': {
    key: 'gdrive.user_email',
    defaultValue: '',
    scope: 'DEVICE',
    syncPolicy: 'LOCAL_ONLY',
    legacyKeys: [],
    description: 'بريد Google Drive المحلي'
  }
};

/**
 * Maps legacy keys to their canonical key names.
 */
export const LEGACY_KEY_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const def of Object.values(CONFIG_REGISTRY)) {
    if (def.legacyKeys) {
      for (const legacyKey of def.legacyKeys) {
        map[legacyKey] = def.key;
      }
    }
  }
  return map;
})();

/**
 * Returns canonical key for any input key (canonical or legacy).
 */
export function normalizeConfigKey(key: string): string {
  return LEGACY_KEY_MAP[key] || key;
}
