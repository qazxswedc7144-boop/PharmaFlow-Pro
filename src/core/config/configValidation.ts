// src/core/config/configValidation.ts
import { CONFIG_REGISTRY, normalizeConfigKey } from './configKeys';
import { ConfigScope, ConfigurationContext } from './types';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  sanitizedValue?: any;
}

const MAX_STRING_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;

/**
 * Validates configuration mutations before persistence.
 */
export function validateConfigMutation(
  key: string,
  value: any,
  _scope?: ConfigScope,
  _context?: ConfigurationContext
): ValidationResult {
  const canonicalKey = normalizeConfigKey(key);
  const def = CONFIG_REGISTRY[canonicalKey];

  // 🚨 FIX 1: منع حقن المفاتيح غير المسجلة (Security Strictness)
  if (!def) {
    // نسمح فقط بالمفاتيح المخصصة التي تبدأ بـ custom. (إذا كنت تستخدمها)
    if (canonicalKey.startsWith('custom.')) {
      return sanitizeGenericValue(value);
    }
    return {
      valid: false,
      reason: `Security Violation: Key '${canonicalKey}' is not registered in the configuration registry.`
    };
  }

  // 1. Check read-only / SERVER_AUTHORITATIVE protection
  if (def.readOnly || def.syncPolicy === 'SERVER_AUTHORITATIVE') {
    return {
      valid: false,
      reason: `Configuration key '${canonicalKey}' is server-authoritative or read-only and cannot be modified locally.`
    };
  }

  // 2. Custom validator if defined
  if (def.validator && typeof def.validator === 'function') {
    if (!def.validator(value)) {
      return {
        valid: false,
        reason: `Value for '${canonicalKey}' failed custom validation.`
      };
    }
  }

  // 3. Known type checks
  const defaultType = typeof def.defaultValue;

  if (value === null || value === undefined) {
    return { valid: false, reason: `Value for '${canonicalKey}' cannot be null or undefined.` };
  }

  if (defaultType === 'number') {
    // 🚨 FIX 5: منع النصوص الفارغة من التحول إلى صفر
    if (typeof value === 'string' && value.trim() === '') {
      return { valid: false, reason: `Value for '${canonicalKey}' must not be an empty string.` };
    }
    
    const num = Number(value);
    if (isNaN(num) || !isFinite(num)) {
      return { valid: false, reason: `Value for '${canonicalKey}' must be a valid finite number.` };
    }
    
    // Percent checks
    if (canonicalKey.includes('percent') || canonicalKey.includes('limit')) {
      if (num < 0 || num > 100) {
        return { valid: false, reason: `Percentage value for '${canonicalKey}' must be between 0 and 100.` };
      }
    }
    return { valid: true, sanitizedValue: num };
  }

  if (defaultType === 'boolean') {
    // 🚨 FIX 2: معالجة ثغرة Boolean("false") == true
    let boolVal = false;
    if (typeof value === 'string') {
      const str = value.toLowerCase().trim();
      boolVal = str === 'true' || str === '1' || str === 'yes' || str === 'on';
    } else {
      boolVal = Boolean(value);
    }
    return { valid: true, sanitizedValue: boolVal };
  }

  if (defaultType === 'string') {
    // 🚨 FIX 3: تعقيم النصوص وتحديد الطول الأقصى
    let strVal = String(value).trim();
    
    const maxLen = canonicalKey.includes('name') || canonicalKey.includes('phone') ? MAX_NAME_LENGTH : MAX_STRING_LENGTH;
    if (strVal.length > maxLen) {
      return { valid: false, reason: `Value for '${canonicalKey}' exceeds maximum length of ${maxLen} characters.` };
    }

    // 🚨 FIX 4: قوائم التحقق (Enums) للعملة واللغة
    if (canonicalKey === 'system.currency') {
      const allowedCurrencies = ['YER', 'SAR', 'USD', 'AED', 'EGP'];
      if (!allowedCurrencies.includes(strVal)) {
        return { valid: false, reason: `Currency '${strVal}' is not supported. Allowed: ${allowedCurrencies.join(', ')}` };
      }
    }
    
    if (canonicalKey === 'system.language') {
      const allowedLangs = ['ar', 'en'];
      if (!allowedLangs.includes(strVal)) {
        return { valid: false, reason: `Language '${strVal}' is not supported. Allowed: ar, en` };
      }
    }

    if (canonicalKey === 'user.theme') {
      const allowedThemes = ['light', 'dark', 'system'];
      if (!allowedThemes.includes(strVal)) {
        return { valid: false, reason: `Theme '${strVal}' is not supported.` };
      }
    }

    return { valid: true, sanitizedValue: strVal };
  }

  return { valid: true, sanitizedValue: value };
}

/**
 * Sanitizes generic custom keys (not in registry).
 */
function sanitizeGenericValue(value: any): ValidationResult {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
     return { valid: false, reason: 'Custom setting exceeds maximum string length.' };
  }
  return { valid: true, sanitizedValue: value };
}
