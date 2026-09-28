import { createRoot } from 'react-dom/client';
import App from '@/app/App';
import '@/styles/index.css';
import { AppProvider } from '@/contexts/AppContext';
import { AuthProvider } from '@features/auth/hooks/useAuth';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { ReportProvider } from '@/contexts/ReportContext';
import { NotificationProvider } from '@/context/NotificationContext';
import AppFaultBoundary from '@/shared/faults/AppFaultBoundary';
import { SyncWorker } from '../packages/sync-engine/src/workers/sync.worker';

console.log("[BOOT] Loader script starting module evaluation...");

// Initiate Phase 3 Enterprise offline synchronization worker 
import { LockService } from '@features/locking/lock.service';
import { SystemOrchestrator } from '@/services/system/SystemOrchestrator';
import { configurationService } from '@/services/config/configurationService';

try {
  configurationService.initialize().catch(err => console.error("[CONFIG SERVICE] Initialization error:", err));
  LockService.initialize().catch(err => console.error("[LOCK MANAGER] Initialization error:", err));
  SystemOrchestrator.recoverIdempotencyKeys().catch(err => console.error("[IDEMPOTENCY RECOVERY] Error recovering stuck transactions:", err));
  if (typeof window !== "undefined") {
    SyncWorker.getInstance().start(30000); // 30s intervals
    console.log("[SYNC ENGINE] Background mutation sync engine booted successfully.");
  }
} catch (error) {
  console.error("[SYNC ENGINE] Failed starting local mutation sync scheduler:", error);
}

// Filter out background telemetry errors from Firebase Analytics/Installations if API key lacks specific permissions
if (typeof window !== "undefined") {
  (window as any).firebase = undefined;
  (window as any).google = undefined;

  const originalError = console.error;
  console.error = (...args: any[]) => {
    const str = args.map(a => {
      try {
        return (typeof a === "object" && a !== null) ? JSON.stringify(a) : String(a);
      } catch (e) {
        return "[Unserializable]";
      }
    }).join(" ");
    if (
      str.includes("analytics/config-fetch-failed") ||
      str.includes("installations/request-failed") ||
      str.includes("@firebase/analytics") ||
      str.includes("API key not valid")
    ) {
      console.warn("[TELEMETRY WARNING IGNORED]", ...args);
      return;
    }
    originalError.apply(console, args);
  };
}

window.addEventListener("error", (e) => {
  const errMsg = e.error instanceof Error ? e.error.message : (typeof e.error === "string" ? e.error : e.message || "Unknown error");
  console.error("GLOBAL ERROR:", errMsg);
  console.error("🔥 ERROR LOCATION:", { msg: e.message || "No message", src: e.filename || "unknown", line: e.lineno || 0, col: e.colno || 0 });
  if (typeof e.message === "string" && e.message.includes("ممنوع")) {
    console.error("🚨 DIRECT DB VIOLATION");
  }
});

/* 
if (process.env.NODE_ENV === 'production') {
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
}
*/

window.addEventListener("unhandledrejection", (event) => {
  // ⚠️ DO NOT call event.preventDefault() — that hides the error.
  const reason = event.reason;
  console.error(
    '[UnhandledRejection]',
    reason?.stack || reason?.message || String(reason),
  );
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error("Could not find root element");

console.log("[ROUTER READY] Preparing to mount root React application.");

const root = createRoot(rootElement);
root.render(
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
);

console.log("[APP RENDERED] Root React node successfully mounted with recovery listeners.");