// src/services/config/configurationService.ts
/**
 * PharmaFlow PRO ERP — Phase 3.4.5
 * Authoritative Single Source of Truth for Settings & Configuration
 */
import {
  ConfigScope,
  ConfigurationContext,
  ConfigurationRecord,
  ConfigChangeEvent
} from '@/core/config/types';
import { CONFIG_REGISTRY, normalizeConfigKey } from '@/core/config/configKeys';
import { assertScopedContext, getCurrentContext } from '@/core/config/configScopes';
import { validateConfigMutation } from '@/core/config/configValidation';
import { resolveConfigValue } from '@/core/config/configResolver';
import { runLegacySettingsMigration } from '@/core/config/configMigration';
import { configurationRepository } from './configurationRepository';
import { configurationSyncService } from './configurationSyncService';
import { configurationEvents } from './configurationEvents';
// 👈 استيراد خدمة المصادقة للتحقق من الصلاحيات
import { authService } from '@features/auth/services/authService'; 

export class ConfigurationService {
  private cache: Map<string, ConfigurationRecord<any>> = new Map();

  private getCacheKey(record: ConfigurationRecord<any>): string {
    const context = record.context || {};
    return JSON.stringify([
      record.scope,
      context.tenantId || '',
      context.branchId || '',
      context.userId || '',
      context.deviceId || '',
      normalizeConfigKey(record.key)
    ]);
  }

  private assertMutationAuthorized(scope: ConfigScope, context: ConfigurationContext, operation: 'تعديل' | 'حذف'): void {
    const user = authService.getCurrentUser();
    if (!authService.isSignedIn() || !user?.id) {
      throw new Error(`[ConfigurationService] غير مصرح لك: يجب تسجيل الدخول بجلسة صالحة قبل ${operation} الإعدادات.`);
    }

    assertScopedContext(scope, context);

    // Every tenant-owned setting must be bound to the tenant in the authenticated
    // session. A missing tenant claim is not permission to skip the comparison.
    if (scope !== 'SYSTEM' && scope !== 'RUNTIME') {
      if (!user.tenantId || context.tenantId !== user.tenantId) {
        throw new Error('[ConfigurationService] سياق المؤسسة لا يطابق المؤسسة في جلسة المصادقة.');
      }
    }

    const role = String(user.Role || '').trim().toLowerCase();
    const isSuperAdmin = ['superadmin', 'super_admin', 'platform_owner', 'platformowner', 'مدير النظام'].includes(role);
    const isAdmin = isSuperAdmin || [
      'admin', 'administrator', 'tenant_admin', 'tenant-admin', 'owner', 'مدير', 'مدير نظام'
    ].includes(role);

    if (scope === 'SYSTEM' && !isSuperAdmin) {
      throw new Error('[ConfigurationService] يتطلب هذا الإعداد صلاحية SuperAdmin.');
    }

    if ((scope === 'TENANT' || scope === 'BRANCH') && !isAdmin) {
      throw new Error(`[ConfigurationService] غير مصرح لك بـ${operation} إعدادات المؤسسة أو الفرع. يتطلب صلاحيات مدير.`);
    }

    if (scope === 'USER' && context.userId !== user.id) {
      throw new Error('[ConfigurationService] لا يمكنك تعديل إعدادات مستخدم آخر.');
    }
  }
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initializes Configuration Engine, executes legacy migrations, and populates reactive memory cache.
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Legacy unscoped records are preserved and intentionally not auto-assigned
        // to the current tenant. Migration remains deferred until ownership is verified.
        await runLegacySettingsMigration();

        // Load the complete record set; a timeout must not mark a partial cache as ready.
        const allRecords = await configurationRepository.getAllRecords();

        this.cache.clear();
        if (Array.isArray(allRecords)) {
          for (const record of allRecords) {
            if (record && record.key) {
              this.cache.set(this.getCacheKey(record), record);
            }
          }
        }

        this.isInitialized = true;
      } catch (err) {
        console.error('[ConfigurationService] Failed to initialize:', err);
        // Keep initialization retryable and surface storage failures to callers;
        // never silently resolve critical settings from defaults after a failed read.
        throw err;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Resolves a setting value asynchronously using scope precedence and current context.
   */
  public async get<T = unknown>(
    key: string,
    overrideContext?: ConfigurationContext
  ): Promise<T> {
    await this.initialize();
    // 👈 إصلاح الأداء: استخدام الـ Cache بدلاً من قراءة قاعدة البيانات بالكامل في كل مرة
    return this.getSync<T>(key, overrideContext);
  }

  /**
   * Synchronous getter backed by reactive in-memory cache with default fallback.
   */
  public getSync<T = unknown>(
    key: string,
    overrideContext?: ConfigurationContext
  ): T {
    const context = getCurrentContext(overrideContext);
    const canonicalKey = normalizeConfigKey(key);

    const allRecords = Array.from(this.cache.values());
    return resolveConfigValue<T>(canonicalKey, allRecords, context);
  }

  /**
   * Sets or updates a configuration key value.
   */
  public async set<T = unknown>(
    key: string,
    value: T,
    overrideContext?: ConfigurationContext
  ): Promise<void> {
    await this.initialize();

    const context = getCurrentContext(overrideContext);
    const canonicalKey = normalizeConfigKey(key);

    const def = CONFIG_REGISTRY[canonicalKey];
    const scope: ConfigScope = def ? def.scope : 'TENANT';
    this.assertMutationAuthorized(scope, context, 'تعديل');

    // 1. Validate mutation
    const validation = validateConfigMutation(canonicalKey, value, scope, context);
    if (!validation.valid) {
      throw new Error(`[ConfigurationService] Validation failed for '${canonicalKey}': ${validation.reason}`);
    }

    const sanitizedValue = validation.sanitizedValue !== undefined ? validation.sanitizedValue : value;
    const oldValue = this.getSync<T>(canonicalKey, context);

    // 2. Construct record
    const record: ConfigurationRecord<T> = {
      key: canonicalKey,
      value: sanitizedValue,
      scope,
      context,
      version: 1,
      updatedAt: new Date().toISOString()
    };

    // 3. Persist atomically
    await configurationRepository.saveRecord(record);

    // 4. Update memory cache
    this.cache.set(this.getCacheKey(record), record);

    // 5. Handle network synchronization if syncable
    // نضعها في كتلة try-catch حتى لا يمنع فشل المزامنة حفظ الإعداد محلياً
    try {
      await configurationSyncService.handleConfigMutation(record);
    } catch (syncErr) {
      console.warn('[ConfigurationService] Sync failed, but local save succeeded:', syncErr);
    }

    // 6. Emit change event
    const event: ConfigChangeEvent<T> = {
      key: canonicalKey,
      value: sanitizedValue,
      oldValue,
      scope,
      context,
      source: 'ConfigurationService',
      timestamp: new Date().toISOString()
    };
    configurationEvents.emit(event);
  }

  /**
   * Saves multiple settings in a single batch transaction.
   */
  public async saveMultiple(
    settings: Record<string, any>,
    overrideContext?: ConfigurationContext
  ): Promise<void> {
    await this.initialize();
    const context = getCurrentContext(overrideContext);
    
    // 👈 إصلاح الأداء: تنفيذ الحفظ بشكل متوازي (Parallel) بدلاً من التسلسل (Sequential)
    const promises = Object.entries(settings).map(([k, v]) => this.set(k, v, context));
    await Promise.all(promises);
  }

  /**
   * Retrieves a dictionary of settings matching group keys.
   */
  public async getGroup(
    groupKeys: string[],
    overrideContext?: ConfigurationContext
  ): Promise<Record<string, any>> {
    await this.initialize();
    const result: Record<string, any> = {};
    // 👈 بما أن get أصبح يعتمد على الـ Cache، هذه الحلقة أصبحت سريعة جداً ولن ترهق قاعدة البيانات
    for (const key of groupKeys) {
      result[key] = await this.get(key, overrideContext);
    }
    return result;
  }

  /**
   * Retrieves all configuration values for current context.
   */
  public async getAll(
    overrideContext?: ConfigurationContext
  ): Promise<Record<string, any>> {
    await this.initialize();
    const context = getCurrentContext(overrideContext);
    // 👈 استخدام الـ Cache بدلاً من القراءة من قاعدة البيانات
    const allRecords = Array.from(this.cache.values());

    const result: Record<string, any> = {};
    const knownKeys = Object.keys(CONFIG_REGISTRY);

    for (const k of knownKeys) {
      result[k] = resolveConfigValue(k, allRecords, context);
    }

    return result;
  }

  /**
   * Removes a configuration key.
   */
  public async remove(
    key: string,
    overrideContext?: ConfigurationContext
  ): Promise<void> {
    await this.initialize();

    const context = getCurrentContext(overrideContext);
    const canonicalKey = normalizeConfigKey(key);
    const def = CONFIG_REGISTRY[canonicalKey];
    const scope: ConfigScope = def ? def.scope : 'TENANT';
    this.assertMutationAuthorized(scope, context, 'حذف');

    const oldValue = this.getSync(key, context); // 👈 أخذ القيمة القديمة قبل الحذف

    await configurationRepository.deleteRecord(canonicalKey, scope, context);
    this.cache.delete(this.getCacheKey({ key: canonicalKey, scope, context, value: undefined, version: 0, updatedAt: '' }));

    // 👈 إصلاح: إطلاق حدث عند الحذف ليتحدث باقي التطبيق
    configurationEvents.emit({
      key: canonicalKey,
      value: undefined,
      oldValue,
      scope,
      context,
      source: 'ConfigurationService',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Alias for remove() to delete a key.
   */
  public async delete(
    key: string,
    overrideContext?: ConfigurationContext
  ): Promise<void> {
    return this.remove(key, overrideContext);
  }

  /**
   * Alias for get() to resolve values.
   */
  public async resolve<T = unknown>(
    key: string,
    context?: ConfigurationContext
  ): Promise<T> {
    return this.get<T>(key, context);
  }

  /**
   * Subscribes to configuration change events.
   */
  public subscribe(
    keyOrListener: any,
    callback?: any
  ): () => void {
    return configurationEvents.subscribe(keyOrListener, callback);
  }
}

export const configurationService = new ConfigurationService();
