// src/types/settings.types.ts

/**
 * Defines the core identity and branding of the pharmacy.
 */
export interface PharmacyProfile {
  name: string;
  phone: string;
  address: string;
  taxNumber: string;
  licenseNumber?: string; // 👈 مضاف
  logo?: string;          // 👈 مضاف (Base64 or URL)
  icon?: string;          // 👈 مضاف (Base64 or URL)
}

/**
 * Core financial settings for POS and invoicing.
 */
export interface FinancialSettings {
  currency: 'YER' | 'SAR' | 'USD' | 'AED' | 'EGP' | string;
  posBoxAccountId?: string; // 👈 توضيح: يجب أن يكون معرف حساب وليس نص عشوائي
  taxPercentage: number;
  maxDiscount: number;
  allowNegativeStock: boolean; // 👈 مضاف (حرج للمخزون)
}

/**
 * System User definition (Matches UsersTab & DB Schema).
 */
export type UserRole = 
  | 'مدير نظام'       // Administrator
  | 'صيدلي مسؤول'    // Pharmacist
  | 'كاشير مبيعات';   // Cashier

export interface User {
  id: string;
  name: string;
  username: string;    // 👈 مضاف (حقل الدخول)
  password?: string;   // 👈 مضاف (يخزن مؤقتاً في الـ UI قبل التشفير)
  role: UserRole;      // 👈 تم التقييد بالقيم العربية
  branch: string;      // 👈 مضاف (عزل الفروع)
  status: 'active' | 'inactive'; // 👈 مضاف (تفعيل/تعطيل الحساب)
  permissions?: Record<string, {
    read: boolean;
    add: boolean;
    edit: boolean;
    delete: boolean;
  }>; // 👈 مصفوفة الصلاحيات
  createdAt?: string;
}

/**
 * UI/UX Preferences.
 */
export interface UISettings {
  theme: 'light' | 'dark' | 'system'; // 👈 بديل عن darkMode
  printSize: '58mm' | '80mm' | 'A4';  // 👈 تمت إضافة 58mm
}
