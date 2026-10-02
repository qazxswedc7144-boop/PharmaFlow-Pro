
import React, { useState, useEffect, useRef, Suspense, useCallback, useTransition } from 'react';
import { User, UserRole } from '@/types/auth.types';
import { lazyWithRetry } from '@/utils/lazyWithRetry';
import Dashboard from '@features/dashboard/pages/Dashboard';
import { Logo, BrandName, Tagline } from '@/components/shared/Logo';
import { useUI } from '@/contexts/AppContext';
import Header from '@/layouts/Header';
import { useUIStore } from '@/store/useUIStore';
import { useSalesStore } from '@/store/useSalesStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { useAdaptivePerformance } from '@/hooks/useAdaptivePerformance';
import { db } from '@/core/db';
import { DistributedSyncEngine } from '@features/sync/sync.engine';
import { heartbeatService } from '@/services/heartbeatService';
import { backupService } from '@/services/backupScheduler';
import { BackupService } from '@/services/backupService';
import { FinancialHealthService } from '@features/accounting/services/FinancialHealthService';
import { CurrencyService } from '@/services/localization/CurrencyService';
import { SafeModePanel } from '@/layouts/SafeModePanel';
import { FinancialDefenseSystem } from '@/services/integrity/FinancialDefenseSystem';
import { RealtimeReplicationService } from '@features/replication/services/RealtimeReplicationService';
import { Permission } from '@/types';
import RoleGuard from '@/components/shared/RoleGuard';
import { IS_PREVIEW } from '@/constants';
import { 
  X, AlertTriangle, RefreshCw, LogOut, ShieldCheck, Building2,
  Users, BarChart2, ArrowRightLeft,
  Landmark, Sliders, Settings
} from 'lucide-react';

import {
  SubscriptionOnboardingModal,
  SubscriptionWarningInterceptor,
  SubscriptionBlockadeBackdrop,
  TrialBlockedModal
} from '@features/saas/components/SubscriptionWidgets';
import { SubscriptionStatusProvider } from '@/services/saas/subscriptionStatusProvider';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { configurationService } from '@/services/config/configurationService';
import { 
  SubscriptionEntitlementService,
  shouldShowSubscriptionOnboarding 
} from '@/services/saas/subscriptionEntitlementService';
import { CopilotWidget } from '@features/ai/copilot';

// Error Boundary Component
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("CRITICAL RUNTIME ERROR:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F8FAFA] flex items-center justify-center p-6 text-right" dir="rtl">
          <div className="bg-white p-8 rounded-[32px] shadow-2xl border border-red-50 max-w-md w-full text-center">
            <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6 text-red-500">
              <AlertTriangle size={40} />
            </div>
            <h1 className="text-2xl font-black text-[#1E4D4D] mb-4">عذراً، حدث خطأ غير متوقع</h1>
            <p className="text-slate-500 text-sm mb-8 leading-relaxed">
              واجه النظام مشكلة تقنية مفاجئة. تم تأمين بياناتك محلياً. يرجى محاولة إعادة تشغيل التطبيق.
            </p>
            <div className="space-y-3">
              <button 
                onClick={() => window.location.reload()}
                className="w-full bg-[#1E4D4D] text-white py-4 rounded-2xl font-black text-sm flex items-center justify-center gap-2 hover:bg-[#153a3a] transition-all"
              >
                <RefreshCw size={18} />
                <span>إعادة تشغيل النظام</span>
              </button>
              <button 
                onClick={() => {
                  window.location.hash = '#/dashboard';
                  window.location.reload();
                }}
                className="w-full bg-white border border-slate-100 text-slate-500 py-4 rounded-2xl font-black text-xs hover:bg-slate-50 transition-all"
              >
                العودة للرئيسية
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Lazy loading views
const PurchasesView = lazyWithRetry(() => import('@features/purchases/pages/PurchasesInvoice'));
const SalesModule = lazyWithRetry(() => import('@features/sales/pages/SalesModule'));
const InventoryModule = lazyWithRetry(() => import('@features/inventory/pages/InventoryModule'));
const InventoryAuditModule = lazyWithRetry(() => import('@features/inventory/pages/InventoryAuditModule'));
const AuditHistoryModule = lazyWithRetry(() => import('@features/settings/pages/AuditHistoryModule')); 
const SettingsModule = lazyWithRetry(() => import('@features/settings/pages/SettingsModule'));
const AccountingModule = lazyWithRetry(() => import('@features/accounting/pages/AccountingModule'));
const ReconciliationModule = lazyWithRetry(() => import('@features/accounting/pages/ReconciliationModule'));
const SystemHealthModule = lazyWithRetry(() => import('@features/settings/pages/SystemHealthModule'));
const InvoicesArchiveModule = lazyWithRetry(() => import('@features/sales/pages/InvoicesArchiveModule'));
const InvoiceHistoryModule = lazyWithRetry(() => import('@features/sales/pages/InvoiceHistoryModule'));
const AdjustmentsArchiveModule = lazyWithRetry(() => import('@features/inventory/pages/AdjustmentsArchiveModule'));
const SupplierPaymentModule = lazyWithRetry(() => import('@features/accounting/pages/SupplierPaymentModule'));
const CustomerReceiptModule = lazyWithRetry(() => import('@features/accounting/pages/CustomerReceiptModule'));
const VouchersModule = lazyWithRetry(() => import('@features/accounting/pages/VouchersModule'));
const AgingReportModule = lazyWithRetry(() => import('@features/reports/pages/AgingReportModule'));
const FinancialDashboard = lazyWithRetry(() => import('@features/dashboard/pages/FinancialDashboard'));
const ReportsModule = lazyWithRetry(() => import('@features/reports/pages/ReportsModule'));
const AdvancedReportsModule = lazyWithRetry(() => import('@features/reports/pages/AdvancedReportsModule'));
const PartnersModule = lazyWithRetry(() => import('@features/partners/pages/PartnersModule'));
const SaaSModule = lazyWithRetry(() => import('@features/saas/pages/SaaSModule'));

// Multi-branch module views
const BranchesList = lazyWithRetry(() => import('@features/branches/pages/BranchesList').then(m => ({ default: m.BranchesList })));
const BranchTransfers = lazyWithRetry(() => import('@features/branches/pages/BranchTransfers').then(m => ({ default: m.BranchTransfers })));
const BranchReports = lazyWithRetry(() => import('@features/branches/pages/BranchReports').then(m => ({ default: m.BranchReports })));
const ConsolidationDashboard = lazyWithRetry(() => import('@features/consolidation/pages/ConsolidationDashboard'));

// Lazy loading individual reports
const RemainingStockReport = lazyWithRetry(() => import('@features/reports/pages/RemainingStockReport'));
const ItemProfitsReport = lazyWithRetry(() => import('@features/reports/pages/ItemProfitsReport'));
const CustomerProfitReport = lazyWithRetry(() => import('@features/reports/pages/CustomerProfitReport'));
const SupplierProfitReport = lazyWithRetry(() => import('@features/reports/pages/SupplierProfitReport'));
const AccountMovementReport = lazyWithRetry(() => import('@features/reports/pages/AccountMovementReport'));
const PurchasesByItemReport = lazyWithRetry(() => import('@features/reports/pages/PurchasesByItemReport'));
const SalesByItemReport = lazyWithRetry(() => import('@features/reports/pages/SalesByItemReport'));
const ItemMovementDetailsReport = lazyWithRetry(() => import('@features/reports/pages/ItemMovementDetailsReport'));
const ExpiryItemsReport = lazyWithRetry(() => import('@features/reports/pages/ExpiryItemsReport'));
const FinancialEngineReport = lazyWithRetry(() => import('@features/reports/pages/FinancialEngineReport'));
const PrivacyPolicy = lazyWithRetry(() => import('@features/legal/pages/PrivacyPolicy'));
const TermsOfService = lazyWithRetry(() => import('@features/legal/pages/TermsOfService'));
const SecurityAuditDashboard = lazyWithRetry(() => import('@features/settings/components/SecurityAuditDashboard'));
const BackupManagement = lazyWithRetry(() => import('@features/settings/components/BackupManagement'));

import { useAuth } from '@features/auth/hooks/useAuth';
import LoginPage from '@features/auth/pages/LoginPage';
import ProtectedRoute from '@/components/shared/ProtectedRoute';
import { can } from '@/utils/permissions';
import { MODULES } from '@/constants/navigation';
import { LockScreen } from '@/layouts/LockScreen';
import { useAutoBackup } from '@/hooks/useAutoBackup';

import { appLockService } from '@/services/AppLockService';
import { AccountingEngine } from '@features/accounting/services/AccountingEngine';
import { PeriodLockEngine } from '@/services/transactions/PeriodLockEngine';
import { IntegritySweepService } from '@/services/integrity/IntegritySweepService';

function MainLayout() {
  useAutoBackup();
  const { animationsEnabled, bgSyncInterval } = useAdaptivePerformance();
  const { profile, user, accessToken, loading, signOut } = useAuth(); 
  const [currentView, setCurrentView] = useState<string>('dashboard');

  useEffect(() => {
    window.onerror = (message, source, lineno, colno, error) => {
      const safeMsg = typeof message === "string" ? message : "Window error event";
      const safeErr = error instanceof Error ? error.message : (typeof error === "string" ? error : (error ? String(error) : "N/A"));
      console.error("Global Error (onerror):", { message: safeMsg, source: source || 'unknown', lineno: lineno || 0, colno: colno || 0, error: safeErr });
      return false;
    };

    window.addEventListener("unhandledrejection", (e) => {
      e.preventDefault();
      const reason = e.reason;
      const details = reason instanceof Error ? {
        message: reason.message,
        stack: reason.stack
      } : { reason: String(reason) };
      console.warn("Cleared dynamic rejection:", details);
    });
  }, []);
  const [viewParams, setViewParams] = useState<any>(null); 
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const mainContentRef = useRef<HTMLElement>(null);
  const [, startTransition] = useTransition();
  const { setHeaderAction, refreshGlobal, setSettingsOpen } = useUI();
  const { setEditingInvoiceId } = useSalesStore();
  const { isTrialBlockedModalOpen, setTrialBlockedModalOpen, systemStatus, setSystemStatus, addToast } = useUIStore();
  const { setCurrency } = useSettingsStore();
  const [riskScore, setRiskScore] = useState<number>(0);
  const [isLocked, setIsLocked] = useState(false);
  const [isReady, setIsReady] = useState(false);

  // Reset scroll on view change
  useEffect(() => {
    if (mainContentRef.current) {
      mainContentRef.current.scrollTop = 0;
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [currentView]);

  // SaaS Onboarding Lifecycle hooks — Evaluated strictly via authoritative subscription status
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const evaluateOnboardingStatus = async () => {
      try {
        const ent = await SubscriptionEntitlementService.getAuthoritativeEntitlement();
        if (!isMounted) return;

        const shouldShow = shouldShowSubscriptionOnboarding(ent);
        const hasDismissedInSession = SubscriptionEntitlementService.hasDismissedInCurrentSession();

        if (shouldShow && !hasDismissedInSession) {
          setOnboardingOpen(true);
        } else {
          setOnboardingOpen(false);
        }
      } catch (e) {
        console.warn('[App] Error evaluating onboarding status:', e);
        if (!SubscriptionEntitlementService.hasDismissedInCurrentSession()) {
          setOnboardingOpen(true);
        }
      }
    };

    evaluateOnboardingStatus();

    const handleSubscriptionUpdate = () => {
      evaluateOnboardingStatus();
    };

    window.addEventListener('saas-usage-updated', handleSubscriptionUpdate);
    window.addEventListener('storage', handleSubscriptionUpdate);

    return () => {
      isMounted = false;
      window.removeEventListener('saas-usage-updated', handleSubscriptionUpdate);
      window.removeEventListener('storage', handleSubscriptionUpdate);
    };
  }, []);

  const handleCloseOnboarding = useCallback(() => {
    // Dismiss for the active in-memory session only; does NOT permanently prevent showing on next app boot
    SubscriptionEntitlementService.markDismissedForCurrentSession();
    setOnboardingOpen(false);
  }, []);

  const handleUpgradeTrial = () => {
    handleNav('settings', { tab: 'subscription' });
  };

  // Task 4: Optimized and re-engineered ultra-fast main startup boot sequence
  useEffect(() => {
    const startBootTime = performance.now();
    let isComponentMounted = true;

    // Safety Gate: Ensure ready state becomes true after 1200ms max under all network/storage conditions
    const safetyTimer = setTimeout(() => {
      if (isComponentMounted) {
        console.warn("⚡ [BOOT_SEQUENCE] Safety timer triggered (1200ms). Forcing system readiness.");
        setIsReady(true);
      }
    }, 1200);

    const bootFlow = async () => {
      try {
        // Ensure local IndexedDB is initialized with 800ms max timeout
        if (!db.isOpen()) {
          await Promise.race([
            db.open(),
            new Promise((res) => setTimeout(res, 800))
          ]);
        }
        
        // 1. Query configurationService to resolve the status of authenticationEnabled with timeout
        const item = await Promise.race([
          configurationService.get<boolean>('authenticationEnabled').catch(() => null),
          new Promise<null>((res) => setTimeout(() => res(null), 500))
        ]);
        const authEnabled = item === true || (typeof item === 'object' && (item as any)?.value === true);
        
        // Align auth enabled flag in configurationService so components can pull it synchronously
        configurationService.set('pharmaflow_auth_enabled', authEnabled ? 'true' : 'false').catch(() => {});
        
        if (!authEnabled) {
          // 2. IF FALSE: Bypass all network checks, initialize local administrator mocks, and resolve <MainApplication />
          const BYPASS_USER: User = {
            id: "local-admin",
            user_id: "local-admin",
            Role: "Admin" as UserRole,
            User_Name: "Administrator",
            User_Email: "admin@admin.com",
            tenant_id: "local-tenant-01",
            Is_Active: true
          };
          
          TokenProvider.setSession(BYPASS_USER, 'local-admin-token', 'local-admin-refresh-token');
          
          const currentHash = window.location.hash;
          if (currentHash === '#/login' || !currentHash) {
            window.location.hash = '#/dashboard';
          }
        } else {
          // 3. IF TRUE: Evaluate the validity of the current JWT session storage / TokenProvider state
          const token = TokenProvider.getAccessToken();
          const session = TokenProvider.getCurrentSession();
          
          let isTokenValid = false;
          if (token && session.user && token !== 'local-admin-token') {
            try {
              const parts = token.split('.');
              if (parts.length === 3) {
                const tokenPart = parts[1];
                if (tokenPart) {
                  const payload = JSON.parse(atob(tokenPart));
                  const exp = payload.exp * 1000;
                  if (Date.now() < exp) {
                    isTokenValid = true;
                  }
                }
              }
            } catch (e) {
              console.warn("[BOOT_SEQUENCE] Failed parsing token, considering expired/invalid:", e);
            }
          }
          
          if (isTokenValid) {
            // Valid session: open dashboard
            const currentHash = window.location.hash;
            if (currentHash === '#/login' || !currentHash) {
              window.location.hash = '#/dashboard';
            }
          } else if (session.refreshToken && typeof navigator !== 'undefined' && navigator.onLine) {
            // Attempt single-flight session restoration via refresh token with 800ms timeout
            try {
              await Promise.race([
                TokenProvider.refreshAccessToken(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("Refresh timeout")), 800))
              ]);
              const currentHash = window.location.hash;
              if (currentHash === '#/login' || !currentHash) {
                window.location.hash = '#/dashboard';
              }
            } catch {
              TokenProvider.clearSession();
              window.location.hash = '#/login';
            }
          } else {
            // Invalid or expired: push to LoginScreen
            TokenProvider.clearSession();
            window.location.hash = '#/login';
          }
        }
      } catch (err) {
        console.error("⚡ [BOOT_SEQUENCE] Snappy verification pipeline failed, falling back safely:", err);
      } finally {
        clearTimeout(safetyTimer);
        const bootDuration = performance.now() - startBootTime;
        console.log(`⚡ [BOOT_SEQUENCE] Snappy startup boot completed in ${bootDuration.toFixed(1)}ms.`);
        if (isComponentMounted) {
          setIsReady(true);
        }
      }
    };
    
    bootFlow();

    return () => {
      isComponentMounted = false;
      clearTimeout(safetyTimer);
    };
  }, []);


  // 1. Session Tracking
  useEffect(() => {
    const handleActivity = () => {
      appLockService.updateActivity();
    };

    window.addEventListener('click', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('touchstart', handleActivity);

    return () => {
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
    };
  }, []);

    // 2. Lock Logic (Interval & Visibility)
    useEffect(() => {
      const checkLock = async () => {
        try {
          // Check autoLockEnabled from configurationService
          const alItem = await configurationService.get<boolean>('autoLockEnabled').catch(() => null);
          const isAutoLockEnabled = alItem === true || (typeof alItem === 'object' && (alItem as any)?.value === true);

          if (isAutoLockEnabled) {
            const settings = await appLockService.getSettings();
            if (settings?.is_enabled && settings.lock_mode !== 'instant') {
              const shouldLock = await appLockService.shouldLock();
              if (shouldLock) setIsLocked(true);
            }
          }
        } catch (e) {
          console.error("[LockCheck] Failed to check status:", e);
        }
      };
  
      const handleVisibilityChange = async () => {
        try {
          const settings = await appLockService.getSettings();
          
          if (document.visibilityState === 'hidden') {
            if (settings?.is_enabled && settings.lock_mode === 'instant') {
              setIsLocked(true);
            }
          } else if (document.visibilityState === 'visible') {
            if (settings?.is_enabled) {
              if (settings.lock_mode === 'instant') {
                setIsLocked(true);
              } else {
                const alItem = await configurationService.get<boolean>('autoLockEnabled').catch(() => null);
                const isAutoLockEnabled = alItem === true || (typeof alItem === 'object' && (alItem as any)?.value === true);
                if (isAutoLockEnabled) {
                  const shouldLock = await appLockService.shouldLock();
                  if (shouldLock) setIsLocked(true);
                }
              }
            }
          }
        } catch (e) {
          console.error("[VisibilityChange] Lock evaluation failed:", e);
        }
      };
  
      const interval = setInterval(() => {
        checkLock().catch(e => console.error("[LockInterval] Failed:", e));
      }, 30000); // 30s as requested
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('focus', () => {
        checkLock().catch(e => console.error("[FocusLock] Failed:", e));
      });
      window.addEventListener('blur', async () => {
          try {
            const settings = await appLockService.getSettings();
            if (settings?.is_enabled && settings.lock_mode === 'instant') {
              setIsLocked(true);
            }
          } catch (e) {
            console.error("[BlurLock] Failed:", e);
          }
      });
  
      // Initial check on mount (App Resume)
      const initialCheck = async () => {
        try {
          // Check lockOnStartup from configurationService
          const losItem = await configurationService.get<boolean>('lockOnStartup').catch(() => null);
          const isLockOnStartupEnabled = losItem === true || (typeof losItem === 'object' && (losItem as any)?.value === true);

          if (isLockOnStartupEnabled) {
            setIsLocked(true);
            return;
          }

          const isLockEnabled = await appLockService.isSimpleLockEnabled();
          
          if (isLockEnabled) {
            // If simple quick lock is enabled, we lock the screen initially just for security.
            setIsLocked(true);
            return;
          }

          const settings = await appLockService.getSettings();
          if (settings?.is_enabled) {
            const alItem = await configurationService.get<boolean>('autoLockEnabled').catch(() => null);
            const isAutoLockEnabled = alItem === true || (typeof alItem === 'object' && (alItem as any)?.value === true);
            if (isAutoLockEnabled) {
              const shouldLock = await appLockService.shouldLock();
              if (shouldLock) setIsLocked(true);
            }
          }
        } catch (e) {
          console.error("[InitialLockCheck] Failed:", e);
        }
      };
      initialCheck().catch(e => console.error("[InitialLockCheck] Uncaught:", e));
  
      return () => {
        clearInterval(interval);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('focus', checkLock);
      };
    }, []);

  useEffect(() => {
    console.log("PAGE MOUNTED")
    return () => console.log("PAGE UNMOUNTED")
  }, [])

  const parseRoute = useCallback(() => {
    if (loading) return; // Wait for authentication loading to complete

    const hash = window.location.hash.replace('#/', '');
    let view = hash || 'dashboard'; 
    let id: string | undefined = undefined;

    // Check if the current hash contains an ID (e.g., invoices/123)
    if (hash.includes('/') && !hash.startsWith('reports/')) {
        const parts = hash.split('/');
        view = parts[0] || 'dashboard';
        id = parts[1];
    }

    // List of valid views (based on the lazy loaded components)
    const validViews = [
      'dashboard', 'purchases', 'sales', 'inventory', 'inventory-audit',
      'suppliers', 'logs', 'audit-history', 'settings', 'accounting',
      'reconciliation', 'system-health', 'invoices-archive', 'invoice-history',
      'adjustments-archive', 'supplier-payment', 'customer-receipt', 'vouchers',
      'aging-report', 'partners', 'privacy', 'terms', 'reports', 'advanced-reports',
      'login', '403', 'backup', 'saas-portal', 'security-audit',
      'branches', 'branch-transfers', 'branch-reports', 'consolidation',
      'reports/remaining-stock', 'reports/item-profits', 'reports/customer-profit', 
      'reports/supplier-profit', 'reports/account-movement', 'reports/purchases-by-item',
      'reports/sales-by-item', 'reports/item-movement-details', 'reports/expiry-items',
      'reports/financial-engine'
    ];

    // Map views to required permissions
    const getViewPermission = (v: string): Permission | undefined => {
      if (v === 'sales') return 'POS_ACCESS';
      if (v === 'purchases') return 'PURCHASE_ACCESS';
      if (v === 'accounting' || v === 'reconciliation' || v === 'adjustments-registry' || v === 'consolidation') return 'FINANCIAL_ACCESS';
      if (v === 'reports' || v === 'financial-dashboard' || v === 'advanced-reports' || v.startsWith('reports/')) return 'VIEW_REPORTS';
      if (v === 'settings' || v === 'backup' || v === 'system-health' || v === 'audit-history' || v === 'invoice-history') return 'MANAGE_SYSTEM';
      if (v === 'partners') return 'MANAGE_PARTNERS';
      if (v === 'branches') return 'BRANCH_VIEW';
      if (v === 'branch-transfers') return 'BRANCH_TRANSFER';
      if (v === 'branch-reports') return 'BRANCH_REPORT';
      return undefined;
    };

    const isBypassView = ['privacy', 'terms'].includes(view);

    if (!isBypassView && view !== 'login' && view !== '403') {
      const authed = !!(user && accessToken && user.Is_Active !== false);
      if (!authed) {
        window.location.hash = '#/login';
        view = 'login';
      } else {
        const requiredPermission = getViewPermission(view);
        if (requiredPermission && !can(profile?.role, requiredPermission)) {
          window.location.hash = '#/403';
          view = '403';
        }
      }
    }

    if (view === 'settings') {
      const authed = !!(user && accessToken && user.Is_Active !== false);
      if (!authed) {
        window.location.hash = '#/login';
        view = 'login';
      } else if (!can(profile?.role, 'MANAGE_SYSTEM')) {
        window.location.hash = '#/403';
        view = '403';
      } else {
        setSettingsOpen(false);
      }
    }

    if (!validViews.includes(view)) {
      view = 'dashboard';
      window.location.hash = '#/dashboard';
    }

    startTransition(() => {
      setCurrentView(view);
      if (id) {
        setEditingInvoiceId(id);
        setViewParams({ id });
      } else {
        setEditingInvoiceId(null);
        setViewParams(null);
      }
    });
  }, [setEditingInvoiceId, user, accessToken, profile, loading]);

  useEffect(() => {
    if (!loading) {
      parseRoute();
    }
  }, [loading, user, accessToken, parseRoute]);

  useEffect(() => {
    let stopCurrencyObserver: (() => void) | null = null;
    let syncEngine: DistributedSyncEngine | null = null;

    const init = async () => { 
      // Clear DB to resolve IDBKeyRange error if requested (one-time fix)
      if (!configurationService.getSync('pharmaflow_db_reset_v4')) {
        try {
          console.log("🧹 Clearing IndexedDB to resolve IDBKeyRange error...");
          const databases = await window.indexedDB.databases();
          for (const dbInfo of databases) {
            if (dbInfo.name) {
              console.log(`Deleting: ${dbInfo.name}`);
              window.indexedDB.deleteDatabase(dbInfo.name);
            }
          }
        } catch (e) {
          window.indexedDB.deleteDatabase("pharmaflow");
        }
        configurationService.set('pharmaflow_db_reset_v4', 'true').catch(() => {});
      }

      try {
        await db.open();
        // Dynamic Sync engine activation
        syncEngine = DistributedSyncEngine.getInstance(db);
        syncEngine.start();
      } catch (e) {
        console.error("Failed to open DB:", e);
      }

      await AccountingEngine.seedAccounts().catch(e => console.error(e));
      await PeriodLockEngine.seedDefaultPeriod().catch(e => console.error(e));

      heartbeatService.start(); 
      
      // Reset security system for development as requested
      await FinancialDefenseSystem.resetSecuritySystem().catch(e => console.error(e));
      
      FinancialDefenseSystem.startBackgroundScanner();
      
      stopCurrencyObserver = CurrencyService.startCurrencyObserver((code) => {
        setCurrency(code);
      });

      await FinancialHealthService.refreshHealthMonitor().catch(e => console.error(e));

      let health = await BackupService.runIntegrityChecks().catch(e => ({ success: false, errors: [e.message] }));
      const savedStatus = await db.getSetting('SYSTEM_STATUS', 'ACTIVE');
      
      if (!health.success || savedStatus === 'RECOVERY_MODE') {
        if (IS_PREVIEW) {
          const fixed = await IntegritySweepService.runSweep(true).catch(() => false);
          if (fixed) {
            setSystemStatus('ACTIVE');
            refreshGlobal();
            return;
          }
          setSystemStatus('ACTIVE');
          return;
        }
        if (!health.success && savedStatus !== 'RECOVERY_MODE') {
          await BackupService.createEmergencySnapshot().catch(() => {});
        }
        setSystemStatus('RECOVERY_MODE');
        addToast("وضع الأمان مفعل", "error");
      } else {
        setSystemStatus('ACTIVE');
      }

      refreshGlobal(); 
      parseRoute();

      // Initialize real-time replication stream
      RealtimeReplicationService.connect("BRH-MAIN-001");
      
      // Start unified backup scheduler
      backupService.start();
    };
    init().catch(err => {
      console.error("CRITICAL: Application failed to initialize:", err);
    });
    window.addEventListener('hashchange', parseRoute);
    return () => {
      heartbeatService.stop();
      backupService.stopAutoTimer();
      if (syncEngine) {
        try {
          syncEngine.stop();
        } catch (scErr) {
          console.warn("Soft-catch syncEngine stop error:", scErr);
        }
      }
      if (stopCurrencyObserver) stopCurrencyObserver();
      window.removeEventListener('hashchange', parseRoute);
      RealtimeReplicationService.disconnect();
    };
  }, [refreshGlobal, parseRoute, setCurrency, setSystemStatus, addToast]);

  // Separate, lightweight adaptive threat monitor interval to prevent mobile CPU overload
  useEffect(() => {
    const fetchThreatLevel = async () => {
      try {
        const threat = await db.getSetting('SYSTEM_THREAT_LEVEL', '0');
        setRiskScore(parseInt(threat));
      } catch (e) {
        console.error("[SyncTimer] Risk score update failed:", e);
      }
    };

    fetchThreatLevel();
    const interval = setInterval(() => {
      fetchThreatLevel();
    }, bgSyncInterval);

    return () => clearInterval(interval);
  }, [bgSyncInterval]);

  const handleNav = useCallback((view: string, params: any = null, options?: { replace?: boolean }) => {
    if ((view === 'sales' || view === 'purchases') && !params?.id) {
       setEditingInvoiceId(null);
    }
    startTransition(() => { 
      setCurrentView(view); 
      setViewParams(params);
      const url = params?.id ? `#/${view}/${params.id}` : `#/${view}`;
      if (options?.replace) {
        window.history.replaceState(null, '', url);
      } else {
        window.location.hash = url;
      }
      if (mainContentRef.current) {
        mainContentRef.current.scrollTop = 0;
      }
    });
    setIsSidebarOpen(false);
    setHeaderAction(null);
    setSettingsOpen(false);
  }, [setHeaderAction, setEditingInvoiceId, setSettingsOpen]);

  const getLabel = () => {
    const m = MODULES.find(mod => mod.id === currentView);
    if (m) return m.label;
    if (currentView === 'sales') return 'كاشير المبيعات';
    if (currentView === 'purchases') return 'توريد مشتريات';
    if (currentView === 'partners') return 'الموردون والعملاء';
    if (currentView === 'inventory') return 'المخازن والأصناف';
    if (currentView === 'supplier-payment') return 'سداد موردين';
    if (currentView === 'customer-receipt') return 'سند قبض عميل';
    if (currentView === 'aging-report') return 'تقرير تعمير الذمم';
    if (currentView === 'accounting') return 'دفتر الأستاذ العام';
    if (currentView === 'consolidation') return 'الاندماج المالي الموحد';
    if (currentView === 'branches') return 'إدارة الفروع والصيدليات';
    if (currentView === 'branch-transfers') return 'التحويل الدوائي البيني';
    if (currentView === 'branch-reports') return 'تقرير تحليلات الفروع الذكي';
    if (currentView === 'settings') return 'مركز الإدارة والإعدادات';
    return 'العملية';
  };

  if (!isReady) {
    return <div className="min-h-screen bg-[#F8FAFA] flex items-center justify-center font-black text-[#1E4D4D] animate-pulse">جاري التحميل...</div>;
  }

  // Bypass Auth Wall if accessing legal pages
  if (currentView === 'privacy') {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#F8FAFA] flex items-center justify-center font-black text-[#1E4D4D] animate-pulse">جاري التحميل...</div>}>
         <PrivacyPolicy />
      </Suspense>
    );
  }
  if (currentView === 'terms') {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#F8FAFA] flex items-center justify-center font-black text-[#1E4D4D] animate-pulse">جاري التحميل...</div>}>
         <TermsOfService />
      </Suspense>
    );
  }

  // Enforce secure authentications and reject unauthorized routing
  if (!user || !accessToken || user.Is_Active === false) {
    return <LoginPage onSuccess={() => handleNav('dashboard')} />;
  }

  return (
    <MotionConfig reducedMotion={animationsEnabled ? "never" : "always"}>
      <div className="flex h-dvh min-h-dvh max-h-dvh h-[100dvh] min-h-[100dvh] max-h-[100dvh] w-full mx-auto bg-[#F8FAFA] overflow-hidden font-sans relative text-slate-800 shadow-sm" dir="rtl">
      {/* SaaS Trial & Onboarding Gateways */}
      <SubscriptionOnboardingModal isOpen={onboardingOpen} onClose={handleCloseOnboarding} />
      <SubscriptionWarningInterceptor />
      <SubscriptionBlockadeBackdrop onUpgrade={handleUpgradeTrial} />
      {isTrialBlockedModalOpen && (
        <TrialBlockedModal onClose={() => setTrialBlockedModalOpen(false)} />
      )}

      <AnimatePresence>
        {isLocked && <LockScreen onUnlock={() => setIsLocked(false)} />}
      </AnimatePresence>
      
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm z-[200] lg:hidden" 
            onClick={() => setIsSidebarOpen(false)} 
          />
        )}
      </AnimatePresence>

      <aside className={`absolute inset-y-0 right-0 w-64 bg-white border-l border-slate-100 z-[210] transition-all duration-500 lg:translate-x-0 lg:static ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : 'translate-x-full'}`}>
        <div className="flex flex-col h-full">
          <div className="px-6 py-8 flex flex-col gap-4">
            <div className="flex justify-between items-center w-full">
              <div className="flex items-center gap-3">
                <Logo size={40} />
                <BrandName className="text-xl" />
              </div>
              <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden w-10 h-10 flex items-center justify-center bg-slate-50 rounded-xl text-slate-400 hover:bg-slate-100 transition-all"><X size={20} /></button>
            </div>
            <Tagline className="px-1 text-[8px]" />
          </div>

          <nav className="flex-1 px-4 py-4 space-y-6 overflow-y-auto custom-scrollbar">
            {/* 1. قسم إدارة العملاء والشركاء */}
            <div>
              <p className="px-4 text-[11px] font-black text-slate-400 uppercase tracking-[2px] mb-3">
                قسم إدارة العملاء والشركاء
              </p>
              <div className="space-y-1">
                {can(profile?.role, 'MANAGE_PARTNERS') && (
                  <button 
                    onClick={() => handleNav('partners')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'partners' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-900/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'partners' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><Users size={15} /></span>
                      <span>العملاء والموردون والشركاء</span>
                    </div>
                    {currentView === 'partners' && <motion.div layoutId="active-nav-part" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>
                )}
              </div>
            </div>

            {/* 2. قسم إدارة الفروع والإمداد */}
            <div>
              <p className="px-4 text-[11px] font-black text-slate-400 uppercase tracking-[2px] mb-3">
                قسم إدارة الفروع والإمداد
              </p>
              <div className="space-y-1">
                {can(profile?.role, 'BRANCH_VIEW') && (
                  <button 
                    onClick={() => handleNav('branches')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'branches' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-950/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'branches' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><Building2 size={15} /></span>
                      <span>إدارة الفروع والصيدليات</span>
                    </div>
                    {currentView === 'branches' && <motion.div layoutId="active-nav-branches" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>
                )}
              </div>
            </div>

            {/* 3. قسم والتكامل المالي الموحد */}
            {can(profile?.role, 'FINANCIAL_ACCESS') && (
              <div>
                <p className="px-4 text-[11px] font-black text-slate-400 uppercase tracking-[2px] mb-3">
                  قسم والتكامل المالي الموحد
                </p>
                <div className="space-y-1">
                  {/* 1. المركز المالي الموحد */}
                  <button 
                    onClick={() => handleNav('consolidation')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'consolidation' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-950/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'consolidation' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><Landmark size={15} /></span>
                      <span>المركز المالي الموحد</span>
                    </div>
                    {currentView === 'consolidation' && <motion.div layoutId="active-nav-fi1" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>

                  {/* 2. التسويات */}
                  <button 
                    onClick={() => handleNav('reconciliation')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'reconciliation' || currentView === 'adjustments-registry' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-950/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'reconciliation' || currentView === 'adjustments-registry' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><Sliders size={15} /></span>
                      <span>التسويات</span>
                    </div>
                    {(currentView === 'reconciliation' || currentView === 'adjustments-registry') && <motion.div layoutId="active-nav-fi3" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>
                </div>
              </div>
            )}

            {/* 4. قسم تحليلات الفروع الذكية */}
            {can(profile?.role, 'BRANCH_REPORT') && (
              <div>
                <p className="px-4 text-[11px] font-black text-slate-400 uppercase tracking-[2px] mb-3">
                  قسم تحليلات الفروع الذكية
                </p>
                <div className="space-y-1">
                  <button 
                    onClick={() => handleNav('branch-reports')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'branch-reports' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-950/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'branch-reports' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><BarChart2 size={15} /></span>
                      <span>تقارير وتحليلات الفروع</span>
                    </div>
                    {currentView === 'branch-reports' && <motion.div layoutId="active-nav-ba" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>
                </div>
              </div>
            )}

            {/* 5. قسم التحويل الدوائي بين الفروع */}
            {can(profile?.role, 'BRANCH_TRANSFER') && (
              <div>
                <p className="px-4 text-[11px] font-black text-slate-400 uppercase tracking-[2px] mb-3">
                  قسم التحويل الدوائي بين الفروع
                </p>
                <div className="space-y-1">
                  <button 
                    onClick={() => handleNav('branch-transfers')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'branch-transfers' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-950/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'branch-transfers' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><ArrowRightLeft size={15} /></span>
                      <span>التحويلات بين الفروع</span>
                    </div>
                    {currentView === 'branch-transfers' && <motion.div layoutId="active-nav-tr" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>
                </div>
              </div>
            )}

            {/* 6. قسم إعدادات المنظومة */}
            {can(profile?.role, 'MANAGE_SYSTEM') && (
              <div>
                <p className="px-4 text-[11px] font-black text-slate-400 uppercase tracking-[2px] mb-3">
                  إعدادات المنظومة
                </p>
                <div className="space-y-1">
                  <button 
                    onClick={() => handleNav('settings')}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-[11px] font-black transition-all group ${currentView === 'settings' ? 'bg-[#1E4D4D] text-white shadow-lg shadow-emerald-900/10' : 'text-slate-500 hover:bg-slate-50 hover:text-[#1E4D4D]'}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`${currentView === 'settings' ? 'text-emerald-400' : 'text-slate-400 group-hover:text-[#1E4D4D]'}`}><Settings size={15} /></span>
                      <span>الإعدادات</span>
                    </div>
                    {currentView === 'settings' && <motion.div layoutId="active-nav-settings" className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
                  </button>
                </div>
              </div>
            )}
          </nav>

          <div className="p-4 border-t border-slate-50">
            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-[#1E4D4D] truncate">{profile?.email?.split('@')[0] || 'User'}</p>
              </div>
              <button onClick={() => signOut()} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-red-500 transition-colors">
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 relative h-full overflow-hidden">
        {systemStatus === 'RECOVERY_MODE' && <SafeModePanel />}
        
        {riskScore >= 30 && systemStatus !== 'RECOVERY_MODE' && (
          <motion.div 
            initial={{ y: -50 }}
            animate={{ y: 0 }}
            className={`w-full py-2.5 px-6 flex items-center justify-center gap-3 text-white font-bold text-xs z-[200] shadow-lg ${riskScore >= 50 ? 'bg-red-600' : 'bg-amber-500'}`}
          >
            <ShieldCheck size={16} />
            <span>تنبيه أمني: مستوى التهديد مرتفع ({riskScore}%). {riskScore >= 50 ? 'تم تفعيل بروتوكولات الحماية المتقدمة.' : 'يرجى مراجعة سجلات النشاط.'}</span>
          </motion.div>
        )}

        <Header 
          pageTitle={getLabel()} 
          showBackButton={currentView !== 'dashboard'} 
          onBackClick={() => {
            const view = currentView as any;
            if (viewParams?.from) {
              handleNav(viewParams.from, null, { replace: true });
            } else if (view.startsWith?.('reports/') || view === 'aging-report') {
              handleNav('reports', null, { replace: true });
            } else {
              handleNav('dashboard', null, { replace: true });
            }
          }} 
          onMenuClick={() => setIsSidebarOpen(true)}
          onNavigate={handleNav}
          currentView={currentView}
        />

        <main ref={mainContentRef} className={`flex-1 min-h-0 relative ${
          ['sales', 'purchases'].includes(currentView)
            ? 'h-full overflow-hidden p-0 w-full max-w-[540px] md:max-w-xl mx-auto flex flex-col bg-white'
            : 'overflow-y-auto overflow-x-hidden bg-[#F8FAFA] custom-scrollbar w-full max-w-7xl mx-auto px-3 sm:px-6 py-3 sm:py-6'
        }`}>
          <div className={`w-full mx-auto ${
            ['sales', 'purchases'].includes(currentView)
              ? 'h-full flex-1 flex flex-col overflow-hidden box-border'
              : 'w-full min-h-full box-border overflow-x-hidden'
          }`}>
            <Suspense fallback={<div className="flex items-center justify-center h-full min-h-[400px]"><div className="w-10 h-10 border-4 border-[#10B981] border-t-transparent rounded-full animate-spin"></div></div>}>
              {(() => {
                switch (currentView) {
                  case 'sales': return <ProtectedRoute permission="POS_ACCESS"><SalesModule onNavigate={handleNav} /></ProtectedRoute>;
                  case 'purchases': return <ProtectedRoute permission="PURCHASE_ACCESS"><PurchasesView onNavigate={handleNav} /></ProtectedRoute>;
                  case 'settings': return <RoleGuard permission="MANAGE_SYSTEM"><SettingsModule onNavigate={handleNav} initialTab={viewParams?.tab} /></RoleGuard>;
                  case 'supplier-payment': return <RoleGuard permission="CREATE_VOUCHER"><SupplierPaymentModule onNavigate={handleNav} /></RoleGuard>;
                  case 'customer-receipt': return <RoleGuard permission="CREATE_VOUCHER"><CustomerReceiptModule onNavigate={handleNav} /></RoleGuard>;
                  case 'vouchers': return <RoleGuard permission="CREATE_VOUCHER"><VouchersModule onNavigate={handleNav} initialType={viewParams?.type} /></RoleGuard>;
                  case 'inventory': return <InventoryModule onNavigate={handleNav} />;
                  case 'inventory-audit': return <InventoryAuditModule lang="ar" onNavigate={handleNav} from={viewParams?.from} />;
                  case 'accounting': return <ProtectedRoute permission="FINANCIAL_ACCESS"><AccountingModule onNavigate={handleNav} /></ProtectedRoute>;
                  case 'audit-history': return <RoleGuard permission="MANAGE_SYSTEM"><AuditHistoryModule onNavigate={handleNav} recordId={viewParams?.id} tableName={viewParams?.tableName} initialFilter={viewParams?.filter} from={viewParams?.from} /></RoleGuard>;
                  case 'reconciliation': return <RoleGuard permission="FINANCIAL_ACCESS"><ReconciliationModule onNavigate={handleNav} /></RoleGuard>;
                  case 'system-health': return <ProtectedRoute permission="MANAGE_SYSTEM"><SystemHealthModule onNavigate={handleNav} /></ProtectedRoute>;
                  case 'invoices-archive': return <InvoicesArchiveModule onNavigate={handleNav} initialFilter={viewParams?.filter} initialSearch={viewParams?.id || viewParams?.search} />;
                  case 'invoice-history': return <RoleGuard permission="MANAGE_SYSTEM"><InvoiceHistoryModule onNavigate={handleNav} /></RoleGuard>;
                  case 'adjustments-registry': return <RoleGuard permission="FINANCIAL_ACCESS"><AdjustmentsArchiveModule onNavigate={handleNav} /></RoleGuard>;
                  case 'aging-report': return <RoleGuard permission="VIEW_REPORTS"><AgingReportModule onNavigate={handleNav} /></RoleGuard>;
                  case 'financial-dashboard': return <RoleGuard permission="VIEW_REPORTS"><FinancialDashboard onNavigate={handleNav} /></RoleGuard>;
                  case 'reports': return <ProtectedRoute permission="VIEW_REPORTS"><ReportsModule onNavigate={handleNav} /></ProtectedRoute>;
                  case 'partners': return <RoleGuard permission="MANAGE_PARTNERS"><PartnersModule onNavigate={handleNav} /></RoleGuard>;
                  case 'saas-portal': return <SaaSModule onNavigate={handleNav} />;
                  case 'advanced-reports': return <RoleGuard permission="VIEW_REPORTS"><AdvancedReportsModule onBack={() => handleNav('dashboard')} /></RoleGuard>;
                  
                  // Multi-branch module routing definitions
                  case 'branches': return <RoleGuard permission="BRANCH_VIEW"><BranchesList onNavigate={handleNav} /></RoleGuard>;
                  case 'branch-transfers': return <RoleGuard permission="BRANCH_TRANSFER"><BranchTransfers onNavigate={handleNav} initialTab={viewParams?.tab} initialStatus={viewParams?.status} /></RoleGuard>;
                  case 'branch-reports': return <RoleGuard permission="BRANCH_REPORT"><BranchReports onNavigate={handleNav} /></RoleGuard>;
                  case 'consolidation': return <RoleGuard permission="FINANCIAL_ACCESS"><ConsolidationDashboard onNavigate={handleNav} /></RoleGuard>;
                  case 'security-audit': return <RoleGuard permission="MANAGE_SYSTEM"><SecurityAuditDashboard onNavigate={handleNav} initialTab={viewParams?.tab} from={viewParams?.from} /></RoleGuard>;
                  
                  case 'reports/remaining-stock': return <RoleGuard permission="VIEW_REPORTS"><RemainingStockReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/item-profits': return <RoleGuard permission="VIEW_REPORTS"><ItemProfitsReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/customer-profit': return <RoleGuard permission="VIEW_REPORTS"><CustomerProfitReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/supplier-profit': return <RoleGuard permission="VIEW_REPORTS"><SupplierProfitReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/account-movement': return <RoleGuard permission="VIEW_REPORTS"><AccountMovementReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/purchases-by-item': return <RoleGuard permission="VIEW_REPORTS"><PurchasesByItemReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/sales-by-item': return <RoleGuard permission="VIEW_REPORTS"><SalesByItemReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/item-movement-details': return <RoleGuard permission="VIEW_REPORTS"><ItemMovementDetailsReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/expiry-items': return <RoleGuard permission="VIEW_REPORTS"><ExpiryItemsReport onNavigate={handleNav} /></RoleGuard>;
                  case 'reports/financial-engine': return <RoleGuard permission="VIEW_REPORTS"><FinancialEngineReport onNavigate={handleNav} initialTab={viewParams?.tab} initialCategory={viewParams?.category} /></RoleGuard>;
                  
                  case 'login': return <LoginPage onSuccess={() => handleNav('dashboard')} />;
                  case 'backup': return <ProtectedRoute permission="MANAGE_SYSTEM"><BackupManagement /></ProtectedRoute>;
                  case '403': return (
                    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center bg-white border border-slate-100 rounded-[32px] shadow-sm max-w-lg mx-auto my-12" dir="rtl">
                      <div className="w-16 h-16 bg-rose-50 text-rose-500 rounded-2xl flex items-center justify-center mb-6 shadow-xl shadow-rose-200/40">
                        <X size={32} />
                      </div>
                      <h2 className="text-xl font-black text-[#1E4D4D] mb-2">وصول مقيد (403)</h2>
                      <p className="text-xs font-bold text-slate-400 max-w-sm leading-relaxed mb-6">
                        عذراً، ليست لديك صلاحيات أمنية كافية للدخول إلى هذا القسم من المنظومة السيادية. تم تسجيل هذه التجربة كجزء من سجل التدقيق الأمني.
                      </p>
                      <button 
                        onClick={() => { window.location.hash = '#/dashboard'; }}
                        className="bg-[#1E4D4D] hover:bg-teal-900 text-white font-black text-xs py-3.5 px-6 rounded-xl transition-all shadow-md shadow-teal-900/10"
                      >
                        العودة للرئيسية
                      </button>
                    </div>
                  );
 
                  default: return <ProtectedRoute><Dashboard lang="ar" onNavigate={handleNav} /></ProtectedRoute>;
                }
              })()}
            </Suspense>
          </div>
        </main>

        {/* Smart Pharmacy Copilot Floating Launcher - Dashboard Only (Suppressed while Onboarding Modal is open) */}
        {currentView === 'dashboard' && !onboardingOpen && <CopilotWidget />}
      </div>
    </div>
    </MotionConfig>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SubscriptionStatusProvider>
        <Suspense fallback={<div className="min-h-screen bg-[#F8FAFA] flex items-center justify-center font-black text-[#1E4D4D] animate-pulse">جاري تحميل النظام السيادي...</div>}>
          <MainLayout />
        </Suspense>
      </SubscriptionStatusProvider>
    </ErrorBoundary>
  );
}
