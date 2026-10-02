/**
 * PharmaFlow PRO ERP — Subscription Entitlement Service (Phase 3.2A)
 * 
 * Authoritative source of truth for all license entitlements, trial boundaries, and feature gating.
 * 
 * Strict Security Rules:
 * 1. Client-side localStorage / React State is never authoritative.
 * 2. Unauthorized client calls to setPlan('BUSINESS') are blocked.
 * 3. Exact evaluation thresholds:
 *    - Usage 0–179: Normal Trial (Allowed)
 *    - Usage 180–199: Warning State (Allowed with warning banner/interceptor)
 *    - Usage >= 200: Blockade State (Read-only allowed; Mutations blocked with 402 error)
 * 4. Read-only actions (Views, Reports, Exports, Settings, Account Management) remain accessible.
 */

import { UsageMeterService } from './usageMeterService';
import { getCurrentUserSession } from '@/core/db';
import { configurationService } from '@/services/config/configurationService';
import { useUIStore } from '@/store/useUIStore';

export type SubscriptionPlanCode = 'TRIAL' | 'BASIC' | 'BUSINESS' | 'ENTERPRISE';
export type SubscriptionStatusCode = 'ACTIVE' | 'TRIAL' | 'WARNING' | 'BLOCKED' | 'EXPIRED' | 'CANCELLED';

export interface SubscriptionEntitlement {
  tenantId: string;
  subscriptionStatus: SubscriptionStatusCode;
  plan: SubscriptionPlanCode;
  planName: string;
  trialLimit: number;
  currentUsage: number;
  remaining: number;
  startsAt: string;
  expiresAt: string;
  isTrial: boolean;
  isWarning: boolean;
  isBlocked: boolean;
  allowedBranches: number;
  allowedUsers: number;
  enforcementReason?: string;
  sourceOfTruth: 'AUTHORITATIVE_TRANSACTION_LEDGER';
}

export class SubscriptionBlockadeError extends Error {
  public readonly code = 'PAYMENT_REQUIRED';
  public readonly status = 402;
  public readonly entitlement: SubscriptionEntitlement;

  constructor(message: string, entitlement: SubscriptionEntitlement) {
    super(message);
    this.name = 'SubscriptionBlockadeError';
    this.entitlement = entitlement;
    Object.setPrototypeOf(this, SubscriptionBlockadeError.prototype);
  }
}

export class SubscriptionEntitlementService {
  public static readonly DEFAULT_TRIAL_LIMIT = 200;
  public static readonly WARNING_THRESHOLD = 180;

  /**
   * Retrieves the authoritative, evaluated subscription entitlement for the given tenant.
   * This is calculated directly from ledger transactions and verified license storage.
   */
  static async getAuthoritativeEntitlement(tenantId?: string): Promise<SubscriptionEntitlement> {
    const activeTenant = tenantId || getCurrentUserSession()?.tenantId || 'default-tenant';
    
    // 1. Fetch persistent, tamper-proof usage metrics
    const currentUsage = await UsageMeterService.getAuthoritativeUsageCount(activeTenant);

    // 2. Check for verified paid license record in DB settings
    let verifiedPlan: SubscriptionPlanCode = 'TRIAL';
    let verifiedExpiry = '2027-12-31T23:59:59.000Z';
    let startsAt = '2026-01-01T00:00:00.000Z';
    
    try {
      const settingRecord = await configurationService.get<any>(`tenant_license_${activeTenant}`).catch(() => null);
      if (settingRecord) {
        const val = typeof settingRecord === 'object' && settingRecord.value ? settingRecord.value : settingRecord;
        if (val && ['TRIAL', 'BASIC', 'BUSINESS', 'ENTERPRISE'].includes(val.plan)) {
          verifiedPlan = val.plan;
        }
        if (val && val.expiresAt) verifiedExpiry = val.expiresAt;
        if (val && val.startsAt) startsAt = val.startsAt;
      }
    } catch {
      // Fall back to TRIAL
    }

    // 3. Plan Configuration Limits
    let maxLimit = this.DEFAULT_TRIAL_LIMIT;
    let planName = 'نسخة تجريبية مجانية';
    let allowedBranches = 1;
    let allowedUsers = 1;

    if (verifiedPlan === 'BASIC') {
      maxLimit = 10000;
      planName = 'الخطة الأساسية';
      allowedBranches = 2;
      allowedUsers = 4;
    } else if (verifiedPlan === 'BUSINESS') {
      maxLimit = 50000;
      planName = 'خطة الأعمال المتقدمة';
      allowedBranches = 4;
      allowedUsers = 12;
    } else if (verifiedPlan === 'ENTERPRISE') {
      maxLimit = -1; // Unlimited
      planName = 'خطة المؤسسات الشاملة';
      allowedBranches = 12;
      allowedUsers = 50;
    }

    const isTrial = verifiedPlan === 'TRIAL';
    const effectiveLimit = isTrial ? this.DEFAULT_TRIAL_LIMIT : maxLimit;
    const remaining = effectiveLimit === -1 ? 999999 : Math.max(0, effectiveLimit - currentUsage);

    // Check expiration date
    const nowTime = Date.now();
    const expiryTime = new Date(verifiedExpiry).getTime();
    const isExpired = !isNaN(expiryTime) && nowTime > expiryTime;

    // License blockade evaluation
    let isBlocked = false;
    let isWarning = false;
    let subscriptionStatus: SubscriptionStatusCode = 'TRIAL';
    let enforcementReason: string | undefined;

    if (isExpired) {
      isBlocked = true;
      subscriptionStatus = 'EXPIRED';
      enforcementReason = 'انتهت صلاحية ترخيص الاشتراك السحابي. يرجى تجديد الاشتراك للمتابعة.';
    } else if (isTrial) {
      if (currentUsage >= this.DEFAULT_TRIAL_LIMIT) {
        isBlocked = true;
        subscriptionStatus = 'BLOCKED';
        enforcementReason = `تم استهلاك الحد الأقصى للعمليات التجريبية (${this.DEFAULT_TRIAL_LIMIT} عملية). يرجى الترقية للمتابعة.`;
      } else if (currentUsage >= this.WARNING_THRESHOLD) {
        isWarning = true;
        subscriptionStatus = 'WARNING';
        enforcementReason = `تحذير: شارف مخزون العمليات التجريبية على الانتهاء (${currentUsage}/${this.DEFAULT_TRIAL_LIMIT}).`;
      } else {
        subscriptionStatus = 'TRIAL';
      }
    } else {
      if (effectiveLimit !== -1 && currentUsage >= effectiveLimit) {
        isBlocked = true;
        subscriptionStatus = 'BLOCKED';
        enforcementReason = `تم استهلاك الحد الأقصى لخطة ${planName} (${effectiveLimit} عملية).`;
      } else {
        subscriptionStatus = 'ACTIVE';
      }
    }

    return {
      tenantId: activeTenant,
      subscriptionStatus,
      plan: verifiedPlan,
      planName,
      trialLimit: this.DEFAULT_TRIAL_LIMIT,
      currentUsage,
      remaining,
      startsAt,
      expiresAt: verifiedExpiry,
      isTrial,
      isWarning,
      isBlocked,
      allowedBranches,
      allowedUsers,
      enforcementReason,
      sourceOfTruth: 'AUTHORITATIVE_TRANSACTION_LEDGER'
    };
  }

  /**
   * Asserts that a business mutation is permitted under the current entitlement.
   * Throws a SubscriptionBlockadeError if blocked.
   */
  static async assertOperationAllowed(operationName: string, options?: { isEdit?: boolean; tenantId?: string }): Promise<void> {
    // Existing record edits are allowed unless subscription has expired
    if (options?.isEdit) {
      const ent = await this.getAuthoritativeEntitlement(options?.tenantId);
      if (ent.subscriptionStatus === 'EXPIRED') {
        useUIStore.getState().setTrialBlockedModalOpen(true);
        throw new SubscriptionBlockadeError(ent.enforcementReason || 'الاشتراك منتهي الصلاحية.', ent);
      }
      return;
    }

    const entitlement = await this.getAuthoritativeEntitlement(options?.tenantId);
    if (entitlement.isBlocked) {
      useUIStore.getState().setTrialBlockedModalOpen(true);
      throw new SubscriptionBlockadeError(
        entitlement.enforcementReason || `تم حظر إنشاء عملية جديدة (${operationName}) بسبب بلوغ حد الخطة التجريبية 200 عملية.`,
        entitlement
      );
    }
  }

  /**
   * Checks whether a feature type is permitted in current state (e.g. Read-Only features always true).
   */
  static async isFeatureAllowed(
    feature: 'VIEW_DATA' | 'VIEW_REPORTS' | 'EXPORT_DATA' | 'MANAGE_ACCOUNT' | 'VIEW_INVOICES' | 'CREATE_TRANSACTION' | 'SETTINGS_VIEW',
    tenantId?: string
  ): Promise<boolean> {
    const readOnlyFeatures = ['VIEW_DATA', 'VIEW_REPORTS', 'EXPORT_DATA', 'MANAGE_ACCOUNT', 'VIEW_INVOICES', 'SETTINGS_VIEW'];
    if (readOnlyFeatures.includes(feature)) {
      return true; // Always allowed
    }

    const ent = await this.getAuthoritativeEntitlement(tenantId);
    return !ent.isBlocked;
  }

  /**
   * Single Authoritative Decision Rule:
   * Determines whether the Subscription Onboarding / Welcome modal should be shown upon app launch.
   *
   * Logic:
   * ACTIVE SUBSCRIPTION AND plan != TRIAL AND expiresAt > now -> return false (HIDE)
   * In all other cases (TRIAL, EXPIRED, CANCELLED, BLOCKED, NO ACTIVE SUBSCRIPTION) -> return true (SHOW)
   */
  static shouldShowSubscriptionOnboarding(entitlement: SubscriptionEntitlement | null | undefined): boolean {
    return shouldShowSubscriptionOnboarding(entitlement);
  }

  /**
   * In-memory session tracking for dismissed state during active app execution.
   * Resets automatically when app/tab is reloaded or reopened.
   */
  private static _sessionDismissedMap: Record<string, boolean> = {};

  static hasDismissedInCurrentSession(tenantId?: string): boolean {
    const activeTenant = tenantId || getCurrentUserSession()?.tenantId || 'default-tenant';
    return !!this._sessionDismissedMap[activeTenant];
  }

  static markDismissedForCurrentSession(tenantId?: string): void {
    const activeTenant = tenantId || getCurrentUserSession()?.tenantId || 'default-tenant';
    this._sessionDismissedMap[activeTenant] = true;
  }

  /**
   * Legacy method maintained for backward compatibility; delegates to session memory.
   */
  static hasSeenOnboardingModal(tenantId?: string): boolean {
    return this.hasDismissedInCurrentSession(tenantId);
  }

  /**
   * Legacy method maintained for backward compatibility; delegates to session memory.
   */
  static markOnboardingModalSeen(tenantId?: string): void {
    this.markDismissedForCurrentSession(tenantId);
  }

  /**
   * Securely saves verified server-issued license record into DB
   */
  static async applyVerifiedLicense(license: {
    tenantId: string;
    plan: SubscriptionPlanCode;
    startsAt?: string;
    expiresAt?: string;
  }): Promise<void> {
    await configurationService.set(`tenant_license_${license.tenantId}`, {
      plan: license.plan,
      startsAt: license.startsAt || new Date().toISOString(),
      expiresAt: license.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString()
    });
    UsageMeterService.invalidate(license.tenantId);
  }
}

/**
 * Single Central Decision Rule:
 * Determines whether the Subscription Onboarding / Welcome Modal should be shown.
 *
 * Rules:
 * ACTIVE SUBSCRIPTION AND plan != TRIAL AND expiresAt > now
 *   -> return false (HIDE ONBOARDING)
 * In all other cases (NO ACTIVE SUBSCRIPTION, TRIAL, EXPIRED, CANCELLED, BLOCKED)
 *   -> return true (SHOW ONBOARDING)
 */
export function shouldShowSubscriptionOnboarding(
  entitlement: SubscriptionEntitlement | null | undefined
): boolean {
  if (!entitlement) {
    return true; // No status -> SHOW
  }

  const isPaidPlan = entitlement.plan === 'BASIC' || entitlement.plan === 'BUSINESS' || entitlement.plan === 'ENTERPRISE';
  const isActive = entitlement.subscriptionStatus === 'ACTIVE';

  const nowTime = Date.now();
  const expiryTime = entitlement.expiresAt ? new Date(entitlement.expiresAt).getTime() : 0;
  const isNotExpired = !isNaN(expiryTime) && expiryTime > nowTime;

  if (isActive && isPaidPlan && isNotExpired) {
    return false; // HIDE ONBOARDING
  }

  return true; // SHOW ONBOARDING
}

