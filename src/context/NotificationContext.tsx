import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import Dexie, { type Table } from 'dexie';

// الإشعارات المدعومة في PharmaFlow Pro
export type NotificationType = 'info' | 'success' | 'error' | 'warning';

export interface DbNotification {
  id?: number;
  message: string;
  type: NotificationType;
  timestamp: number;
  isRead: number; // 0 = unread, 1 = read
}

export interface Notification {
  message: string;
  type: NotificationType;
  duration?: number;
}

export interface ActiveToast extends Notification {
  id: string;
}

// قاعدة بيانات مستقلّة كلياً لحفظ سجل الإشعارات دون المساس ببنية البيانات الأساسية
class PharmaFlowNotificationsDB extends Dexie {
  notifications!: Table<DbNotification>;

  constructor() {
    super('PharmaFlowNotificationsDB');
    this.version(1).stores({
      notifications: '++id, type, timestamp, isRead'
    });
  }
}

export const notificationsDb = new PharmaFlowNotificationsDB();

interface NotificationContextType {
  showNotification: (message: string, type: NotificationType, duration?: number) => void;
  notifications: DbNotification[];
  unreadCount: number;
  markAsRead: (id: number) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  clearAll: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

// مسجل وصول خارجي static للإشعارات
let globalNotifier: ((message: string, type: NotificationType, duration?: number) => void) | null = null;

export const NotificationService = {
  show: (message: string, type: NotificationType = 'info', duration = 3000) => {
    if (globalNotifier) {
      globalNotifier(message, type, duration);
    } else {
      console.warn("[NotificationService] NotificationProvider is not mounted yet.");
    }
  },
  success: (message: string, duration = 3000) => NotificationService.show(message, 'success', duration),
  error: (message: string, duration = 3000) => NotificationService.show(message, 'error', duration),
  info: (message: string, duration = 3000) => NotificationService.show(message, 'info', duration),
  warning: (message: string, duration = 3000) => NotificationService.show(message, 'warning', duration),
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeToasts, setActiveToasts] = useState<ActiveToast[]>([]);
  const [dbNotifications, setDbNotifications] = useState<DbNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  
  const lastProcessed = useRef<{ [key: string]: number }>({});

  // جلب وتحديث الإشعارات من IndexedDB
  const refreshNotifications = useCallback(async () => {
    try {
      const list = await notificationsDb.notifications
        .orderBy('timestamp')
        .reverse()
        .toArray();
      setDbNotifications(list);
      
      const unread = list.filter(n => n.isRead === 0).length;
      setUnreadCount(unread);
    } catch (e) {
      console.error("[NotificationContext] Failed to load messages:", e);
    }
  }, []);

  // عند الإقلاع وجلب البيانات البدئية
  useEffect(() => {
    refreshNotifications();
  }, [refreshNotifications]);

  const markAsRead = useCallback(async (id: number) => {
    try {
      await notificationsDb.notifications.update(id, { isRead: 1 });
      await refreshNotifications();
    } catch (e) {
      console.error("[NotificationContext] markAsRead error:", e);
    }
  }, [refreshNotifications]);

  const markAllAsRead = useCallback(async () => {
    try {
      await notificationsDb.notifications.where({ isRead: 0 }).modify({ isRead: 1 });
      await refreshNotifications();
    } catch (e) {
      console.error("[NotificationContext] markAllAsRead error:", e);
    }
  }, [refreshNotifications]);

  const clearAll = useCallback(async () => {
    try {
      await notificationsDb.notifications.clear();
      await refreshNotifications();
    } catch (e) {
      console.error("[NotificationContext] clearAll error:", e);
    }
  }, [refreshNotifications]);

  const removeToast = useCallback((id: string) => {
    setActiveToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showNotification = useCallback((message: string, type: NotificationType, duration = 3000) => {
    if (!message) return;

    const fingerprint = `${type}_${message}`;
    const now = Date.now();
    const lastTime = lastProcessed.current[fingerprint] || 0;

    // 1. نظام طوابير ذكي: تفادي تكرار التنبيهات المتتالية بسرعة للحماية من الإسبام
    if (now - lastTime < 2500) {
      console.log(`[NotificationContext] Blocked duplicate notification: "${message}"`);
      return;
    }

    lastProcessed.current[fingerprint] = now;

    // 2. إضافة التنبيه لقائمة التكدس النشطة (Stacking)
    const toastId = 'toast_' + now + '_' + Math.random().toString(36).substring(2, 6);
    const newToast: ActiveToast = { id: toastId, message, type, duration };

    setActiveToasts(prev => [...prev, newToast]);

    setTimeout(() => {
      removeToast(toastId);
    }, duration || 3000);

    // 3. تخزين الإشعار في IndexedDB
    notificationsDb.notifications.add({
      message,
      type,
      timestamp: now,
      isRead: 0
    }).then(() => {
      // 4. الحفاظ على السعة الذكية للحد الأقصى (عبر حذف الأقدم عند تخطي 50)
      notificationsDb.notifications.toArray().then(async (all) => {
        if (all.length > 50) {
          const sorted = all.sort((a, b) => a.timestamp - b.timestamp);
          const toDeleteCount = sorted.length - 50;
          const idsToDelete = sorted.slice(0, toDeleteCount).map(item => item.id).filter(Boolean) as number[];
          if (idsToDelete.length > 0) {
            await notificationsDb.notifications.bulkDelete(idsToDelete);
          }
        }
        await refreshNotifications();
      });
    }).catch(e => {
      console.error("[NotificationContext] Failed to log to IndexedDB:", e);
      refreshNotifications();
    });
  }, [refreshNotifications, removeToast]);

  // ربط معالج الإشعارات الخارجي
  useEffect(() => {
    globalNotifier = showNotification;
    return () => {
      globalNotifier = null;
    };
  }, [showNotification]);

  // الاستماع لزر الـ Escape للمقاييس الفضلى لإمكانية الوصول
  useEffect(() => {
    if (activeToasts.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveToasts([]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeToasts]);

  const renderToastContent = (msg: string, type: NotificationType) => {
    let displayTitle = '';
    let displayBody = msg;

    if (msg.includes(':')) {
      const index = msg.indexOf(':');
      displayTitle = msg.substring(0, index).trim();
      displayBody = msg.substring(index + 1).trim();
    } else if (msg.includes('：')) {
      const index = msg.indexOf('：');
      displayTitle = msg.substring(0, index).trim();
      displayBody = msg.substring(index + 1).trim();
    } else {
      switch (type) {
        case 'success':
          displayTitle = 'عملية ناجحة ✅';
          break;
        case 'error':
          displayTitle = 'خطأ في النظام ❌';
          break;
        case 'warning':
          displayTitle = 'تنبيه هام ⚠️';
          break;
        default:
          displayTitle = 'إشعار النظام ℹ️';
          break;
      }
    }
    return { displayTitle, displayBody };
  };

  const getToastConfig = (type: NotificationType) => {
    switch (type) {
      case 'success':
        return {
          icon: <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />,
          bgColor: 'bg-emerald-50 dark:bg-emerald-950/40',
          borderColor: 'border-emerald-200 dark:border-emerald-800',
        };
      case 'error':
        return {
          icon: <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />,
          bgColor: 'bg-rose-50 dark:bg-rose-950/40',
          borderColor: 'border-rose-200 dark:border-rose-800',
        };
      case 'warning':
        return {
          icon: <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />,
          bgColor: 'bg-amber-50 dark:bg-amber-950/40',
          borderColor: 'border-amber-200 dark:border-amber-800',
        };
      default:
        return {
          icon: <Info className="w-5 h-5 text-blue-500 shrink-0" />,
          bgColor: 'bg-blue-50 dark:bg-blue-950/40',
          borderColor: 'border-blue-200 dark:border-blue-800',
        };
    }
  };

  return (
    <NotificationContext.Provider value={{ 
      showNotification, 
      notifications: dbNotifications, 
      unreadCount, 
      markAsRead, 
      markAllAsRead, 
      clearAll 
    }}>
      {children}

      <div 
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none font-sans w-[92vw] max-w-md" 
        dir="rtl"
        role="region"
        aria-label="الإشعارات"
      >
        <AnimatePresence>
          {activeToasts.map((toast) => {
            const { displayTitle, displayBody } = renderToastContent(toast.message, toast.type);
            const style = getToastConfig(toast.type);

            return (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: -50, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className={`relative w-full bg-white dark:bg-slate-900 border ${style.borderColor} text-slate-900 dark:text-slate-100 rounded-2xl shadow-xl px-4 py-3 pointer-events-auto flex items-center gap-3 overflow-hidden`}
                role="alert"
                aria-live="assertive"
              >
                <div className={`absolute top-0 right-0 bottom-0 w-1.5 ${
                  toast.type === 'success' ? 'bg-emerald-500' : 
                  toast.type === 'error' ? 'bg-rose-500' : 
                  toast.type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                }`} />

                <div className="flex-shrink-0 flex items-center">
                  <span className={`p-1.5 rounded-xl ${style.bgColor} border border-transparent flex items-center justify-center`}>
                    {style.icon}
                  </span>
                </div>

                <div className="flex-1 min-w-0 pr-1 text-right">
                  {displayTitle && (
                    <h4 className="text-[11px] font-black text-slate-400 dark:text-slate-400 tracking-wide mb-0.5 leading-snug select-none">
                      {displayTitle}
                    </h4>
                  )}
                  <p className="text-[13px] font-bold text-slate-800 dark:text-slate-200 leading-relaxed break-words">
                    {displayBody}
                  </p>
                </div>

                <div className="flex-shrink-0">
                  <button 
                    onClick={() => removeToast(toast.id)}
                    className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 p-1.5 rounded-xl transition-all duration-150 active:scale-90"
                    aria-label="إغلاق"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </NotificationContext.Provider>
  );
};

export const useAppNotification = () => {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useAppNotification must be used within a NotificationProvider');
  return context;
};
