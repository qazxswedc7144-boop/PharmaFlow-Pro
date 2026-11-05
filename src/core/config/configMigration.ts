// src/core/config/configMigration.ts

/**
 * Legacy settings migration is intentionally deferred.
 *
 * Historical localStorage and unscoped Dexie settings do not carry reliable tenant
 * ownership metadata. Assigning them to the currently authenticated tenant could
 * silently transfer another tenant's configuration. The original records are
 * preserved in place and excluded from scoped resolution by ConfigurationRepository.
 *
 * A future migration must first export/backup these records and obtain an explicit,
 * verifiable tenant ownership mapping before writing any scoped replacement.
 */
export async function runLegacySettingsMigration(): Promise<boolean> {
  return false;
}
