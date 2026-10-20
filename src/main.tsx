import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Contexts
import { AppProvider } from './contexts/AppContext';
import { AuthProvider } from './features/auth/hooks/useAuth'; 
import { ThemeProvider } from './contexts/ThemeContext';
import { ReportProvider } from './contexts/ReportContext';
import AppFaultBoundary from './shared/faults/AppFaultBoundary';

// Services & Sync Engine
import { SyncWorker } from './packages/sync-engine/src/workers/sync.worker';
import { LockService } from './features/locking/lock.service';
import { SystemOrchestrator } from './services/system/SystemOrchestrator';
import { configurationService } from './services/config/configurationService';

console.log('[BOOT] Loader script starting module evaluation...');

const initializeAppServices = async () => {
  try {
    await Promise.all([
      configurationService.initialize(),
      LockService.initialize(),
      SystemOrchestrator.recoverIdempotencyKeys()
    ]);
    console.log("[BOOT] Core services initialized successfully.");
  } catch (err) {
    console.error("[BOOT] Critical failure during service initialization:", err);
  }
};

const startBackgroundSync = () => {
  const startWorker = () => {
    try {
      SyncWorker.getInstance().start(30000); 
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

const setupGlobalErrorHandling = () => {
  if (typeof window === "undefined") return;
  (window as any).firebase = undefined;
  (window as any).google = undefined;

  const originalError = console.error;
  console.error = (...args: any[]) => {
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
    e.preventDefault(); 
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const details = reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason: String(reason) };
    console.warn("Unhandled async rejection:", details);
    e.preventDefault();
  });
};

const bootstrapApp = async () => {
  setupGlobalErrorHandling();
  await initializeAppServices();
  startBackgroundSync();

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
                <App />
              </ReportProvider>
            </ThemeProvider>
          </AuthProvider>
        </AppProvider>
      </AppFaultBoundary>
    </React.StrictMode>
  );

  console.log('[APP RENDERED] Root React node successfully mounted.');
};

bootstrapApp().catch(err => {
  console.error("💀 FATAL: Failed to bootstrap application:", err);
});
