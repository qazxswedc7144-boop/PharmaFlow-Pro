import { db } from '@/core/db';
import { useSettingsStore } from '@/store/useSettingsStore';
import { BackupCredentialVault } from './BackupCredentialVault';
import { 
  BackupEntry, 
  BackupEvent, 
  BackupEventType, 
  BackupJobState, 
  BackupOrchestrationResult, 
  RetryConfig 
} from '../backup.types';
import { BackupService, backupService } from './BackupService';
import { BackupRetryService, backupRetryService } from './BackupRetryService';

export interface AutoBackupOptions {
  force?: boolean;
  source?: 'lifecycle' | 'manual' | 'schedule' | 'exit' | 'test';
  password?: string;
  retryConfig?: Partial<RetryConfig>;
}

export type BackupEventListener = (event: BackupEvent) => void;

/**
 * Enterprise Automated Backup Orchestrator
 * Coordinates automatic backups, offline-first cloud syncing, duplicate prevention,
 * and reliable retries with exponential backoff.
 */
export class BackupOrchestrator {
  private isLocked = false;
  private lastAutoBackupTimestamp = 0;
  private readonly cooldownMs = 15000; // 15 seconds cooldown for automatic triggers
  private readonly listeners = new Set<BackupEventListener>();
  private readonly pendingCloudSyncBackups: BackupEntry[] = [];
  private onlineStatusGetter: () => boolean = () => {
    return typeof navigator !== 'undefined' ? (navigator.onLine ?? true) : true;
  };

  constructor(
    private readonly backupSvc: BackupService = backupService,
    private readonly retrySvc: BackupRetryService = backupRetryService
  ) {}

  /**
   * Overrides the online status checker (primarily for testing and mock environments).
   */
  setOnlineStatusGetter(getter: () => boolean): void {
    this.onlineStatusGetter = getter;
  }

  /**
   * Checks whether a backup operation is currently in progress.
   */
  isBackupInProgress(): boolean {
    return this.isLocked;
  }

  /**
   * Returns the count of local backups pending cloud synchronization.
   */
  getPendingCloudSyncCount(): number {
    return this.pendingCloudSyncBackups.length;
  }

  /**
   * Subscribes to structured backup lifecycle events.
   * Returns an unsubscribe function.
   */
  addEventListener(listener: BackupEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Emits a structured observability event to all registered listeners.
   */
  private emitEvent(type: BackupEventType, details: Partial<BackupEvent> = {}): void {
    const event: BackupEvent = {
      type,
      timestamp: new Date().toISOString(),
      ...details
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Prevent listener errors from breaking the orchestrator
      }
    }
  }

  /**
   * Triggers an automated backup workflow according to enterprise settings and policies.
   */
  async triggerAutoBackup(options: AutoBackupOptions = {}): Promise<BackupOrchestrationResult> {
    const source = options.source || 'lifecycle';
    const now = Date.now();

    // 1. Check if auto backup is enabled in settings
    let isAutoBackupEnabled = false;
    try {
      isAutoBackupEnabled = useSettingsStore.getState().autoBackupEnabled;
    } catch {
      // Fallback
    }

    if (!isAutoBackupEnabled && !options.force) {
      return {
        success: false,
        localSuccess: false,
        cloudSuccess: false,
        jobState: 'pending',
        error: 'النسخ الاحتياطي التلقائي معطل في الإعدادات.'
      };
    }

    // 2. Concurrency Lock check
    if (this.isLocked) {
      return {
        success: false,
        localSuccess: false,
        cloudSuccess: false,
        jobState: 'pending',
        error: 'عملية نسخ احتياطي أخرى قيد التنفيذ حالياً.'
      };
    }
    this.isLocked = true;

    // 3. Cooldown & Duplicate Trigger Protection (unless forced or manual)
    if (!options.force && source !== 'manual' && now - this.lastAutoBackupTimestamp < this.cooldownMs) {
      this.isLocked = false;
      return {
        success: false,
        localSuccess: false,
        cloudSuccess: false,
        jobState: 'pending',
        error: 'تم تجاهل الطلب لتجنب تكرار النسخ الاحتياطي في فترة زمنية قصيرة.'
      };
    }

    // 4. Retrieve Password
    let password = options.password;
    if (!password) {
      try {
        password = useSettingsStore.getState().backupPassword;
      } catch {
        // Fallback
      }
    }

    if (!password || !password.trim()) {
      // Try fallback from Vault or DB
      try {
        const vaultPass = await BackupCredentialVault.getCredential();
        if (vaultPass) {
          password = vaultPass;
        } else {
          const passRecord = await db.settings.get('backupPassword');
          if (passRecord?.value && typeof passRecord.value === 'string') {
            password = passRecord.value;
          }
        }
      } catch {
        // Ignore
      }
    }

    if (!password || !password.trim()) {
      this.isLocked = false;
      this.emitEvent('cloud-failed', {
        jobState: 'pending',
        message: 'تعذر تشغيل النسخ الاحتياطي التلقائي: لم يتم تعيين كلمة مرور النسخ الاحتياطي.'
      });
      return {
        success: false,
        localSuccess: false,
        cloudSuccess: false,
        jobState: 'pending',
        error: 'يرجى تعيين كلمة مرور للنسخ الاحتياطي في الإعدادات أولاً.'
      };
    }

    this.lastAutoBackupTimestamp = now;

    let backupEntry: BackupEntry | null = null;
    let localSuccess = false;
    let cloudSuccess = false;
    let cloudPending = false;
    let currentJobState: BackupJobState = 'pending';

    this.emitEvent('started', {
      jobState: 'pending',
      message: `بدء عملية النسخ الاحتياطي التلقائي (${source}).`
    });

    try {
      // 5. Gather Database Snapshot
      const snapshotData = await this.collectDatabaseSnapshot();

      // 6. Create Local Encrypted Backup Package
      backupEntry = await this.backupSvc.createLocalBackup(snapshotData, password, 'full');
      localSuccess = true;
      currentJobState = 'local-completed';

      this.emitEvent('local-success', {
        backupId: backupEntry.metadata.id,
        jobState: 'local-completed',
        message: `تم إنشاء وتشفير النسخة الاحتياطية محلياً بنجاح (${backupEntry.metadata.name}).`
      });

      // 7. Check Online Status for Cloud Upload
      const isOnline = this.onlineStatusGetter();

      if (!isOnline) {
        // Offline-First: Keep local backup safe, queue cloud upload
        cloudPending = true;
        this.pendingCloudSyncBackups.push(backupEntry);
        this.emitEvent('completed', {
          backupId: backupEntry.metadata.id,
          jobState: 'local-completed',
          message: 'تم حفظ النسخة محلياً. التخزين السحابي مؤجل لعدم توفر اتصال بالإنترنت.'
        });

        return {
          success: true,
          backupId: backupEntry.metadata.id,
          backupName: backupEntry.metadata.name,
          localSuccess: true,
          cloudSuccess: false,
          cloudPending: true,
          jobState: 'local-completed'
        };
      }

      // 8. Attempt Cloud Upload with Exponential Backoff Retry
      currentJobState = 'uploading';
      this.emitEvent('cloud-upload-started', {
        backupId: backupEntry.metadata.id,
        jobState: 'uploading',
        message: 'جاري رفع النسخة المشفرة إلى التخزين السحابي...'
      });

      try {
        const entryToUpload = backupEntry;
        await this.retrySvc.executeWithRetry(
          () => this.backupSvc.uploadToCloud(entryToUpload),
          {
            config: options.retryConfig,
            onRetry: (attempt, _error, nextDelayMs) => {
              this.emitEvent('retry-scheduled', {
                backupId: entryToUpload.metadata.id,
                jobState: 'uploading',
                attempt,
                message: `إعادة محاولة رفع النسخة السحابية (${attempt}) بعد ${Math.round(nextDelayMs / 1000)} ثوانٍ...`
              });
            }
          }
        );

        cloudSuccess = true;
        currentJobState = 'cloud-completed';

        this.emitEvent('cloud-success', {
          backupId: backupEntry.metadata.id,
          jobState: 'cloud-completed',
          message: 'تم رفع النسخة الاحتياطية إلى التخزين السحابي بنجاح.'
        });

        this.emitEvent('completed', {
          backupId: backupEntry.metadata.id,
          jobState: 'completed',
          message: 'اكتملت عملية النسخ الاحتياطي التلقائي (المحلي والسحابي) بنجاح.'
        });
      } catch (cloudErr: any) {
        // CLOUD FAILURE DOES NOT COMPROMISE LOCAL BACKUP
        cloudSuccess = false;
        cloudPending = true;
        currentJobState = 'cloud-failed';
        this.pendingCloudSyncBackups.push(backupEntry);

        this.emitEvent('cloud-failed', {
          backupId: backupEntry.metadata.id,
          jobState: 'cloud-failed',
          message: `تعذر رفع النسخة السحابية: ${cloudErr?.message || 'خطأ غير معروف'}. تم الاحتفاظ بالنسخة المحلية آمنة.`
        });
      }

      return {
        success: localSuccess,
        backupId: backupEntry.metadata.id,
        backupName: backupEntry.metadata.name,
        localSuccess,
        cloudSuccess,
        cloudPending,
        jobState: cloudSuccess ? 'completed' : currentJobState
      };
    } catch (err: any) {
      const errorMessage = err?.message || 'فشل تشغيل عملية النسخ الاحتياطي';
      this.emitEvent('cloud-failed', {
        jobState: currentJobState,
        message: errorMessage
      });

      return {
        success: localSuccess,
        backupId: backupEntry?.metadata?.id,
        backupName: backupEntry?.metadata?.name,
        localSuccess,
        cloudSuccess: false,
        cloudPending,
        jobState: currentJobState,
        error: errorMessage
      };
    } finally {
      this.isLocked = false;
    }
  }

  /**
   * Synchronizes all queued pending cloud backups when network connectivity is restored.
   */
  async syncPendingCloudBackups(options?: { retryConfig?: Partial<RetryConfig> }): Promise<number> {
    if (this.pendingCloudSyncBackups.length === 0) return 0;
    if (!this.onlineStatusGetter()) return 0;
    if (this.isLocked) return 0;

    this.isLocked = true;
    let syncedCount = 0;
    const remainingQueue: BackupEntry[] = [];

    try {
      while (this.pendingCloudSyncBackups.length > 0) {
        const entry = this.pendingCloudSyncBackups.shift();
        if (!entry) continue;

        try {
          await this.retrySvc.executeWithRetry(
            () => this.backupSvc.uploadToCloud(entry),
            {
              config: options?.retryConfig,
              onRetry: (attempt, _error, nextDelayMs) => {
                this.emitEvent('retry-scheduled', {
                  backupId: entry.metadata.id,
                  jobState: 'uploading',
                  attempt,
                  message: `إعادة محاولة المزامنة السحابية (${attempt}) بعد ${Math.round(nextDelayMs / 1000)} ثوانٍ...`
                });
              }
            }
          );

          syncedCount++;
          this.emitEvent('cloud-success', {
            backupId: entry.metadata.id,
            jobState: 'cloud-completed',
            message: `تمت مزامنة النسخة الاحتياطية المتأخرة (${entry.metadata.name}) مع السحابة.`
          });
        } catch (err: any) {
          remainingQueue.push(entry);
          this.emitEvent('cloud-failed', {
            backupId: entry.metadata.id,
            jobState: 'cloud-failed',
            message: `فشلت محاولة مزامنة النسخة المتأخرة: ${err?.message || 'خطأ في الاتصال'}`
          });
        }
      }

      this.pendingCloudSyncBackups.push(...remainingQueue);
      return syncedCount;
    } finally {
      this.isLocked = false;
    }
  }

  /**
   * Gathers all core ERP tables sequentially from Dexie to avoid memory spikes
   * and ensure controlled memory safety on large datasets.
   */
  private async collectDatabaseSnapshot(): Promise<Record<string, any[]>> {
    const snapshot: Record<string, any[]> = {};
    const tables = [
      'products', 'invoices', 'invoiceItems', 'customers', 'suppliers', 'accounts',
      'sales', 'purchases', 'journalEntries', 'journalLines', 'inventoryTransactions',
      'accountingPeriods', 'vouchers', 'auditLogs', 'settings', 'medicineBatches'
    ];

    for (const tbl of tables) {
      try {
        const tableInstance = db.table(tbl);
        if (tableInstance) {
          snapshot[tbl] = await tableInstance.toArray();
        } else {
          snapshot[tbl] = [];
        }
      } catch {
        snapshot[tbl] = [];
      }
    }

    return snapshot;
  }
}

export const backupOrchestrator = new BackupOrchestrator();
