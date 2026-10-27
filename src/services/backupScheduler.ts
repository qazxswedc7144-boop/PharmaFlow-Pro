import { db } from '@/core/db';
import { BackupService } from '@/services/backupService';
import { GoogleDriveService } from '@/services/backup/googleDriveService';
import { SystemBackup } from '@/types';

export interface BackupScheduleConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  destination: 'local' | 'gdrive' | 'device';
  password?: string;
}

class BackupScheduler {
  private timerId: any = null;

  async getConfig(): Promise<BackupScheduleConfig> {
    const config = await db.getSetting('backup_schedule_config');
    return config || {
      enabled: false,
      frequency: 'daily',
      destination: 'local',
      password: undefined
    };
  }

  async saveConfig(config: BackupScheduleConfig): Promise<void> {
    await db.saveSetting('backup_schedule_config', config);
    if (config.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Unified Backup Interface
   * Performs an encrypted snapshot of the database, saving it locally and/or uploading it to Google Drive
   */
  async runUnifiedBackup(config?: BackupScheduleConfig): Promise<string> {
    const activeConfig = config || await this.getConfig();
    const password = activeConfig.password;
    if (!password) {
      throw new Error('BACKUP_PASSWORD_REQUIRED: No password provided for encrypted backup.');
    }
    
    const frequencyLabel = activeConfig.frequency === 'daily' ? 'يومي' : activeConfig.frequency === 'weekly' ? 'أسبوعي' : 'شهري';
    const destinationLabel = activeConfig.destination === 'gdrive' ? 'جوجل درايف' : activeConfig.destination === 'device' ? 'تخزين الجهاز المحلي' : 'محلي';
    
    const name = `نسخة مجدولة تلقائية ${frequencyLabel} (${destinationLabel})`;
    const backupType: SystemBackup['backupType'] = activeConfig.frequency === 'daily' 
      ? 'SCHEDULED_DAILY' 
      : 'SCHEDULED_WEEKLY';
      
    console.log(`[UnifiedBackupScheduler] Triggering backup: ${name} to ${destinationLabel}`);

    // Phase 1: Local Backup Database Creation
    const backupId = await BackupService.createBackup(name, backupType, false, password);
    
    // Phase 2: If destination is Google Drive, package it and upload it using the GoogleDriveService API
    if (activeConfig.destination === 'gdrive') {
      const gdriveToken = GoogleDriveService.getAccessToken();
      if (!gdriveToken) {
        throw new Error('GD_TOKEN_MISSING: Google Drive is not connected or session has expired. Please check settings.');
      }
      
      const dateStr = new Date().toISOString().split('T')[0];
      const timestamp = Date.now();
      const fileName = `PharmaFlow_Scheduled_Backup_${dateStr}_${timestamp}.enc`;
      
      // Get the encrypted binary BLOB with GZip using our standard encryption key
      const contentBlob = await BackupService.exportBackupToFile(password);
      
      // Upload to Google Drive
      await GoogleDriveService.uploadBackup(fileName, contentBlob, gdriveToken);
      console.log(`[UnifiedBackupScheduler] Successfully uploaded scheduled backup ${backupId} to Google Drive: ${fileName}`);
    } else if (activeConfig.destination === 'device') {
      const dateStr = new Date().toISOString().split('T')[0];
      const timestamp = Date.now();
      const fileName = `PharmaFlow_Auto_Backup_${dateStr}_${timestamp}.enc`;
      
      // Get the encrypted binary BLOB with GZip using our standard encryption key
      const contentBlob = await BackupService.exportBackupToFile(password);
      
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(contentBlob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      }
      console.log(`[UnifiedBackupScheduler] Successfully downloaded scheduled backup ${backupId} directly to local device storage.`);
    }

    // Save timestamp of last successful automation run
    await db.saveSetting('last_scheduled_backup_run', new Date().toISOString());
    return backupId;
  }

  start() {
    this.stop();
    
    console.log('[BackupScheduler] Started automatic scheduler process thread');
    
    // Check backup timing shortly after launch
    setTimeout(() => this.checkAndTriggerBackup(), 15000);
    
    // Run evaluation every 30 minutes
    this.timerId = setInterval(() => {
      this.checkAndTriggerBackup();
    }, 1800000); 
  }

  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    console.log('[BackupScheduler] Stopped automatic scheduler process thread');
  }

  stopAutoTimer() {
    this.stop();
  }

  async checkAndTriggerBackup() {
    try {
      const config = await this.getConfig();
      if (!config.enabled) return;

        // 🚨 PRE-FLIGHT CHECK: Skip and notify if password is missing (fail-closed)
  if (!config.password) {
    console.error('[BackupScheduler] Auto-backup skipped: BACKUP_PASSWORD_REQUIRED. User must set a password in settings.');
    try {
      await db.saveSetting('backup_last_error', {
        code: 'BACKUP_PASSWORD_REQUIRED',
        message: 'النسخ الاحتياطي المجدول معطّل: لم يتم تعيين كلمة مرور.',
        timestamp: new Date().toISOString()
      });
    } catch {
      // Non-blocking
    }
    return;
  }

  const lastRunStr = await db.getSetting('last_scheduled_backup_run');
  const now = new Date();
  let shouldRun = false;

  if (!lastRunStr) {
    // Run first one immediately
    shouldRun = true;
  } else {
    const lastRun = new Date(lastRunStr);
    const diffMs = now.getTime() - lastRun.getTime();
    
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;
    const monthMs = 30 * dayMs;

    if (config.frequency === 'daily' && diffMs >= dayMs) {
      shouldRun = true;
    } else if (config.frequency === 'weekly' && diffMs >= weekMs) {
      shouldRun = true;
    } else if (config.frequency === 'monthly' && diffMs >= monthMs) {
      shouldRun = true;
    }
  }

  if (shouldRun) {
    console.log(`[BackupScheduler] Performing automatic cron trigger...`);
    try {
      await this.runUnifiedBackup(config);
      // Clear previous error marker on success
      try { await db.saveSetting('backup_last_error', null); } catch { /* non-blocking */ }
    } catch (backupErr: any) {
      // 🚨 PERSIST FAILURE: Do NOT swallow silently
      console.error('[BackupScheduler] Auto-backup FAILED:', backupErr?.message || backupErr);
      try {
        await db.saveSetting('backup_last_error', {
          code: backupErr?.code || 'BACKUP_FAILED',
          message: backupErr?.message || String(backupErr),
          timestamp: new Date().toISOString()
        });
      } catch {
        // Non-blocking
      }
      // Re-throw so callers (e.g., UI health checks) can react
      throw backupErr;
    }
  }
} catch (e: any) {
  // Log but don't crash the interval
  console.error('[BackupScheduler] Background loop check failed:', e?.message || e);

export const backupService = new BackupScheduler();
