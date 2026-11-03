// src/features/settings/data/SettingsService.ts
import { configurationService } from '@/services/config/configurationService';

export type SettingValue = string | boolean | number | null;

/**
 * Facade Service for the Configuration Engine.
 * Provides a clean, simplified API for UI components while centralizing 
 * validation, caching, sync, and security inside `configurationService`.
 */
export class SettingsService {
  /**
   * Retrieves all known configuration values for the current context.
   */
  async getAllSettings(): Promise<Record<string, SettingValue>> {
    return await configurationService.getAll();
  }

  /**
   * Retrieves a specific group of settings in a single batch call.
   * @param groupKeys - Array of canonical config keys.
   */
  async getSettingsGroup(groupKeys: string[]): Promise<Record<string, SettingValue>> {
    return await configurationService.getGroup(groupKeys);
  }

  /**
   * Retrieves a single setting value asynchronously.
   * Falls back to default value if not found.
   */
  async getSetting<T = SettingValue>(key: string): Promise<T> {
    return await configurationService.get<T>(key);
  }

  /**
   * Synchronously retrieves a setting from the reactive in-memory cache.
   * ⚠️ Only use this after `initialize()` has been called (usually on app boot).
   */
  getSettingSync<T = SettingValue>(key: string): T {
    return configurationService.getSync<T>(key);
  }

  /**
   * Persists a single setting value.
   * @param key - Configuration key.
   * @param value - Value to save.
   * @deprecated The `_sync` third parameter is now ignored as sync is automatic.
   * @throws {Error} if validation fails or user lacks permissions (RBAC).
   */
  async saveSetting(key: string, value: SettingValue, _sync?: boolean): Promise<void> {
    try {
      await configurationService.set(key, value);
    } catch (err: any) {
      console.error(`[SettingsService] Failed to save '${key}':`, err.message);
      throw err; // Re-throw so UI can display proper Toast
    }
  }

  /**
   * Saves multiple settings in parallel (atomic batch).
   * @param settings - Object of key-value pairs.
   * @deprecated The `_sync` second parameter is now ignored.
   */
  async saveMultipleSettings(settings: Record<string, SettingValue>, _sync?: boolean): Promise<void> {
    try {
      await configurationService.saveMultiple(settings);
    } catch (err: any) {
      console.error(`[SettingsService] Failed to save multiple settings:`, err.message);
      throw err;
    }
  }

  /**
   * Removes a configuration key (resets to default).
   */
  async removeSetting(key: string): Promise<void> {
    try {
      await configurationService.remove(key);
    } catch (err: any) {
      console.error(`[SettingsService] Failed to remove '${key}':`, err.message);
      throw err;
    }
  }
}

export const settingsService = new SettingsService();
