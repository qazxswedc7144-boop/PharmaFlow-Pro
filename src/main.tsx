import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Contexts
import { AppProvider } from './contexts/AppContext';
// ⚠️ تأكد من صحة هذا المسار، الأفضل نقله خارج مجلد hooks
import { AuthProvider } from './features/auth/context/AuthContext'; 
import { ThemeProvider } from './contexts/ThemeContext';
import { ReportProvider } from './contexts/ReportContext';
import { NotificationProvider } from './contexts/NotificationContext';
import AppFaultBoundary from './shared/faults/AppFaultBoundary';

// Services & Sync Engine
// ⚠️ تأكد من صيغة استيراد الـ Worker حسب أداة البناء (مثل ?worker في Vite)
import { SyncWorker } from './packages/sync-engine/src/workers/sync.worker';
import { LockService } from './features/locking/lock.service';
import { SystemOrchestrator } from './services/system/SystemOrchestrator';
import { configurationService } from './services/config/configurationService';

console.log('[BOOT] Loader script starting module evaluation...');

// دالة مساعدة لتهيئة الخدمات بشكل آمن ومتزامن
const initializeAppServices = async () => {
  try {
    // ننتظر جميع عمليات التهيئة قبل المتابعة لتجنب Race Conditions
    await Promise.all([
      configurationService.initialize(),
      LockService.initialize(),
      SystemOrchestrator.recoverIdempotencyKeys()
    ]);
    console.log("[BOOT] Core services initialized successfully.");
  } catch (err) {
    console.error("[BOOT] Critical failure during service initialization:", err);
    // يمكنك هنا عرض شاشة خطأ للمستخدم بدلاً من محاولة تشغيل التطبيق
  }
};

// تهيئة الـ Sync Worker في الخلفية دون حظر واجهة المستخدم
const startBackgroundSync = () => {
  const startWorker = () => {
    try {
      SyncWorker.getInstance().start(30000); // 30s interval
      console.log("[SYNC ENGINE] Background mutation sync engine booted.");
    } catch (error) {
      console.error("[SYNC ENGINE] Failed to start:", error);
    }
  };

  if (typeof window !== "undefined") {
    if ("requestIdleCallback" in window) {
      (window as any).requestIdleCallback(startWorker, { timeout: 5000 });
    } else {
      setTimeout(startWorker, 2000);
    }
  }
};

// معالجة الأخطاء العالمية
const setupGlobalErrorHandling = () => {
  if (typeof window === "undefined") return;

  // تعطيل متغيرات مزعجة بطريقة آمنة
  (window as any).firebase = undefined;
  (window as any).google = undefined;

  const originalError = console.error;
  console.error = (...args: any[]) => {
    // معالجة آمنة للأخطاء لتجنب تحويل Error Object إلى {}
    const formattedArgs = args.map(a => {
      if (a instanceof Error) {
        return `Error: ${a.message}\nStack: ${a.stack}`;
      }
      if (typeof a === "object" && a !== null) {
        try { return JSON.stringify(a); } 
        catch { return "[Circular/Object]"; }
      }
      return String(a);
    }).join(" ");

    // تصفية الأخطاء المعروفة بأمان
    if (
      formattedArgs.includes("analytics/config-fetch-failed") ||
      formattedArgs.includes("installations/request-failed") ||
      formattedArgs.includes("@firebase/analytics")
    ) {
      console.warn("[TELEMETRY WARNING IGNORED]");
      return;
    }
    
    originalError.apply(console, args);
  };

  window.addEventListener("error", (e) => {
    const errMsg = e.error instanceof Error ? e.error.message : (typeof e.error === "string" ? e.error : e.message || "Unknown error");
    console.error("GLOBAL ERROR:", errMsg);
    console.error("🚨 ERROR LOCATION:", { 
      msg: e.message || "No message", 
      src: e.filename || "unknown", 
      line: e.lineno || 0, 
      col: e.colno || 0 
    });
    e.preventDefault(); // منع التكرار في وحدة تحكم المتصفح
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const details = reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason: String(reason) };
    console.warn("Unhandled async rejection:", details);
    e.preventDefault();
  });
};

// دالة التشغيل الرئيسية
const bootstrapApp = async () => {
  // 1. إعداد معالجة الأخطاء
  setupGlobalErrorHandling();

  // 2. تهيئة الخدمات الأساسية (انتظار الانتهاء)
  await initializeAppServices();

  // 3. بدء مزامنة الخلفية
  startBackgroundSync();

  // 4. رسم التطبيق
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error("Could not find root element");

  console.log("[ROUTER READY] Preparing to mount root React application.");

  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <AppFaultBoundary>
        <AppProvider>
          <AuthProvider>
            <ThemeProvider>
              <ReportProvider>
                <NotificationProvider>
                  <App />
                </NotificationProvider>
              </ReportProvider>
            </ThemeProvider>
          </AuthProvider>
        </AppProvider>
      </AppFaultBoundary>
    </React.StrictMode>
  );

  console.log('[APP RENDERED] Root React node successfully mounted.');
};

// بدء التشغيل
bootstrapApp().catch(err => {
  console.error("💀 FATAL: Failed to bootstrap application:", err);
  // عرض رسالة خطأ للمستخدم هنا إذا لزم الأمر
});
