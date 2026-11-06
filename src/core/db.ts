/* eslint-disable @typescript-eslint/no-unused-vars */
import Dexie, { type Table, type Transaction } from 'dexie';
import { TokenProvider } from '@/services/auth/tokenProvider';

import { configurationService } from '@/services/config/configurationService';
import { normalizeRole } from '@/utils/permissions';

function ensureItemPrimaryKey(table: any, item: any) {
  if (!item || typeof item !== 'object') return item;
  try {
    const schema = table?.schema;
    if (!schema || !schema.primKey) return item;
    
    const keyPath = schema.primKey.keyPath;
    const isAuto = schema.primKey.auto;

    if (keyPath && typeof keyPath === 'string' && !isAuto) {
      if (item[keyPath] === undefined || item[keyPath] === null || item[keyPath] === '' || typeof item[keyPath] === 'boolean') {
        const tableName = table.name || 'entity';
        const candidate = (item.id && typeof item.id === 'string' ? item.id : null) || 
                          (item.ID && typeof item.ID === 'string' ? item.ID : null) || 
                          (item[`${tableName}Id`] && typeof item[`${tableName}Id`] === 'string' ? item[`${tableName}Id`] : null) || 
                          (item[`${tableName}_id`] && typeof item[`${tableName}_id`] === 'string' ? item[`${tableName}_id`] : null) || 
                          (item.key && typeof item.key === 'string' ? item.key : null) || 
                          (item.code && typeof item.code === 'string' ? item.code : null) || 
                          (item.invoice_number && typeof item.invoice_number === 'string' ? item.invoice_number : null) || 
                          (item.invoiceNumber && typeof item.invoiceNumber === 'string' ? item.invoiceNumber : null) || 
                          item.draftId || item.voucherId || item.linkId || item.transaction_id || 
                          item.Transaction_ID || item.errorId || item.AdjustmentID;
        item[keyPath] = candidate || `${tableName.toUpperCase()}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      }
    }
  } catch (e) {
    console.warn('[DexieGuard] Error ensuring primary key:', e);
  }
  return item;
}

function extractPrimaryKey(table: any, record: any): any {
  const keyPath = table?.schema?.primKey?.keyPath;
  if (typeof keyPath === 'string') return record?.[keyPath];
  if (Array.isArray(keyPath)) return keyPath.map((part: string) => record?.[part]);
  return undefined;
}

const SYNC_OWNED_TABLES = new Set(['syncQueue', 'sync_queue', 'outbox']);

const TENANT_SCOPED_TABLES = new Set([
  'invoices', 'products', 'customers', 'suppliers', 'journalEntries',
  'accounts', 'journalLines', 'sales', 'purchases', 'syncQueue', 'sync_queue', 'outbox',
  'branchTransfers', 'branchInventory', 'inventoryCorrectionCases',
  'cashboxes', 'cashFlow', 'users', 'userPermissions', 'vouchers', 'receipts', 'payments',
  'financialHealthSnapshots', 'systemAlerts', 'accountingPeriods'
]);

function requireTenantForTable(table: any, operation: string) {
  const session = getCurrentUserSession();
  if (!session.tenantId) {
    throw new Error(`FAIL_CLOSED: ${operation} forbidden on '${table.name}' without an active tenant session.`);
  }
  return session as typeof session & { tenantId: string };
}

function assertTenantUnchanged(table: any, expectedTenantId: string, operation: string) {
  const current = requireTenantForTable(table, operation);
  if (current.tenantId !== expectedTenantId) {
    throw new Error(`FAIL_CLOSED: Tenant session changed during ${operation} on '${table.name}'.`);
  }
  return current;
}


type TenantSessionIdentity = {
  authSession: ReturnType<typeof TokenProvider.getCurrentSession>;
  user: any;
  userId: string;
  tenantId: string;
  token: string;
};

type SelfCredentialUpgradeCapability = {
  userId: string;
  tenantId: string;
  token: string;
  expectedLegacyPassword: string;
  passwordHash: string;
  consumed: boolean;
};

// Capabilities are bound to one Dexie transaction and one exact update.
const selfCredentialUpgradeCapabilities = new WeakMap<Transaction, SelfCredentialUpgradeCapability>();

function resolveTenantSessionIdentity(): TenantSessionIdentity | null {
  try {
    const authSession = TokenProvider.getCurrentSession();
    const user = authSession?.user as any;
    if (!authSession?.isAuthenticated || typeof authSession.token !== 'string' || !authSession.token.trim() || !user) {
      return null;
    }

    const primaryUserId = typeof user.id === 'string' ? user.id.trim() : '';
    const legacyUserId = typeof user.user_id === 'string' ? user.user_id.trim() : '';
    const userId = primaryUserId || legacyUserId;
    const sessionTenantId = typeof authSession.tenantId === 'string' ? authSession.tenantId.trim() : '';
    const primaryUserTenantId = typeof user.tenantId === 'string' ? user.tenantId.trim() : '';
    const legacyUserTenantId = typeof user.tenant_id === 'string' ? user.tenant_id.trim() : '';
    const userTenantId = primaryUserTenantId || legacyUserTenantId;
    const current = getCurrentUserSession();

    if (
      !userId ||
      (primaryUserId && legacyUserId && primaryUserId !== legacyUserId) ||
      !sessionTenantId ||
      !userTenantId ||
      (primaryUserTenantId && legacyUserTenantId && primaryUserTenantId !== legacyUserTenantId) ||
      userTenantId !== sessionTenantId ||
      current.userId !== userId ||
      current.tenantId !== sessionTenantId
    ) {
      return null;
    }

    return { authSession, user, userId, tenantId: sessionTenantId, token: authSession.token };
  } catch {
    return null;
  }
}

function getCanonicalSessionRole(identity: TenantSessionIdentity): string | null {
  const primaryRole = typeof identity.user.role === 'string' && identity.user.role.trim()
    ? identity.user.role
    : undefined;
  const legacyRole = typeof identity.user.Role === 'string' && identity.user.Role.trim()
    ? identity.user.Role
    : undefined;

  if (primaryRole && legacyRole && normalizeRole(primaryRole) !== normalizeRole(legacyRole)) {
    return null;
  }
  return normalizeRole(primaryRole || legacyRole);
}

function assertTenantAdminForUserManagement(tableName: string): void {
  if (tableName !== 'users' && tableName !== 'userPermissions') return;

  const identity = resolveTenantSessionIdentity();
  const role = identity ? getCanonicalSessionRole(identity) : null;
  const allowedRoles = new Set(['admin', 'tenant_admin', 'owner', 'platform_owner']);

  if (!identity || !role || !allowedRoles.has(role)) {
    throw new Error(`FAIL_CLOSED: Tenant administrator authorization required for '${tableName}'.`);
  }
}

function consumeSelfCredentialUpgradeCapability(
  tableName: string,
  modifications: any,
  primaryKey: any,
  record: any,
  transaction: Transaction | undefined,
  currentSession: ReturnType<typeof getCurrentUserSession>
): boolean {
  if (tableName !== 'users' || !transaction) return false;

  const capability = selfCredentialUpgradeCapabilities.get(transaction);
  if (!capability || capability.consumed) return false;

  const identity = resolveTenantSessionIdentity();
  const keys = modifications && typeof modifications === 'object'
    ? Object.keys(modifications).sort()
    : [];
  const isExactCredentialUpdate =
    keys.length === 2 &&
    keys[0] === 'password' &&
    keys[1] === 'passwordHash' &&
    modifications.password === undefined &&
    modifications.passwordHash === capability.passwordHash;
  const isExactTarget =
    String(primaryKey) === capability.userId &&
    String(record?.id || record?.user_id || '') === capability.userId &&
    record?.tenantId === capability.tenantId &&
    record?.password === capability.expectedLegacyPassword &&
    !record?.passwordHash;

  if (
    !identity ||
    identity.user.offlineOnly !== true ||
    identity.token !== capability.token ||
    identity.userId !== capability.userId ||
    identity.tenantId !== capability.tenantId ||
    currentSession.userId !== capability.userId ||
    currentSession.tenantId !== capability.tenantId ||
    !isExactCredentialUpdate ||
    !isExactTarget
  ) {
    return false;
  }

  capability.consumed = true;
  return true;
}

if (typeof Dexie !== 'undefined' && (Dexie as any).Table) {
  const TableProto = (Dexie as any).Table.prototype;
  const originalPut = TableProto.put;
  const originalAdd = TableProto.add;
  const originalGet = TableProto.get;
  const originalUpdate = TableProto.update;
  const originalDelete = TableProto.delete;
  const originalBulkGet = TableProto.bulkGet;
  const originalBulkPut = TableProto.bulkPut;
  const originalBulkAdd = TableProto.bulkAdd;
  const originalBulkDelete = TableProto.bulkDelete;
  const originalClear = TableProto.clear;
  const originalToArray = TableProto.toArray;
  const originalCount = TableProto.count;
  const requiredTableMethods = {
    put: originalPut, add: originalAdd, get: originalGet, update: originalUpdate, delete: originalDelete,
    bulkGet: originalBulkGet, bulkPut: originalBulkPut, bulkAdd: originalBulkAdd,
    bulkDelete: originalBulkDelete, clear: originalClear, toArray: originalToArray, count: originalCount
  };
  const missingTableMethods = Object.entries(requiredTableMethods)
    .filter(([, method]) => typeof method !== 'function')
    .map(([name]) => name);
  if (missingTableMethods.length > 0) {
    throw new Error(`[SECURITY] Dexie tenant guards could not initialize; missing Table methods: ${missingTableMethods.join(', ')}`);
  }
  const hasTenantIndex = (table: any) => (table?.schema?.indexes || []).some((index: any) =>
    index?.keyPath === 'tenantId'
  );
  const isTenantScoped = (table: any) => TENANT_SCOPED_TABLES.has(table?.name) ||
    hasTenantIndex(table) || (table?.schema?.indexes || []).some((index: any) =>
      Array.isArray(index?.keyPath) && index.keyPath.includes('tenantId')
    );

  if (originalPut) {
    TableProto.put = function(this: any, item: any, key?: any) {
      ensureItemPrimaryKey(this, item);
      return originalPut.call(this, item, key);
    };
  }

  if (originalAdd) {
    TableProto.add = function(this: any, item: any, key?: any) {
      ensureItemPrimaryKey(this, item);
      return originalAdd.call(this, item, key);
    };
  }

  if (originalGet) {
    TableProto.get = function(this: any, key: any) {
      if (!isTenantScoped(this)) return originalGet.call(this, key);
      const session = requireTenantForTable(this, 'Read');
      return originalGet.call(this, key).then((record: any) => {
        assertTenantUnchanged(this, session.tenantId, 'Read');
        if (record && (!record.tenantId || record.tenantId !== session.tenantId)) {
          throw new Error(`FAIL_CLOSED: Unauthorized direct read on '${this.name}'.`);
        }
        return record;
      });
    };
  }

  if (originalUpdate && originalGet) {
    TableProto.update = function(this: any, key: any, changes: any) {
      if (!isTenantScoped(this)) return originalUpdate.call(this, key, changes);
      const session = requireTenantForTable(this, 'Update');
      return originalGet.call(this, key).then((record: any) => {
        assertTenantUnchanged(this, session.tenantId, 'Update');
        // Preserve Dexie's 0 result for a genuinely missing key, but never allow
        // a caller to silently target a row owned by another tenant or an orphan.
        if (!record) return 0;
        if (!record.tenantId || record.tenantId !== session.tenantId) {
          throw new Error(`FAIL_CLOSED: Unauthorized data modification attempt on '${this.name}'.`);
        }
        if (
          changes &&
          typeof changes === 'object' &&
          Object.prototype.hasOwnProperty.call(changes, 'tenantId') &&
          changes.tenantId !== record.tenantId
        ) {
          throw new Error('FAIL_CLOSED: tenantId modification is strictly forbidden.');
        }
        return originalUpdate.call(this, key, changes).then((updated: number) => {
          assertTenantUnchanged(this, session.tenantId, 'Update');
          return updated;
        });
      });
    };
  }

  if (originalBulkGet) {
    TableProto.bulkGet = function(this: any, keys: any[]) {
      if (!isTenantScoped(this)) return originalBulkGet.call(this, keys);
      const session = requireTenantForTable(this, 'Bulk read');
      return originalBulkGet.call(this, keys).then((records: any[]) => {
        assertTenantUnchanged(this, session.tenantId, 'Bulk read');
        return records.map((record: any) => {
          if (record && (!record.tenantId || record.tenantId !== session.tenantId)) {
            throw new Error(`FAIL_CLOSED: Unauthorized bulk read on '${this.name}'.`);
          }
          return record;
        });
      });
    };
  }

  if (originalToArray) {
    TableProto.toArray = function(this: any) {
      if (!isTenantScoped(this)) return originalToArray.call(this);
      const session = requireTenantForTable(this, 'Read');
      const result = hasTenantIndex(this)
        ? this.where('tenantId').equals(session.tenantId).toArray()
        : originalToArray.call(this).then((records: any[]) =>
            records.filter((record: any) => record?.tenantId === session.tenantId)
          );
      return result.then((records: any[]) => {
        assertTenantUnchanged(this, session.tenantId, 'Read');
        return records;
      });
    };
  }

  if (originalCount) {
    TableProto.count = function(this: any) {
      if (!isTenantScoped(this)) return originalCount.call(this);
      const session = requireTenantForTable(this, 'Count');
      const result = hasTenantIndex(this)
        ? this.where('tenantId').equals(session.tenantId).count()
        : originalToArray.call(this).then((records: any[]) =>
            records.filter((record: any) => record?.tenantId === session.tenantId).length
          );
      return result.then((count: number) => {
        assertTenantUnchanged(this, session.tenantId, 'Count');
        return count;
      });
    };
  }

  if (originalBulkAdd) {
    TableProto.bulkAdd = function(this: any, items: any[], keysOrOptions?: any, optionsArg?: any) {
      if (!isTenantScoped(this)) {
        if (Array.isArray(items)) items.forEach(item => ensureItemPrimaryKey(this, item));
        return originalBulkAdd.call(this, items, keysOrOptions, optionsArg);
      }
      if (!Array.isArray(items)) throw new Error('FAIL_CLOSED: Invalid bulk payload.');
      const keys = Array.isArray(keysOrOptions) ? keysOrOptions : undefined;
      const options = optionsArg || (keys ? undefined : keysOrOptions);
      if (keys && keys.length !== items.length) throw new Error('Invalid bulk keys length.');
      if (keys && this.schema.primKey.keyPath) throw new Error('bulkAdd(): keys are invalid for inbound primary keys.');
      const session = requireTenantForTable(this, 'Bulk create');
      const normalized = items.map((item: any) => {
        if (!item || typeof item !== 'object' || (item.tenantId && item.tenantId !== session.tenantId)) {
          throw new Error(`FAIL_CLOSED: Cross-tenant bulk create rejected on '${this.name}'.`);
        }
        const value = { ...item, tenantId: session.tenantId, userId: item.userId || session.userId };
        ensureItemPrimaryKey(this, value);
        return value;
      });
      return this.db.transaction('rw', this, async () => {
        const result: any[] = [];
        for (let index = 0; index < normalized.length; index += 1) {
          assertTenantUnchanged(this, session.tenantId, 'Bulk create');
          result.push(await originalAdd.call(this, normalized[index], Array.isArray(keys) ? keys[index] : undefined));
        }
        return options?.allKeys === true ? result : result[result.length - 1];
      });
    };
  }

  if (originalBulkPut && originalGet && originalPut) {
    TableProto.bulkPut = function(this: any, items: any[], keysOrOptions?: any, optionsArg?: any) {
      if (!isTenantScoped(this)) {
        if (Array.isArray(items)) items.forEach(item => ensureItemPrimaryKey(this, item));
        return originalBulkPut.call(this, items, keysOrOptions, optionsArg);
      }
      if (!Array.isArray(items)) throw new Error('FAIL_CLOSED: Invalid bulk payload.');
      const keys = Array.isArray(keysOrOptions) ? keysOrOptions : undefined;
      const options = optionsArg || (keys ? undefined : keysOrOptions);
      if (keys && keys.length !== items.length) throw new Error('Invalid bulk keys length.');
      if (keys && this.schema.primKey.keyPath) throw new Error('bulkPut(): keys are invalid for inbound primary keys.');
      const session = requireTenantForTable(this, 'Bulk upsert');
      return this.db.transaction('rw', this, async () => {
        const result: any[] = [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!item || typeof item !== 'object' || (item.tenantId && item.tenantId !== session.tenantId)) {
            throw new Error(`FAIL_CLOSED: Cross-tenant bulk upsert rejected on '${this.name}'.`);
          }
          const key = Array.isArray(keys) ? keys[index] : extractPrimaryKey(this, item);
          const existing = key === undefined || key === null ? undefined : await originalGet.call(this, key);
          if (existing && (!existing.tenantId || existing.tenantId !== session.tenantId)) {
            throw new Error(`FAIL_CLOSED: Unauthorized bulk upsert target on '${this.name}'.`);
          }
          const value = { ...item, tenantId: session.tenantId, userId: item.userId || session.userId };
          ensureItemPrimaryKey(this, value);
          assertTenantUnchanged(this, session.tenantId, 'Bulk upsert');
          result.push(await originalPut.call(this, value, Array.isArray(keys) ? keys[index] : undefined));
        }
        return options?.allKeys === true ? result : result[result.length - 1];
      });
    };
  }

  if (originalBulkDelete && originalGet && originalDelete) {
    TableProto.bulkDelete = function(this: any, keys: any[]) {
      if (!isTenantScoped(this)) return originalBulkDelete.call(this, keys);
      if (!Array.isArray(keys)) throw new Error('FAIL_CLOSED: Invalid bulk delete keys.');
      return this.db.transaction('rw', this, async () => {
        const session = requireTenantForTable(this, 'Bulk delete');
        for (const key of keys) {
          assertTenantUnchanged(this, session.tenantId, 'Bulk delete');
          const record = await originalGet.call(this, key);
          if (record && (!record.tenantId || record.tenantId !== session.tenantId)) {
            throw new Error(`FAIL_CLOSED: Unauthorized bulk delete target on '${this.name}'.`);
          }
        }
        for (const key of keys) {
          assertTenantUnchanged(this, session.tenantId, 'Bulk delete');
          const record = await originalGet.call(this, key);
          if (record) {
            assertTenantUnchanged(this, session.tenantId, 'Bulk delete');
            await originalDelete.call(this, key);
          }
        }
      });
    };
  }

  if (originalClear && originalToArray && originalDelete) {
    TableProto.clear = function(this: any) {
      if (!isTenantScoped(this)) return originalClear.call(this);
      return this.db.transaction('rw', this, async () => {
        const session = requireTenantForTable(this, 'Clear');
        const owner = SYNC_OWNED_TABLES.has(this.name) ? getTrustedSyncOwner() : null;
        if (SYNC_OWNED_TABLES.has(this.name) && !owner) {
          throw new Error("FAIL_CLOSED: Sync table clear requires an authenticated tenant/user owner.");
        }
        const records = hasTenantIndex(this)
          ? await this.where('tenantId').equals(session.tenantId).toArray()
          : await originalToArray.call(this);
        assertTenantUnchanged(this, session.tenantId, 'Clear');
        for (const record of records) {
          const isVisible = SYNC_OWNED_TABLES.has(this.name)
            ? record?.tenantId === owner!.tenantId && record?.userId === owner!.userId
            : record?.tenantId === session.tenantId;
          if (isVisible) {
            if (owner) {
              const currentOwner = getTrustedSyncOwner();
              if (!currentOwner || currentOwner.tenantId !== owner.tenantId || currentOwner.userId !== owner.userId) {
                throw new Error("FAIL_CLOSED: Sync table owner changed during clear.");
              }
            }
            assertTenantUnchanged(this, session.tenantId, 'Clear');
            const key = extractPrimaryKey(this, record);
            await originalDelete.call(this, key);
          }
        }
      });
    };
  }
}

/**
 * Install tenant Collection guards on the constructors owned by this Dexie
 * instance. Dexie creates per-instance Collection classes; patching the static
 * Dexie.Collection prototype does not protect Collections created by db.where().
 */
const patchedTenantCollectionPrototypes = new WeakSet<object>();

function installTenantCollectionGuards(dbInstance: Dexie) {
  const CollectionProto = (dbInstance as any).Collection?.prototype;
  if (!CollectionProto) {
    throw new Error('[SECURITY] Instance Dexie Collection prototype is unavailable; tenant collection guards cannot initialize.');
  }
  if (patchedTenantCollectionPrototypes.has(CollectionProto)) return;

  const originalToArray = CollectionProto.toArray;
  const originalEach = CollectionProto.each;
  if (typeof originalToArray !== 'function' || typeof originalEach !== 'function') {
    throw new Error('[SECURITY] Instance Dexie Collection guards cannot initialize; required methods are missing.');
  }

  const collectionTable = (collection: any) => collection?._ctx?.table;
  const hasTenantIndex = (table: any) => (table?.schema?.indexes || []).some((index: any) =>
    index?.keyPath === 'tenantId'
  );
  const isTenantScoped = (table: any) => TENANT_SCOPED_TABLES.has(table?.name) ||
    hasTenantIndex(table) || (table?.schema?.indexes || []).some((index: any) =>
      Array.isArray(index?.keyPath) && index.keyPath.includes('tenantId')
    );
  const collectionSession = (collection: any, operation: string) => {
    const table = collectionTable(collection);
    if (!isTenantScoped(table)) return null;
    return { table, session: requireTenantForTable(table, operation) };
  };
  const assertCollectionSession = (scope: any, operation: string) => {
    if (scope) assertTenantUnchanged(scope.table, scope.session.tenantId, operation);
  };
  const forEachVisibleRecord = (
    collection: any,
    operation: string,
    callback: (record: any, cursor: any) => any
  ) => {
    const scope = collectionSession(collection, operation);
    if (!scope) return originalEach.call(collection, callback);
    return originalEach.call(collection, (record: any, cursor: any) => {
      assertCollectionSession(scope, operation);
      if (!record || record.tenantId !== scope.session.tenantId) return;
      return callback(record, cursor);
    }).then((result: any) => {
      assertCollectionSession(scope, operation);
      return result;
    });
  };

  CollectionProto.toArray = function(this: any, callback?: (records: any[]) => any) {
    const scope = collectionSession(this, 'Collection read');
    if (!scope) return originalToArray.call(this, callback);
    return originalToArray.call(this).then((records: any[]) => {
      assertCollectionSession(scope, 'Collection read');
      const visible = records.filter(record => record?.tenantId === scope.session.tenantId);
      if (typeof callback === 'function') callback(visible);
      return visible;
    });
  };

  if (typeof CollectionProto.first === 'function') {
    CollectionProto.first = function(this: any, callback?: (record: any) => any) {
      return this.toArray().then((records: any[]) => {
        const first = records[0];
        if (typeof callback === 'function') callback(first);
        return first;
      });
    };
  }

  if (typeof CollectionProto.last === 'function') {
    CollectionProto.last = function(this: any, callback?: (record: any) => any) {
      return this.reverse().toArray().then((records: any[]) => {
        const last = records[0];
        if (typeof callback === 'function') callback(last);
        return last;
      });
    };
  }

  if (typeof CollectionProto.count === 'function') {
    CollectionProto.count = function(this: any, callback?: (count: number) => any) {
      return this.toArray().then((records: any[]) => {
        const count = records.length;
        if (typeof callback === 'function') callback(count);
        return count;
      });
    };
  }

  CollectionProto.each = function(this: any, callback: (record: any, cursor: any) => any) {
    if (typeof callback !== 'function') throw new TypeError('Collection.each requires a callback.');
    return forEachVisibleRecord(this, 'Collection iteration', callback);
  };

  // Dexie also exposes key-only iterators. They must use the same tenant-filtered
  // cursor path because keys and primary keys can disclose cross-tenant metadata.
  if (typeof CollectionProto.eachKey === 'function') {
    CollectionProto.eachKey = function(this: any, callback: (key: any, cursor: any) => any) {
      if (typeof callback !== 'function') throw new TypeError('Collection.eachKey requires a callback.');
      return forEachVisibleRecord(this, 'Collection key iteration', (_record, cursor) =>
        callback(cursor?.key, cursor)
      );
    };
  }
  if (typeof CollectionProto.eachPrimaryKey === 'function') {
    CollectionProto.eachPrimaryKey = function(this: any, callback: (key: any, cursor: any) => any) {
      if (typeof callback !== 'function') throw new TypeError('Collection.eachPrimaryKey requires a callback.');
      return forEachVisibleRecord(this, 'Collection primary-key iteration', (_record, cursor) =>
        callback(cursor?.primaryKey, cursor)
      );
    };
  }
  if (typeof CollectionProto.eachUniqueKey === 'function') {
    CollectionProto.eachUniqueKey = function(this: any, callback: (key: any, cursor: any) => any) {
      if (typeof callback !== 'function') throw new TypeError('Collection.eachUniqueKey requires a callback.');
      const seen: any[] = [];
      return forEachVisibleRecord(this, 'Collection unique-key iteration', (_record, cursor) => {
        const key = cursor?.key;
        if (key === undefined || seen.some(previous => indexedDB.cmp(previous, key) === 0)) return;
        seen.push(key);
        return callback(key, cursor);
      });
    };
  }

  if (typeof CollectionProto.sortBy === 'function') {
    CollectionProto.sortBy = function(this: any, keyPath: string, callback?: (records: any[]) => any) {
      return this.toArray().then((records: any[]) => {
        const sorted = records.sort((a, b) =>
          a?.[keyPath] < b?.[keyPath] ? -1 : a?.[keyPath] > b?.[keyPath] ? 1 : 0
        );
        if (typeof callback === 'function') callback(sorted);
        return sorted;
      });
    };
  }

  // Keys are metadata too: prevent enumeration of another tenant's index or
  // primary keys through Collection.keys()/primaryKeys()/uniqueKeys().
  const collectCursorValues = (
    collection: any,
    property: 'key' | 'primaryKey',
    operation: string,
    unique: boolean
  ) => {
    const values: any[] = [];
    const seen = new Set<any>();
    return forEachVisibleRecord(collection, operation, (_record, cursor) => {
      const value = cursor?.[property];
      if (value !== undefined && (!unique || !seen.has(value))) {
        values.push(value);
        seen.add(value);
      }
    }).then(() => values);
  };
  if (typeof CollectionProto.keys === 'function') {
    CollectionProto.keys = function(this: any) {
      return collectCursorValues(this, 'key', 'Collection key read', false);
    };
  }
  if (typeof CollectionProto.primaryKeys === 'function') {
    CollectionProto.primaryKeys = function(this: any) {
      return collectCursorValues(this, 'primaryKey', 'Collection primary-key read', false);
    };
  }
  if (typeof CollectionProto.uniqueKeys === 'function') {
    CollectionProto.uniqueKeys = function(this: any) {
      return collectCursorValues(this, 'key', 'Collection unique-key read', true);
    };
  }

  patchedTenantCollectionPrototypes.add(CollectionProto);
}

export function getCurrentUserSession() {
  try {
    const session = TokenProvider.getCurrentSession();
    if (session?.user) {
      return {
        tenantId: session.tenantId || session.user.tenantId || session.user.tenant_id,
        branchId: session.branchId || session.user.branchId || session.user.branch_id,
        userId: session.user?.id || (session.user as any)?.user_id
      };
    }
  } catch (e) {
    console.error('[DB] Error reading user session from TokenProvider:', e);
  }
  return {
    tenantId: undefined,
    branchId: undefined,
    userId: undefined
  };
}

/**
 * Returns a sync owner only when the active auth state is authenticated and
 * its token identity exactly matches the normalized application session.
 * A stale user object or tenant context alone is never sufficient.
 */
export function getTrustedSyncOwner(): { tenantId: string; userId: string; branchId?: string } | null {
  try {
    const auth = TokenProvider.getCurrentSession();
    const session = getCurrentUserSession();
    const user = auth?.user as any;
    const primaryUserId = typeof user?.id === 'string' ? user.id.trim() : '';
    const legacyUserId = typeof user?.user_id === 'string' ? user.user_id.trim() : '';
    const primaryTenantId = typeof user?.tenantId === 'string' ? user.tenantId.trim() : '';
    const legacyTenantId = typeof user?.tenant_id === 'string' ? user.tenant_id.trim() : '';
    const authTenantId = typeof auth?.tenantId === 'string' ? auth.tenantId.trim() : '';
    const authUserId = primaryUserId || legacyUserId;
    const authResolvedTenantId = authTenantId || primaryTenantId || legacyTenantId;

    if (
      auth?.isAuthenticated !== true ||
      typeof auth.token !== 'string' ||
      !auth.token.trim() ||
      !authUserId ||
      !authResolvedTenantId ||
      (primaryUserId && legacyUserId && primaryUserId !== legacyUserId) ||
      (primaryTenantId && legacyTenantId && primaryTenantId !== legacyTenantId) ||
      (authTenantId && primaryTenantId && authTenantId !== primaryTenantId) ||
      (authTenantId && legacyTenantId && authTenantId !== legacyTenantId) ||
      session.userId !== authUserId ||
      session.tenantId !== authResolvedTenantId
    ) {
      return null;
    }

    return {
      tenantId: authResolvedTenantId,
      userId: authUserId,
      branchId: session.branchId
    };
  } catch {
    return null;
  }
}
import { 
  Product, UnifiedInvoice, InvoiceItem, Account, AccountingEntry, JournalEntry, InvoiceStatus, Customer, Supplier, 
  JournalLine, InventoryTransaction, AccountingPeriod, SystemBackup, ValidationRule,
  VoucherInvoiceLink as Voucher, AuditLogEntry as AuditLog, Currency
} from '@/types';
import { 
  ProductReadModel, InventoryReadModel, InvoiceReadModel, 
  LedgerReadModel, AggregateSnapshot 
} from '@features/events/read.types';

/**
 * PharmaFlow PRO ERP Database Core
 * Robust, production-grade Dexie implementation with strict schema versioning.
 */

export class PharmaFlowDB extends Dexie {
  // Strongly typed tables
  products!: Table<Product>;
  invoices!: Table<UnifiedInvoice>;
  invoiceItems!: Table<InvoiceItem>;
  accounts!: Table<Account>;
  journalEntries!: Table<AccountingEntry>;
  journalLines!: Table<JournalLine>;
  inventoryTransactions!: Table<InventoryTransaction>;
  accountingPeriods!: Table<AccountingPeriod>;
  customers!: Table<any>;
  suppliers!: Table<any>;
  vouchers!: Table<Voucher>;
  auditLogs!: Table<AuditLog>;
  settings!: Table<{ key: string; value: any }>;
  users!: Table<any, string>;
  userPermissions!: Table<any, string>;
  systemSettings!: Table<{ key: string; value: any }>;
  medicineBatches!: Table<any>;
  exchangeRates!: Table<any>;
  systemBackups!: Table<SystemBackup>;

  // Multi-branch Tables
  branches!: Table<any>;
  branchSettings!: Table<any>;
  branchInventory!: Table<any>;
  branchTransfers!: Table<any>;
  branchTransferItems!: Table<any>;
  branchUsers!: Table<any>;
  
  // Legacy / Compatibility Tables (added to satisfy linter and services)
  sales!: Table<any>;
  purchases!: Table<any>;
  categories!: Table<any>;
  receipts!: Table<any>;
  payments!: Table<any>;
  settlements!: Table<any>;
  cashFlow!: Table<any>;
  cashboxes!: Table<any, string>;
  priceHistory!: Table<any>;
  inventory!: Table<any>;
  invoiceAdjustments!: Table<any>;
  systemAlerts!: Table<any>;
  financialHealthSnapshots!: Table<any>;
  historicalMetrics!: Table<any>;
  voucherInvoiceLinks!: Table<any>;
  financialTransactions!: Table<any>;
  warehouseStock!: Table<any>;
  inventory_layers!: Table<any>;
  fifo_consumption_log!: Table<any>;
  itemUsageLog!: Table<any>;
  stock_movements!: Table<any>;
  inventory_logs!: Table<any>;
  Audit_Log!: Table<any>;
  Accounting_Periods!: Table<any>;
  purchasesByItem!: Table<any>;
  profitHealth!: Table<any>;
  aiInsights!: Table<any>;
  dailyAuditTasks!: Table<any>;
  auditProgress!: Table<any>;
  itemProfits!: Table<any>;
  supplierProfits!: Table<any>;
  profit_health!: Table<any>;
  systemPerformanceLog!: Table<any>;
  cash_logs!: Table<any>;
  System_Error_Log!: Table<any>;

  // Phase 3 Offline Sync Engine Tables
  sync_queue!: Table<any>;
  sync_logs!: Table<any>;
  sync_failures!: Table<any>;
  sync_conflicts!: Table<any>;
  sync_snapshots!: Table<any>;

  // Phase 3.2 camelCase Sync Engine Tables
  syncQueue!: Table<any>;
  syncEvents!: Table<any>;
  failedMutations!: Table<any>;
  outbox!: Table<any>;
  syncLogs!: Table<any>;

  // Phase 3.4 Event Sourcing Tables
  eventStore!: Table<any>;

  // Phase 3.5 CQRS Schema Tables
  readProducts!: Table<ProductReadModel, string>;
  readInventory!: Table<InventoryReadModel, string>;
  readInvoices!: Table<InvoiceReadModel, string>;
  readLedgers!: Table<LedgerReadModel, string>;
  aggregateSnapshots!: Table<AggregateSnapshot, [string, number]>;

  // Phase 5.2.1 tables
  system_errors!: Table<any>;
  drafts!: Table<any>;

  // Phase 5.2.5-C - Smart Auto Save Draft Engine
  draft_invoices!: Table<any>;

  // Phase 5.2.7-C - Invoice Posting Idempotency Engine
  idempotencyKeys!: Table<any>;

  // Phase 5.2.7-D - Event Driven Report Projections
  projectionCheckpoints!: Table<any>;
  projectionEvents!: Table<any>;

  // Phase 2.3 - Smart Import Alias Learning Tables
  supplierAliases!: Table<any>;
  productAliases!: Table<any>;
  supplierProductReferences!: Table<any>;
  aliasRejections!: Table<any>;
  aliasAuditLogs!: Table<any>;

  // Phase 3.3 - Controlled Inventory Correction & Human Resolution Tables
  inventoryCorrectionCases!: Table<any>;

  // Phase 3.4.6 - Enterprise Observability & Diagnostics Tables
  system_diagnostics!: Table<any>;
  error_aggregates!: Table<any>;
  recovery_events!: Table<any>;
  system_health!: Table<any>;

  // Phase 3.4.7 - Enterprise Data Integrity & Idempotency Hardening Tables
  integrity_audit_logs!: Table<any>;
  integrity_repair_records!: Table<any>;
  idempotency_records!: Table<any>;

  // Legacy support for code that uses db.db
  get db(): PharmaFlowDB { return this; }

  constructor(dbName: string = 'PharmaFlowPRO') {
    super(dbName);

    // VERSION 12: Complete defensive schema with comprehensive indexes for all query casings (camel/snake/Pascal)
    this.version(12).stores({
      products: '&id, name, Name, barcode, categoryId, supplierId, stock, is_active, Is_Active, updated_at',
      invoices: '&id, invoice_number, date, Date, partner_id, partnerId, type, payment_status, financial_status, document_status, is_synced, createdAt',
      invoiceItems: '&id, parent_id, product_id, [parent_id+product_id]',
      accounts: '&id, code, name, type, parent_id, is_system, balance',
      journalEntries: '&id, date, source_id, sourceId, source_type, status, created_at, reference_id, referenceId, partnerId, partner_id',
      journalLines: '&id, entry_id, entryId, account_id, accountId, [entry_id+account_id], [entryId+accountId]',
      inventoryTransactions: '&id, product_id, productId, warehouse_id, source_doc_id, transaction_type, transaction_date',
      accountingPeriods: '&id, Start_Date, End_Date, Is_Locked, start_date, end_date, is_locked',
      customers: '&id, name, Name, phone, balance, is_active, Is_Active',
      suppliers: '&id, name, Name, phone, balance, is_active, Is_Active',
      vouchers: '&id, voucher_id, type, partner_id, partnerId, date, status, invoiceId, invoice_id',
      auditLogs: '&id, timestamp, user_id, action, target_type, target_id, Modified_At, Record_ID',
      settings: '&key',
      medicineBatches: '&id, productId, batchNumber, expiryDate',
      exchangeRates: '&id, fromCurrency, toCurrency, date',
      systemBackups: '&id, backupName, createdAt, backupType',
      
      // Compatibility Stores
      sales: '&id, invoice_number, date, Date, InvoiceStatus, hash, SaleID, createdAt, transactionUuid',
      purchases: '&id, invoice_number, date, Date, invoiceStatus, hash, createdAt, transactionUuid',
      categories: '&id, categoryId, categoryName',
      receipts: '&id, voucher_id',
      payments: '&id, voucher_id',
      settlements: '&id, voucherId',
      cashFlow: '&id, transaction_id, date',
      priceHistory: '&id, productId',
      inventory: '&id',
      invoiceAdjustments: '&id, InvoiceID',
      systemAlerts: '&id, type, timestamp, isRead',
      financialHealthSnapshots: '&id, date',
      historicalMetrics: '&id, month',
      voucherInvoiceLinks: '&id, voucherId, invoiceId',
      financialTransactions: '&id, Reference_ID, Entity_Name',
      warehouseStock: '&id, productId, warehouseId, [warehouseId+productId], [warehouse_id+product_id]',
      inventory_layers: '&id, productId, item_id, reference_id',
      fifo_consumption_log: '&id, saleId, sale_id',
      itemUsageLog: '&id, productId',
      stock_movements: '&id, product_id, item_id, reference_id',
      inventory_logs: '&id, product_id',
      Audit_Log: '&id, timestamp, user_id, action, target_type, target_id, Modified_At, Record_ID',
      Accounting_Periods: '&id, start_date, end_date',
      purchasesByItem: '&id, product_id, productId',
      profitHealth: '&id, date',
      aiInsights: '&id, date',
      dailyAuditTasks: '&id, date',
      auditProgress: '&id, taskId',
      itemProfits: '&id, product_id',
      supplierProfits: '&id, partner_id',
      profit_health: '&id, date',
      systemPerformanceLog: '&id, operation',
      cash_logs: '&id, type, date',
      System_Error_Log: '&id, Error_ID, Module_Name'
    });

    // Version 13: Phase 3 Offline Sync Engine schema update
    this.version(13).stores({
      sync_queue: '&id, type, priority, idempotencyKey, timestamp, status',
      sync_logs: '&id, timestamp, mutationId, idempotencyKey',
      sync_failures: '&id, mutationId, timestamp',
      sync_conflicts: '&id, type, timestamp',
      sync_snapshots: '&id, entityId, timestamp'
    });

    // Version 14: Phase 3.2 Offline Sync Engine camelCase table extensions
    this.version(14).stores({
      syncQueue: '++id,&idempotencyKey,mutationId,[syncStatus+createdAt],[entityType+createdAt]',
      syncEvents: '++id, eventId, sequence, createdAt',
      failedMutations: '++id, mutationId, createdAt'
    });

    // Version 15: Phase 3.4 Event Sourcing Tables
    this.version(15).stores({
      eventStore: '++id, eventId, aggregateId, aggregateType, eventType, createdAt, [aggregateType+aggregateId]'
    });

    // Version 16: Phase 3.5 CQRS Schema Extensions
    this.version(16).stores({
      readProducts: 'productId, sku, category',
      readInventory: 'batchId, productId, expiryDate, [productId+expiryDate]',
      readInvoices: 'invoiceId, invoiceNumber, status, createdAt',
      readLedgers: 'accountNumber, currentBalance',
      aggregateSnapshots: '[aggregateId+version], aggregateType',
    });

    // Version 17: Phase 4.1 Multi-Branch Architecture
    this.version(17).stores({
      branches: '&id, code, name, isActive',
      branchSettings: '&id, branchId',
      branchInventory: '&id, branchId, productId, [branchId+productId]',
      branchTransfers: '&id, transferNumber, sourceBranchId, targetBranchId, status, createdAt',
      branchTransferItems: '&id, transferId, productId, [transferId+productId]',
      branchUsers: '&id, branchId, userId, [branchId+userId]'
    });

    // Version 18: Phase 5.2.1 - Production Hardening & Play Readiness
    this.version(18).stores({
      system_errors: '&id, errorId, timestamp, severity, moduleName, screenName',
      drafts: '&id, moduleName, updatedAt',
      invoices: '&id, invoice_number, date, Date, partner_id, partnerId, type, payment_status, financial_status, document_status, is_synced, createdAt, transactionUuid'
    });

    // Version 19: Phase 5.2.5-C - Smart Auto Save Draft Engine
    this.version(19).stores({
      draft_invoices: '&draftId, invoiceType, updatedAt'
    });

    // Version 20: Phase 5.2.7-C - Invoice Posting Idempotency Engine
    this.version(20).stores({
      idempotencyKeys: '&id, status, createdAt, completedAt'
    });

    // Version 21: Phase 5.2.7-D - Event Driven Report Projections
    this.version(21).stores({
      projectionCheckpoints: '&id, sequence, lastProcessedEventId, updatedAt',
      projectionEvents: '++id, eventId, eventType, aggregateId, createdAt, status'
    });

    // Version 22: Security and local lifecycle settings persistence
    this.version(22).stores({
      systemSettings: '&key'
    });

    // Version 23: Production-Grade Sync Engine
    this.version(23).stores({
      outbox: '++id, &mutationId, &idempotencyKey, status, type, createdAt, [status+createdAt]',
      syncLogs: '++id, action, mutationId, timestamp'
    });

    // Version 24: Dexie Query Optimization - Compound Indexes for Invoices
    this.version(24).stores({
      invoices: '&id, invoice_number, invoiceNumber, date, Date, partner_id, partnerId, type, payment_status, financial_status, document_status, is_synced, createdAt, transactionUuid, [type+partner_id], [type+partnerId], [type+invoice_number], [type+invoiceNumber]'
    });

    // Version 25: Index transactionUuid on sales and purchases
    this.version(25).stores({
      sales: '&id, invoice_number, date, Date, InvoiceStatus, hash, SaleID, createdAt, transactionUuid',
      purchases: '&id, invoice_number, date, Date, invoiceStatus, hash, createdAt, transactionUuid'
    });

    // Version 26: Index productId, parentId, invoiceId on invoiceItems
    this.version(26).stores({
      invoiceItems: '&id, parent_id, parentId, invoice_id, invoiceId, product_id, productId, [parent_id+product_id], [parentId+productId], [invoice_id+product_id], [invoiceId+productId]'
    });

    // Version 27: Phase 8.1 - Offline Multi-Tenant Composite Key Architecture & Data Isolation
    this.version(27).stores({
      products: '&id, name, Name, barcode, sku, ProductID, categoryId, supplierId, is_active, Is_Active, stock, StockQuantity, updatedAt, tenantId, [tenantId+id], [tenantId+barcode], [tenantId+sku], [tenantId+categoryId]',
      invoices: '&id, invoice_number, invoiceNumber, date, Date, partner_id, partnerId, type, payment_status, financial_status, document_status, is_synced, createdAt, transactionUuid, tenantId, branchId, [tenantId+id], [tenantId+invoiceNumber], [tenantId+invoice_number], [tenantId+type], [tenantId+branchId], [tenantId+partnerId], [tenantId+partner_id], [type+partner_id], [type+partnerId], [type+invoice_number], [type+invoiceNumber]',
      sales: '&id, invoice_number, date, Date, InvoiceStatus, hash, SaleID, createdAt, transactionUuid, tenantId, branchId, [tenantId+id], [tenantId+invoice_number], [tenantId+branchId]',
      purchases: '&id, invoice_number, date, Date, invoiceStatus, hash, createdAt, transactionUuid, tenantId, branchId, [tenantId+id], [tenantId+invoice_number], [tenantId+branchId]',
      customers: '&id, name, Name, phone, email, is_active, Is_Active, tenantId, [tenantId+id], [tenantId+phone]',
      suppliers: '&id, name, Name, phone, email, is_active, Is_Active, tenantId, [tenantId+id], [tenantId+phone]',
      journalEntries: '&id, date, sourceId, source_id, referenceId, reference_id, partnerId, sourceType, status, createdAt, tenantId, branchId, [tenantId+id], [tenantId+branchId], [tenantId+date]',
      accounts: '&id, code, name, type, parentId, tenantId, [tenantId+id], [tenantId+code]',
      syncQueue: '++id, &idempotencyKey, mutationId, syncStatus, tenantId, [tenantId+id], [tenantId+syncStatus], [syncStatus+createdAt], [entityType+createdAt]',
      outbox: '++id, &mutationId, &idempotencyKey, status, type, tenantId, createdAt, [tenantId+status], [status+createdAt]'
    });

    // Version 28: Defensive Product & Entity Schema Upgrade - Indexing Name, ProductID, Is_Active
    this.version(28).stores({
      products: '&id, name, Name, barcode, sku, ProductID, categoryId, supplierId, is_active, Is_Active, stock, StockQuantity, updatedAt, tenantId, [tenantId+id], [tenantId+barcode], [tenantId+sku], [tenantId+categoryId], [tenantId+name], [tenantId+Name]',
      customers: '&id, name, Name, phone, email, is_active, Is_Active, tenantId, [tenantId+id], [tenantId+phone]',
      suppliers: '&id, name, Name, phone, email, is_active, Is_Active, tenantId, [tenantId+id], [tenantId+phone]'
    });

    // Version 29: Phase 2.3 - Smart Import Alias Learning System Multi-Tenant Schema & Indexes
    this.version(29).stores({
      supplierAliases: '&id, tenantId, branchId, supplierId, aliasNormalized, [tenantId+supplierId+aliasNormalized], [tenantId+aliasNormalized]',
      productAliases: '&id, tenantId, branchId, supplierId, productId, aliasNormalized, isGlobal, [tenantId+supplierId+aliasNormalized], [tenantId+aliasNormalized], [tenantId+productId]',
      supplierProductReferences: '&id, tenantId, supplierId, productId, supplierProductCode, [tenantId+supplierId+supplierProductCode], [tenantId+productId]',
      aliasRejections: '&id, tenantId, supplierId, aliasNormalized, rejectedProductId, [tenantId+supplierId+aliasNormalized+rejectedProductId], [tenantId+rejectedProductId]',
      aliasAuditLogs: '&id, tenantId, timestamp, action, aliasType, supplierId, productId, [tenantId+timestamp]'
    });

    // Version 30: Phase 3.3 - Controlled Inventory Correction & Human Resolution Schema
    this.version(30).stores({
      inventoryCorrectionCases: '&id, caseNumber, tenantId, branchId, productId, discrepancyType, status, createdAt, [tenantId+status], [tenantId+branchId+status], [tenantId+productId], [tenantId+caseNumber]'
    });

    // Version 31: Phase 3.4.6 - Enterprise Observability, Diagnostics & Recovery Schema
    this.version(31).stores({
      system_diagnostics: '&id, errorId, correlationId, fingerprint, category, severity, tenantId, timestamp, [tenantId+severity], [tenantId+category]',
      error_aggregates: '&fingerprint, category, severity, tenantId, count, lastSeenAt, [tenantId+category]',
      recovery_events: '&id, correlationId, strategy, status, tenantId, timestamp, [tenantId+status]',
      system_health: '&id, overall, mode, timestamp'
    });

    // Version 32: Phase 3.4.7 - Enterprise Data Integrity & Idempotency Hardening Schema
    this.version(32).stores({
      integrity_audit_logs: '&id, operationId, idempotencyKey, fingerprint, tenantId, branchId, status, startedAt, [tenantId+branchId+status]',
      integrity_repair_records: '&id, repairId, status, tenantId, branchId, timestamp, [tenantId+status]',
      idempotency_records: '&key, status, tenantId, branchId, operationType, fingerprint, createdAt, [tenantId+branchId+status]'
    });

    // Version 33: Users and user permissions schema
    this.version(33).stores({
      users: '&id, username, role, status, branch, createdAt',
      userPermissions: '&id, userId'
    });

    // Version 34: Cashboxes and optional cash movement/user associations
    this.version(34).stores({
      cashboxes: '&id, name, accountId, branchId, isActive',
      users: '&id, username, role, status, branch, createdAt, cashboxId',
      cashFlow: '&id, transaction_id, date, type, cashboxId, userId'
    });

    // Version 35: Cashbox opening-balance traceability
    this.version(35).stores({
      cashboxes: '&id, name, accountId, branchId, isActive, openingBalance, openingBalanceJournalId'
    });

    // Version 36: Tenant Isolation Hardening for Cash Flow and Financial Monitoring
    // Note: We avoid compound indexes on potentially optional fields to prevent DataError in some environments
    this.version(36).stores({
      cashFlow: '&id, transaction_id, date, type, cashboxId, userId, tenantId',
      financialHealthSnapshots: '&id, date, tenantId',
      systemAlerts: '&id, type, timestamp, isRead, tenantId',
      accountingPeriods: '&id, Start_Date, End_Date, Is_Locked, start_date, end_date, is_locked, tenantId',
      vouchers: '&id, voucher_id, type, partner_id, partnerId, date, status, tenantId, branchId'
    });

    // Version 37: Tenant-scoped lookup indexes for security-sensitive collections.
    // Index creation is additive; existing records are not assigned to a tenant here.
    this.version(37).stores({
      users: '&id, username, role, status, branch, createdAt, cashboxId, tenantId, [tenantId+username]',
      userPermissions: '&id, userId, tenantId, [tenantId+userId]',
      cashboxes: '&id, name, accountId, branchId, isActive, openingBalance, openingBalanceJournalId, tenantId',
      cashFlow: '&id, transaction_id, date, type, cashboxId, userId, tenantId, [tenantId+cashboxId], [tenantId+userId]',
      financialHealthSnapshots: '&id, date, tenantId, [tenantId+date]',
      systemAlerts: '&id, type, timestamp, isRead, tenantId, [tenantId+type]',
      accountingPeriods: '&id, Start_Date, End_Date, Is_Locked, start_date, end_date, is_locked, tenantId, [tenantId+Is_Locked]'
    });

    // Version 38: Preserve tenant-less legacy data as Orphan records.
    // Never infer ownership from whichever tenant happens to be logged in.
    this.version(38).stores({
      journalLines: '&id, entry_id, entryId, account_id, accountId, [entry_id+account_id], [entryId+accountId], tenantId, branchId'
    }).upgrade(async () => {
      // Existing tenant-less records remain untouched for manual ownership review.
    });

    // Handle structural integrity and recovery
    this.on('versionchange', () => {
      console.warn("Database structure updated in another tab. Switching to resilient mode.");
      try {
        this.close();
      } catch (e) {}
      isDbBlocked = true;
    });

    // Register hooks on the explicit tenant allow-list and every schema table
    // declaring a tenantId index. Registration failures abort construction.
    const tenantScopedTableNames = new Set(TENANT_SCOPED_TABLES);
    for (const table of this.tables) {
      const hasTenantIndex = (table.schema.indexes || []).some((index: any) =>
        index?.keyPath === 'tenantId' ||
        (Array.isArray(index?.keyPath) && index.keyPath.includes('tenantId'))
      );
      if (hasTenantIndex) tenantScopedTableNames.add(table.name);
    }

    tenantScopedTableNames.forEach(tableName => {
      const table = this.table(tableName);
      if (!table) {
        throw new Error(`[SECURITY] Required tenant-scoped table '${tableName}' is missing.`);
      }

      table.hook('creating', (_primKey: any, obj: any) => {
        assertTenantAdminForUserManagement(tableName);
        const session = getCurrentUserSession();
        if (!session.tenantId) {
          console.error(`[SECURITY] Creation blocked on table '${tableName}': No active tenant session.`);
          throw new Error("FAIL_CLOSED: Creation forbidden without active tenant session.");
        }
        if (obj && typeof obj === 'object') {
          ensureItemPrimaryKey(table, obj);
          if (SYNC_OWNED_TABLES.has(tableName)) {
            const owner = getTrustedSyncOwner();
            if (!owner) {
              // Preserve explicitly ownerless legacy rows for reconciliation,
              // but never let a stale user object or supplied userId claim them.
              if (session.userId || obj.userId) {
                throw new Error("FAIL_CLOSED: Sync record creation requires an authenticated user/token identity.");
              }
              if (obj.tenantId && obj.tenantId !== session.tenantId) {
                throw new Error("FAIL_CLOSED: Legacy sync record tenant does not match the active tenant.");
              }
              obj.tenantId = session.tenantId;
              delete obj.userId;
              return;
            }
            if (
              (obj.tenantId && obj.tenantId !== owner.tenantId) ||
              (obj.userId && obj.userId !== owner.userId)
            ) {
              throw new Error("FAIL_CLOSED: Sync record creation owner must match the authenticated session.");
            }
            obj.tenantId = owner.tenantId;
            obj.userId = owner.userId;
            return;
          }
          obj.tenantId = session.tenantId;
          obj.userId = obj.userId || session.userId;
        }
      });

      table.hook('updating', (mods: any, _primKey: any, obj: any, transaction: Transaction) => {
        const session = getCurrentUserSession();
        const isSelfCredentialUpgrade = tableName === 'users' &&
          consumeSelfCredentialUpgradeCapability(tableName, mods, _primKey, obj, transaction, session);
        if (!isSelfCredentialUpgrade) assertTenantAdminForUserManagement(tableName);
        if (!session.tenantId) {
          console.error(`[SECURITY] Update blocked on table '${tableName}': No active tenant session.`);
          throw new Error("FAIL_CLOSED: Update forbidden without active tenant session.");
        }
        if (!obj || !obj.tenantId || obj.tenantId !== session.tenantId) {
          console.error(`[SECURITY] Cross-tenant or orphaned update blocked on table '${tableName}' for key:`, _primKey, "Target Tenant:", obj?.tenantId, "Active Session:", session.tenantId);
          throw new Error("FAIL_CLOSED: Unauthorized data modification attempt (Cross-tenant or Orphaned).");
        }
        if (mods && typeof mods === 'object') {
          if (Object.prototype.hasOwnProperty.call(mods, 'tenantId') && mods.tenantId !== obj.tenantId) {
            console.error(`[SECURITY] Attempt to change tenantId blocked on table '${tableName}'`);
            throw new Error("FAIL_CLOSED: tenantId modification is strictly forbidden.");
          }

          // Sync ownership is immutable and requires a live authenticated identity.
          // Never attach an owner to a legacy row or mutate another user's row.
          if (SYNC_OWNED_TABLES.has(tableName)) {
            const owner = getTrustedSyncOwner();
            const recordUserId = typeof obj.userId === 'string' && obj.userId.trim()
              ? obj.userId
              : undefined;
            if (
              !owner ||
              owner.tenantId !== obj.tenantId ||
              !recordUserId ||
              recordUserId !== owner.userId
            ) {
              throw new Error("FAIL_CLOSED: Sync record update requires its exact authenticated tenant/user owner.");
            }
            if (Object.prototype.hasOwnProperty.call(mods, 'userId') && mods.userId !== recordUserId) {
              throw new Error("FAIL_CLOSED: Sync record userId is immutable.");
            }
            return {
              ...mods,
              tenantId: owner.tenantId,
              userId: recordUserId
            };
          }

          return {
            ...mods,
            tenantId: session.tenantId,
            userId: mods.userId || obj.userId || session.userId
          };
        }
      });

      // Table.clear() bypasses collection-level tenant filtering. For
      // sync-owned tables, redefine it as an owner-scoped delete so one user's
      // cleanup can never enumerate or delete another user's rows.
      if (SYNC_OWNED_TABLES.has(tableName)) {
        (table as any).clear = () => {
          const owner = getTrustedSyncOwner();
          if (!owner) {
            throw new Error("FAIL_CLOSED: Sync table clear requires an authenticated tenant/user owner.");
          }
          return table
            .where('tenantId')
            .equals(owner.tenantId)
            .and((record: any) => record?.userId === owner.userId)
            .delete();
        };
      }

      table.hook('deleting', (_primKey: any, obj: any) => {
        assertTenantAdminForUserManagement(tableName);
        const session = getCurrentUserSession();
        if (!session.tenantId) {
          throw new Error("FAIL_CLOSED: Deletion forbidden without active tenant session.");
        }
        if (SYNC_OWNED_TABLES.has(tableName)) {
          const owner = getTrustedSyncOwner();
          if (!owner || owner.tenantId !== session.tenantId) {
            throw new Error("FAIL_CLOSED: Sync record deletion requires an authenticated tenant/user owner.");
          }
          if (obj && (obj.tenantId !== owner.tenantId || !obj.userId || obj.userId !== owner.userId)) {
            throw new Error("FAIL_CLOSED: Unauthorized sync record deletion outside the exact tenant/user owner.");
          }
          return;
        }
        // If obj is undefined, preserve Dexie's standard no-op delete behavior.
        if (obj && (!obj.tenantId || obj.tenantId !== session.tenantId)) {
          console.error(`[SECURITY] Delete blocked on table '${tableName}' for key:`, _primKey, "Record Tenant:", obj.tenantId, "Session Tenant:", session.tenantId);
          throw new Error("FAIL_CLOSED: Unauthorized data deletion attempt (Cross-tenant or Orphaned).");
        }
      });
    });

    installTenantCollectionGuards(this);
  }

  async getOrphanedTenantRecordCount(): Promise<number> {
    if (!this.isOpen()) await this.open();
    const scopedNames = new Set(TENANT_SCOPED_TABLES);
    for (const table of this.tables) {
      if ((table.schema.indexes || []).some((index: any) =>
        index?.keyPath === 'tenantId' || (Array.isArray(index?.keyPath) && index.keyPath.includes('tenantId'))
      )) {
        scopedNames.add(table.name);
      }
    }
    let total = 0;
    const nativeDb = (this as any).backendDB?.();
    if (!nativeDb) throw new Error('ORPHAN_AUDIT_UNAVAILABLE: Native IndexedDB handle is unavailable.');
    for (const tableName of scopedNames) {
      if (!nativeDb.objectStoreNames.contains(tableName)) continue;
      // Privileged aggregate-only audit: raw records never leave this method;
      // only the number of orphaned rows is returned to the administration UI.
      const records = await new Promise<any[]>((resolve, reject) => {
        const transaction = nativeDb.transaction(tableName, 'readonly');
        const request = transaction.objectStore(tableName).getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => reject(request.error || transaction.error || new Error('Orphan audit read failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('Orphan audit transaction aborted.'));
      });
      total += records.filter((record: any) => !record?.tenantId).length;
    }
    return total;
  }

  getExistingTableNames(): string[] {
    const actualTableNames = this.tables ? this.tables.map(t => t.name) : [];
    if (actualTableNames.length === 0) {
      return ALL_SCHEMA_TABLE_NAMES;
    }
    const nativeDB = (this as any).idbdb;
    if (nativeDB && nativeDB.objectStoreNames && nativeDB.objectStoreNames.length > 0) {
      const storeNames = Array.from(nativeDB.objectStoreNames) as string[];
      const filtered = actualTableNames.filter(t => storeNames.includes(t));
      return filtered.length > 0 ? filtered : actualTableNames;
    }
    return actualTableNames;
  }

  /**
   * Safe Transaction Helper: Provides atomic operations with automatic rollback.
   */
  async safeTransaction<T>(
    mode: 'r' | 'rw', 
    tables: string[] = [], 
    operation: (trans: Transaction) => Promise<T>
  ): Promise<T> {
    try {
      if (!this.isOpen()) await this.open();
      
      const existingTableNames = this.getExistingTableNames();
      const safeTables = tables || [];
      const validTables = safeTables.filter(t => existingTableNames.includes(t));
      
      // If we are in 'rw' mode and missing tables, we might have strict Dexie errors.
      // We log but proceed with available tables.
      if (validTables.length < safeTables.length) {
         console.warn(`[DB] Transaction tables missing: ${safeTables.filter(t => !existingTableNames.includes(t))}`);
      }

      // 1. Detect Nested Transaction Execution
      if ((Dexie as any).currentTransaction) {
        console.log("[DB] Re-using parent active transaction zone to prevent early commit");
        return await operation((Dexie as any).currentTransaction);
      }

      // 2. Wrap block using Dexie's explicit transaction system and return via Dexie promise chain
      return await this.transaction(mode as any, validTables.length > 0 ? validTables : existingTableNames, async (trans) => {
        // 🚨 تم إزالة حلقة الـ keepAlive الـ recursive التي كانت تحتجز قاعدة البيانات
        return await operation(trans);
      });
    } catch (error: any) {
      console.error("[DB] Atomic Transaction Failed:", error);
      const msg = error?.message || String(error);
      const shouldStandardize = 
        msg.includes("committed too early") || 
        msg.includes("Transaction committed") ||
        msg.includes("TransactionCompleted") ||
        msg.includes("Transaction aborted") ||
        msg.includes("inactive") ||
        error?.name === "TransactionCommittedTooEarlyError" ||
        error?.name === "TransactionAbortedError";
      
      if (shouldStandardize) {
        const erpError = new Error("تعذر إكمال العملية حالياً، يرجى إعادة المحاولة.");
        (erpError as any).technicalDetails = msg;
        throw erpError;
      }
      throw error; 
    }
  }

  generateId(prefix: string = 'ID'): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  async emergencyReset() {
    console.error("🛑 PERFORMING EMERGENCY DATABASE RESET...");
    await this.delete();
    if (typeof window !== 'undefined') window.location.reload();
  }

  async ensureOpen() {
    if (!this.isOpen()) await this.open();
  }

  // --- COMPATIBILITY LAYER ---
  async getAccounts() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.accounts.where('tenantId').equals(tenantId).toArray(); 
  }
  async getJournalEntries() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.journalEntries.where('tenantId').equals(tenantId).toArray(); 
  }
  async getAccountingPeriods() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.accountingPeriods.where('tenantId').equals(tenantId).toArray(); 
  }
  async getReceipts() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.receipts.where('tenantId').equals(tenantId).toArray();
  }
  async getPayments() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.payments.where('tenantId').equals(tenantId).toArray();
  }
  async getCustomers() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.customers.where('tenantId').equals(tenantId).toArray(); 
  }
  async getSuppliers() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.suppliers.where('tenantId').equals(tenantId).toArray(); 
  }
  async getCurrencies(): Promise<Currency[]> { return await this.getSetting('CURRENCIES', []) as Currency[]; }
  async getMedicineAlerts() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.systemAlerts
      .where('tenantId').equals(tenantId)
      .filter((alert: any) => alert.type === 'STOCK' || ['EXPIRY', 'LOW_STOCK', 'SEASONAL'].includes(alert.Type))
      .toArray();
  }
  async getDailyAuditTask(date: string) { return await this.dailyAuditTasks.where('date').equals(date).first(); }
  async createDailyAuditTask(task: any) { return await this.dailyAuditTasks.add(task); }
  async saveAuditProgress(progress: any) { return await this.auditProgress.put(progress); }
  async finalizeAudit(taskId: string, results: any) { return await this.dailyAuditTasks.update(taskId, { ...results, status: 'COMPLETED' }); }
  async clearOldAlerts() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) throw new Error('FAIL_CLOSED: Cannot clear alerts without an active tenant session.');
    return await this.systemAlerts.where('tenantId').equals(tenantId)
      .filter((alert: any) => alert.type === 'STOCK' || ['EXPIRY', 'LOW_STOCK', 'SEASONAL'].includes(alert.Type)).delete();
  }
  
  async saveCustomer(customer: Customer) { return await this.customers.put(customer); }
  async saveSupplier(supplier: Supplier) { return await this.suppliers.put(supplier); }
  async saveProduct(product: Product) { return await this.products.put(product); }
  async softDeleteProduct(id: string) { return await this.products.update(id, { is_active: false }); }
  async saveAccount(account: Account) { return await this.accounts.put(account); }
  async deleteAccount(id: string) { return await this.accounts.delete(id); }
  async addJournalEntry(entry: JournalEntry) { return await this.journalEntries.add(entry); }
  async addJournalEntryLegacy(entry: JournalEntry) { return await this.journalEntries.add(entry); }
  async saveSettlement(settlement: Record<string, unknown>) { return await this.settlements.put(settlement); }
  async getCurrentBranchId() { return 'MAIN'; }
  async updatePurchaseNotes(id: string, notes: string) { return await this.invoices.update(id, { notes }); }
  async updatePurchaseAttachment(id: string, attachment: string) { return await this.invoices.update(id, { attachment }); }
  async updateSaleNotes(id: string, notes: string) { return await this.invoices.update(id, { notes }); }
  async updateSaleAttachment(id: string, attachment: string) { return await this.invoices.update(id, { attachment }); }
  async getInvoiceHistory(invoiceId: string) {
    const logs = await this.Audit_Log.where('target_id').equals(invoiceId).toArray();
    return logs.map((l: AuditLog) => ({
      id: l.id,
      invoiceId: l.target_id || '',
      userId: l.user_id || '',
      userName: (l as any).userName || (l as any).user_name || 'مستخدم النظام',
      timestamp: l.timestamp || new Date().toISOString(),
      action: (l.action === 'CREATE' ? 'CREATED' : l.action === 'POST' ? 'POSTED' : l.action) as 'CREATED' | 'POSTED' | string,
      details: l.details || `تمت عملية ${l.action} على المستند`
    }));
  }
  async updateSupplierBalance(id: string, delta: number, tx?: any) {
  const suppliersTable = tx ? tx.table('suppliers') : this.suppliers;

  const supp = await suppliersTable.get(id);

  if (!supp) {
    throw new Error(
      `SUPPLIER_NOT_FOUND: المورد [${id}] غير موجود لتحديث الرصيد.`
    );
  }

  const newBalance =
    Math.round(((Number(supp.balance) || 0) + delta) * 100) / 100;

  await suppliersTable.update(id, {
    balance: newBalance
  });

  return newBalance;
  }
  async saveMedicineAlert(alert: Record<string, unknown>) { return await this.systemAlerts.add(alert); }
  async persist() { return true; }
  
  async updateCustomerBalance(id: string, delta: number, tx?: any) {
    const customersTable = tx ? tx.table('customers') : this.customers;
    const cust = await customersTable.get(id);
    if (!cust) throw new Error(`CUSTOMER_NOT_FOUND: العميل [${id}] غير موجود لتحديث الرصيد.`);
    const newBalance = Math.round(((Number(cust.balance) || 0) + delta) * 100) / 100;
    await customersTable.update(id, { balance: newBalance });
    return newBalance;
  }
  
  async recordCashFlow(data: Record<string, unknown>) {
    const session = getCurrentUserSession();
    const userId = (data.userId as string | undefined) ?? session.userId;
    const assignedUser = userId
      ? await this.users.get(userId).catch(() => undefined)
      : undefined;
    return await this.cashFlow.add({
      ...data,
      id: this.generateId('CF'),
      userId,
      cashboxId: (data.cashboxId as string | undefined) ?? assignedUser?.cashboxId
    });
  }

  async getCashFlow() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.cashFlow.where('tenantId').equals(tenantId).toArray();
  }

  async saveAccountingEntry(entry: JournalEntry) {
    return await this.journalEntries.put(entry);
  }

  async saveAccountingPeriod(period: AccountingPeriod) {
    return await this.accountingPeriods.put(period);
  }

  // --- LEGACY ORCHESTRATION HELPERS ---
  async processSale(
    customerId: string, items: InvoiceItem[], total: number, id: string,
    isCash: boolean, _currency: string, docStatus: InvoiceStatus, _auditScore: number,
    _riskLevel: string, refId: string, _attachment: string, isReturn: boolean, date: string,
    transactionUuid?: string,
    tenantId?: string,
    branchId?: string
  ) {
    const invNum = this.generateId('INV');
    const nowIso = new Date().toISOString();
    const docDate = date || nowIso;
    const saleId = id || this.generateId('SALE');
    const payStatusStr = isCash ? 'Cash' : 'Credit';
    const finStatusStr = isCash ? 'Paid' : 'Unpaid';
    const docStatusStr = docStatus || 'POSTED';
    const userSession = getCurrentUserSession();
    const effectiveTenantId = tenantId || userSession?.tenantId || 'tenant-default';
    const effectiveBranchId = branchId || userSession?.branchId || 'main';
    const calculatedPaid = isCash ? (total || 0) : 0;
    const calculatedRemaining = Math.max(0, Math.round(((total || 0) - calculatedPaid) * 100) / 100);

    const sale: any = {
      id: saleId,
      invoiceNumber: invNum,
      invoice_number: invNum,
      invoiceId: invNum,
      date: docDate,
      Date: docDate,
      partnerId: customerId || 'CUST-GEN',
      partner_id: customerId || 'CUST-GEN',
      partnerName: 'Customer',
      type: 'SALE',
      totalAmount: total || 0,
      subtotal: total || 0,
      tax: 0,
      finalTotal: total || 0,
      paidAmount: calculatedPaid,
      remainingAmount: calculatedRemaining,
      remaining: calculatedRemaining,
      paymentStatus: payStatusStr as 'Cash' | 'Credit',
      payment_status: payStatusStr,
      financialStatus: finStatusStr,
      financial_status: finStatusStr,
      documentStatus: docStatusStr,
      document_status: docStatusStr,
      InvoiceStatus: docStatusStr,
      invoiceStatus: docStatusStr,
      items: items || [],
      isReturn: !!isReturn,
      notes: `Ref: ${refId || saleId}`,
      transactionUuid: transactionUuid || `TX-${Date.now()}`,
      hash: `HASH-${Date.now()}`,
      SaleID: saleId,
      tenantId: effectiveTenantId,
      tenant_id: effectiveTenantId,
      branchId: effectiveBranchId,
      branch_id: effectiveBranchId,
      createdAt: nowIso,
      isSynced: (typeof navigator !== 'undefined' && navigator.onLine),
      syncStatus: (typeof navigator !== 'undefined' && navigator.onLine) ? 'SYNCED' : 'PENDING',
      updatedAt: nowIso
    };
    await this.invoices.put(sale);
    try { await this.sales.put(sale); } catch {}
    return sale;
  }

  async processPurchase(
    supplierId: string, items: InvoiceItem[], total: number, id?: string,
    isCash: boolean = false, _currency?: string, docStatus: InvoiceStatus = 'POSTED', _auditScore: number = 0,
    _riskLevel: string = 'LOW', refId?: string, _attachment?: string, isReturn: boolean = false, date?: string,
    transactionUuid?: string,
    tenantId?: string,
    branchId?: string,
    adjustments?: {
      discountPercent?: number;
      otherFees?: number;
      tax?: number;
      notes?: string;
      attachment?: string;
      warehouseId?: string;
      originalPurchaseId?: string;
      tx?: any;
    }
  ) {
    const nowIso = new Date().toISOString();
    const docDate = date || nowIso;
    
    // Identity Strategy:
    // 1. Internal ID (purId): Use provided 'id' (for edits) or generate a fresh UUID.
    // 2. User-facing Invoice Number (invNum): Use provided 'refId' (user input) or generate a sequential-like ID.
    const purId = id || this.generateId('PUR');
    const invNum = refId || this.generateId('PURCH');
    
    const payStatusStr = isCash ? 'Cash' : 'Credit';
    const finStatusStr = isCash ? 'Paid' : 'Unpaid';
    const docStatusStr = docStatus || 'POSTED';
    const userSession = getCurrentUserSession();
    const effectiveTenantId = tenantId || userSession?.tenantId || 'tenant-default';
    const effectiveBranchId = branchId || userSession?.branchId || 'main';

    // Financial adjustment calculations
    const discountPercent = Number(adjustments?.discountPercent ?? 0);
    const otherFees = Number(adjustments?.otherFees ?? 0);
    const tax = Number(adjustments?.tax ?? 0);

    const itemsSubtotal = (items || []).reduce((sum, it: any) => {
      const q = Number(it.quantity ?? it.qty ?? 0);
      const p = Number(it.unitPrice ?? it.price ?? 0);
      const itemDisc = Number(it.discount ?? it.discount_val ?? 0);
      return sum + (q * p) - itemDisc;
    }, 0);

    const subtotal = itemsSubtotal > 0 ? Math.round(itemsSubtotal * 100) / 100 : (total || 0);
    const discountAmount = Math.round((subtotal * (discountPercent / 100)) * 100) / 100;
    const computedTotal = Math.round((subtotal - discountAmount + otherFees + tax) * 100) / 100;
    
    // Strict enforcement: Only trust input total if it matches computed total within tolerance
    const tolerance = 0.02;
    const finalTotal = (total > 0 && Math.abs(total - computedTotal) <= tolerance) ? total : computedTotal;

    const calculatedPaid = isCash ? (finalTotal || 0) : 0;
    const calculatedRemaining = Math.max(0, Math.round(((finalTotal || 0) - calculatedPaid) * 100) / 100);

    const purchase: any = {
      id: purId,
      invoiceNumber: invNum,
      invoice_number: invNum,
      invoiceId: invNum, // Compatibility
      date: docDate,
      Date: docDate, // Compatibility
      partnerId: supplierId || 'SUPP-GEN',
      partner_id: supplierId || 'SUPP-GEN',
      partnerName: 'Supplier',
      type: 'PURCHASE',
      subtotal: subtotal,
      discountPercent: discountPercent,
      discount: discountAmount,
      discountTotal: discountAmount,
      discount_val: discountAmount,
      otherFees: otherFees,
      tax: tax,
      taxTotal: tax,
      tax_val: tax,
      totalAmount: finalTotal,
      finalTotal: finalTotal,
      grandTotal: finalTotal,
      paidAmount: calculatedPaid,
      remainingAmount: calculatedRemaining,
      remaining: calculatedRemaining,
      paymentStatus: payStatusStr as 'Cash' | 'Credit',
      payment_status: payStatusStr,
      financialStatus: finStatusStr,
      financial_status: finStatusStr,
      documentStatus: docStatusStr,
      document_status: docStatusStr,
      InvoiceStatus: docStatusStr,
      invoiceStatus: docStatusStr,
      items: items || [],
      isReturn: !!isReturn,
      originalPurchaseId: adjustments?.originalPurchaseId,
      warehouseId: adjustments?.warehouseId,
      notes: adjustments?.notes || (refId ? `Ref: ${refId}` : `Ref: ${invNum}`),
      attachment: adjustments?.attachment || _attachment,
      transactionUuid: transactionUuid || `TX-${Date.now()}`,
      hash: `HASH-${Date.now()}`,
      tenantId: effectiveTenantId,
      tenant_id: effectiveTenantId,
      branchId: effectiveBranchId,
      branch_id: effectiveBranchId,
      createdAt: nowIso,
      isSynced: (typeof navigator !== 'undefined' && navigator.onLine),
      syncStatus: (typeof navigator !== 'undefined' && navigator.onLine) ? 'SYNCED' : 'PENDING',
      updatedAt: nowIso
    };

    // Use transaction table if provided to maintain atomic commit inside workflow
    const invoicesTable = adjustments?.tx?.table ? adjustments.tx.table('invoices') : this.invoices;
    const purchasesTable = adjustments?.tx?.table ? adjustments.tx.table('purchases') : this.purchases;

    await invoicesTable.put(purchase);
    try { await purchasesTable.put(purchase); } catch {}
    return purchase;
  }

  async getSales() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.invoices.where('tenantId').equals(tenantId).filter(inv => inv.type === 'SALE').toArray(); 
  }

  async getValidationRules(): Promise<ValidationRule[]> {
    const rulesSetting = await this.getSetting('validation_rules', null);
    if (rulesSetting) {
      return rulesSetting;
    }
    const defaultRules: ValidationRule[] = [
      {
        id: 'rule-sale-cust',
        entityType: 'SALE',
        fieldName: 'customerId',
        operator: 'NOT_EMPTY',
        comparisonValue: '',
        errorMessage: 'يجب تحديد عميل صالح.',
        isActive: true,
        updatedAt: new Date().toISOString()
      },
      {
        id: 'rule-sale-total',
        entityType: 'SALE',
        fieldName: 'total',
        operator: 'GREATER_THAN',
        comparisonValue: '0',
        errorMessage: 'يجب أن يكون إجمالي الفاتورة أكبر من صفر.',
        isActive: true,
        updatedAt: new Date().toISOString()
      }
    ];
    return defaultRules;
  }
  
  async getPurchases() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.invoices.where('tenantId').equals(tenantId).filter(inv => inv.type === 'PURCHASE').toArray(); 
  }

  async getTransactions() {
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    const all = await this.invoices.where('tenantId').equals(tenantId).toArray();
    return all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  async updateAccountBalance(id: string, delta: number) {
    const acc = await this.accounts.get(id);
    if (acc) {
      await this.accounts.update(id, {
        balance: (acc.balance || 0) + delta,
        updatedAt: new Date().toISOString()
      });
    }
  }

  async isDateLocked(date: string) {
    const period = await this.accountingPeriods
      .where('Start_Date').belowOrEqual(date)
      .and(p => !!p.End_Date && p.End_Date >= date && !!p.Is_Locked)
      .first();
    return !!period;
  }

  // --- SETTINGS HELPERS ---
  async getSetting(key: string, defaultValue: any = null) {
    try {
      const item = await this.settings.get(key);
      return item ? item.value : defaultValue;
    } catch (e) {
      console.warn(`[DB] Failed to get setting ${key}:`, e);
      return defaultValue;
    }
  }

  async saveSetting(key: string, value: any) {
    await this.settings.put({ key, value });
  }

  // --- AUDIT LOG HELPERS ---
  async addAuditLog(userId: string, action: string, targetType: string, details: string, tx?: any) {
  const auditTable = tx?.auditLogs ?? this.auditLogs;

  await auditTable.add({
    id: this.generateId('LOG'),
    timestamp: new Date().toISOString(),
    user_id: userId,
    action: action as any,
    target_type: targetType as any,
    target_id: details
  });
  }

  // --- PROTECTION HELPERS ---
  setBypassSecurity(status: boolean) {
    console.log(`[DB] Security Bypass: ${status}`);
    configurationService.set('PHARMAFLOW_DB_BYPASS', status ? 'true' : 'false').catch(() => {});
  }

  // --- CURRENCY HELPERS ---
  async saveCurrency(currency: any) {
    // If the table doesn't exist yet, we store it in settings as a fallback or a dedicated table
    try {
       await (this as any).currencies?.put(currency) || await this.saveSetting(`CURRENCY_${currency.code}`, currency);
    } catch (e) {
       await this.saveSetting(`CURRENCY_${currency.code}`, currency);
    }
  }

  async getExchangeRates(date?: string) {
    if (date) return await this.exchangeRates.where('date').equals(date).toArray();
    return await this.exchangeRates.toArray();
  }

  // --- TRANSACTION HELPERS ---
  async runTransaction<T>(
    operation: (tx?: Transaction) => Promise<T>,
    tables: string[] = [],
    mode: 'rw' | 'r' = 'rw'
  ): Promise<T> {
    const existing = this.getExistingTableNames();
    const validTables = (tables.length ? tables : existing).filter(t => existing.includes(t));

    try {
      if ((Dexie as any).currentTransaction) {
        return await operation((Dexie as any).currentTransaction);
      }

      return await this.transaction(mode as any, validTables, async (tx) => {
        // 🚨 تم إزالة حلقة الـ keepAlive الـ recursive التي كانت تحتجز قاعدة البيانات
        return await operation(tx);
      });
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('committed too early') || msg.includes('inactive') || msg.includes('aborted')) {
        const erpError = new Error('تعذر إكمال العملية حالياً، يرجى إعادة المحاولة.');
        (erpError as any).technicalDetails = msg;
        throw erpError;
      }
      throw error;
    }
  }

  // --- TABLES HELPERS ---
  async getProducts() { 
    const { tenantId } = getCurrentUserSession();
    if (!tenantId) return [];
    return await this.products.where('tenantId').equals(tenantId).toArray(); 
  }

  // --- INITIALIZATION ---
  async init() {
    console.log("[DB] Initializing database seeds and defaults...");
    const activeTenantId = getCurrentUserSession().tenantId;
    if (!activeTenantId) {
      console.warn('[DB] Skipping tenant-owned seed data: no active tenant session.');
      return true;
    }
    if (isDbBlocked) {
      console.log("[DB] Operating in resilient in-memory mode for init.");
      return true;
    }
    try {
      if (!this.isOpen()) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("IndexedDB open timeout")), 1500)
          );
          await Promise.race([this.open(), timeoutPromise]);
        } catch (openErr) {
          console.warn("[DB] Could not open IndexedDB during init, activating fallback:", openErr);
          isDbBlocked = true;
          return true;
        }
      }
      
      const count = await this.accounts.count().catch(() => 0);
      if (count === 0) {
        await this.accounts.bulkPut([
          { id: 'acc-cash', code: '101', name: 'الصندوق الرئيسي', type: 'ASSET', balance: 0, isSystem: true, isActive: true, balance_type: 'DEBIT', balanceType: 'DEBIT', debit: 0, credit: 0, updatedAt: new Date().toISOString() },
          { id: 'acc-sales', code: '401', name: 'إيرادات المبيعات', type: 'REVENUE', balance: 0, isSystem: true, isActive: true, balance_type: 'CREDIT', balanceType: 'CREDIT', debit: 0, credit: 0, updatedAt: new Date().toISOString() },
          { id: 'acc-cogs', code: '501', name: 'تكلفة البضاعة المباعة', type: 'EXPENSE', balance: 0, isSystem: true, isActive: true, balance_type: 'DEBIT', balanceType: 'DEBIT', debit: 0, credit: 0, updatedAt: new Date().toISOString() }
        ].map(record => ({ ...record, tenantId: activeTenantId })) as any[]).catch((err) => console.warn('[DB] Accounts seed warning:', err));
      }

      // Seed the default cashbox without changing existing user or cash movement records.
      const cashboxCount = await this.cashboxes.count().catch(() => 0);
      if (cashboxCount === 0) {
        const cashAccount = await this.accounts.where('code').equals('101').first().catch(() => undefined);
        await this.cashboxes.add({
          id: 'cashbox-main',
          name: 'الصندوق الرئيسي',
          ...(cashAccount?.id ? { accountId: cashAccount.id } : {}),
          branchId: 'MAIN',
          isActive: true,
          createdAt: new Date().toISOString()
        }).catch((err) => console.warn('[DB] Default cashbox seed warning:', err));
      }

      // Seed initial products for offline browsing if products table is empty
      const prodCount = await this.products.count().catch(() => 0);
      if (prodCount === 0) {
        await this.products.bulkPut([
          { id: 'PRD-101', name: 'بانادول إكسترا 500 ملجم', Name: 'Panadol Extra 500mg', barcode: '628100011001', categoryId: 'CAT-1', supplierId: 'SUP-1', stock: 150, is_active: true, Is_Active: true, price: 18.5, cost: 12.0, updatedAt: new Date().toISOString() },
          { id: 'PRD-102', name: 'أومول 500 ملجم أقراص', Name: 'Omol 500mg', barcode: '628100011002', categoryId: 'CAT-1', supplierId: 'SUP-1', stock: 200, is_active: true, Is_Active: true, price: 12.0, cost: 7.5, updatedAt: new Date().toISOString() },
          { id: 'PRD-103', name: 'فيتامين سي 1000 ملجم فوار', Name: 'Vitamin C 1000mg', barcode: '628100011003', categoryId: 'CAT-2', supplierId: 'SUP-2', stock: 85, is_active: true, Is_Active: true, price: 25.0, cost: 16.0, updatedAt: new Date().toISOString() },
          { id: 'PRD-104', name: 'أوجمنتين 1 جرام أقراص', Name: 'Augmentin 1g', barcode: '628100011004', categoryId: 'CAT-3', supplierId: 'SUP-2', stock: 60, is_active: true, Is_Active: true, price: 64.5, cost: 45.0, updatedAt: new Date().toISOString() },
          { id: 'PRD-105', name: 'بخاخ أنف أوتروفين', Name: 'Otrivin Nasal Spray', barcode: '628100011005', categoryId: 'CAT-4', supplierId: 'SUP-3', stock: 110, is_active: true, Is_Active: true, price: 16.0, cost: 10.5, updatedAt: new Date().toISOString() },
          { id: 'PRD-106', name: 'مرطب كيو في 500 جرام', Name: 'QV Cream 500g', barcode: '628100011006', categoryId: 'CAT-5', supplierId: 'SUP-3', stock: 40, is_active: true, Is_Active: true, price: 115.0, cost: 82.0, updatedAt: new Date().toISOString() }
        ].map(record => ({ ...record, tenantId: activeTenantId })) as any[]).catch((err) => console.warn('[DB] Products seed warning:', err));
      }

      // Seed initial invoices (sales & purchases history) for offline browsing if empty
      const invCount = await this.invoices.count().catch(() => 0);
      if (invCount === 0) {
        await this.invoices.bulkPut([
          {
            id: 'INV-1001',
            invoiceNumber: 'INV-1001',
            invoice_number: 'INV-1001',
            date: new Date(Date.now() - 86400000 * 2).toISOString(),
            partnerId: 'CUST-01',
            partnerName: 'صيدلية الأمل المركزية',
            type: 'SALE',
            subtotal: 185.0,
            tax: 0,
            finalTotal: 185.0,
            totalAmount: 185.0,
            paidAmount: 185.0,
            paymentStatus: 'Cash',
            financialStatus: 'Paid',
            documentStatus: 'POSTED',
            items: [{ id: 'ITEM-1', parent_id: 'INV-1001', product_id: 'PRD-101', quantity: 10, unitPrice: 18.5, totalPrice: 185.0 }],
            isReturn: false,
            notes: 'افتتاحي',
            is_synced: 1,
            isSynced: true,
            syncStatus: 'SYNCED',
            createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
            updatedAt: new Date(Date.now() - 86400000 * 2).toISOString()
          },
          {
            id: 'INV-1002',
            invoiceNumber: 'INV-1002',
            invoice_number: 'INV-1002',
            date: new Date(Date.now() - 86400000 * 1).toISOString(),
            partnerId: 'CUST-02',
            partnerName: 'مستشفى الحياة التخصصي',
            type: 'SALE',
            subtotal: 645.0,
            tax: 0,
            finalTotal: 645.0,
            totalAmount: 645.0,
            paidAmount: 0,
            paymentStatus: 'Credit',
            financialStatus: 'Unpaid',
            documentStatus: 'POSTED',
            items: [{ id: 'ITEM-2', parent_id: 'INV-1002', product_id: 'PRD-104', quantity: 10, unitPrice: 64.5, totalPrice: 645.0 }],
            isReturn: false,
            notes: 'توريد مستشفى',
            is_synced: 1,
            isSynced: true,
            syncStatus: 'SYNCED',
            createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
            updatedAt: new Date(Date.now() - 86400000 * 1).toISOString()
          },
          {
            id: 'PUR-2001',
            invoiceNumber: 'PUR-2001',
            invoice_number: 'PUR-2001',
            date: new Date(Date.now() - 86400000 * 5).toISOString(),
            partnerId: 'SUP-01',
            partnerName: 'شركة السقاف للخدمات الطبية',
            type: 'PURCHASE',
            subtotal: 2500.0,
            tax: 0,
            finalTotal: 2500.0,
            totalAmount: 2500.0,
            paidAmount: 2500.0,
            paymentStatus: 'Cash',
            financialStatus: 'Paid',
            documentStatus: 'POSTED',
            items: [{ id: 'ITEM-3', parent_id: 'PUR-2001', product_id: 'PRD-106', quantity: 20, unitPrice: 82.0, totalPrice: 1640.0 }],
            isReturn: false,
            notes: 'شحنة توريد عاجلة',
            is_synced: 1,
            isSynced: true,
            syncStatus: 'SYNCED',
            createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
            updatedAt: new Date(Date.now() - 86400000 * 5).toISOString()
          }
        ].map(record => ({ ...record, tenantId: activeTenantId })) as any[]).catch((err) => console.warn('[DB] Invoices seed warning:', err));
      }

      return true;
    } catch (e) {
      console.warn("[DB] Init warning handled:", e);
      return true;
    }
  }

  private dataVersionCounter = 1;

  getDataVersion() {
    return this.dataVersionCounter;
  }

  incrementDataVersion() {
    this.dataVersionCounter += 1;
  }
}

/**
 * Legacy support for code that uses db.db
 */

let isDbBlocked = false;
const memDb: Record<string, Map<string, any>> = {};

function createMockCollection(results: any[], mutationGuard?: (item: any, changes: any) => void) {
  const cloneRecord = (record: any) => record && typeof record === 'object' ? { ...record } : record;
  const coll: any = {
    toArray: () => Promise.resolve(results.map(cloneRecord)),
    count: () => Promise.resolve(results.length),
    first: () => Promise.resolve(cloneRecord(results[0]) || null),
    last: () => Promise.resolve(cloneRecord(results[results.length - 1]) || null),
    limit: (n: number) => createMockCollection(results.slice(0, n), mutationGuard),
    offset: (n: number) => createMockCollection(results.slice(n), mutationGuard),
    reverse: () => createMockCollection([...results].reverse(), mutationGuard),
    filter: (fn: any) => createMockCollection(results.filter(fn), mutationGuard),
    and: (fn: any) => createMockCollection(results.filter(fn), mutationGuard),
    sortBy: (keyPath: string) => {
      const sorted = [...results].sort((a, b) => a[keyPath] < b[keyPath] ? -1 : a[keyPath] > b[keyPath] ? 1 : 0);
      return Promise.resolve(sorted.map(cloneRecord));
    },
    clone: () => createMockCollection([...results], mutationGuard),
    distinct: () => createMockCollection(Array.from(new Set(results)), mutationGuard),
    keys: () => Promise.resolve(results.map(r => r.id || r.key)),
    primaryKeys: () => Promise.resolve(results.map(r => r.id || r.key)),
    uniqueKeys: () => Promise.resolve(Array.from(new Set(results.map(r => r.id || r.key)))),
    modify: (changesOrFn: any) => {
      let count = 0;
      results.forEach(item => {
        mutationGuard?.(item, changesOrFn);
        const previousTenantId = item?.tenantId;
        if (typeof changesOrFn === 'function') changesOrFn(item);
        else if (typeof changesOrFn === 'object' && changesOrFn !== null) Object.assign(item, changesOrFn);
        if (mutationGuard && item?.tenantId !== previousTenantId) {
          item.tenantId = previousTenantId;
          throw new Error('FAIL_CLOSED: tenantId modification is forbidden.');
        }
        count++;
      });
      return Promise.resolve(count);
    },
    delete: () => Promise.resolve(results.length),
    each: (fn: (item: any) => void) => {
      results.forEach(item => fn(cloneRecord(item)));
      return Promise.resolve();
    }
  };
  return coll;
}

function getMockTable(tableName: string) {
  if (!memDb[tableName]) {
    memDb[tableName] = new Map();
  }
  const store = memDb[tableName];
  const tenantScoped = TENANT_SCOPED_TABLES.has(tableName);
  const getVisibleRows = () => {
    const rows = Array.from(store.values());
    if (!tenantScoped) return rows;
    const tenantId = getCurrentUserSession().tenantId;
    if (!tenantId) throw new Error(`FAIL_CLOSED: In-memory read blocked on '${tableName}' without an active tenant session.`);
    return rows.filter(item => item?.tenantId === tenantId);
  };
  const assertWritable = (item: any, key?: any) => {
    if (!tenantScoped) return item;
    const tenantId = getCurrentUserSession().tenantId;
    if (!tenantId) throw new Error(`FAIL_CLOSED: In-memory write blocked on '${tableName}' without an active tenant session.`);
    if (!item || typeof item !== 'object' || (item.tenantId && item.tenantId !== tenantId)) {
      throw new Error(`FAIL_CLOSED: In-memory cross-tenant write blocked on '${tableName}'.`);
    }
    const id = key ?? item.id ?? item.key;
    const existing = id !== undefined ? store.get(String(id)) : undefined;
    if (existing && existing.tenantId !== tenantId) {
      throw new Error(`FAIL_CLOSED: In-memory cross-tenant write blocked on '${tableName}'.`);
    }
    return { ...item, tenantId };
  };
  const createVisibleCollection = (rows: any[]) => createMockCollection(rows, tenantScoped ? (item, changes) => {
    const tenantId = getCurrentUserSession().tenantId;
    if (!tenantId || item?.tenantId !== tenantId) {
      throw new Error(`FAIL_CLOSED: In-memory collection mutation blocked on '${tableName}'.`);
    }
    if (typeof changes === 'object' && changes !== null && changes.tenantId !== undefined && changes.tenantId !== item.tenantId) {
      throw new Error('FAIL_CLOSED: tenantId modification is forbidden.');
    }
  } : undefined);

  const whereMock = (indexOrProp?: any) => {
    // If an object criteria is passed, e.g. table.where({ code: '101' })
    if (typeof indexOrProp === 'object' && indexOrProp !== null) {
      const entries = Object.entries(indexOrProp);
      const results = getVisibleRows().filter(item => {
        if (typeof item === 'object' && item !== null) {
          return entries.every(([k, v]) => String(item[k]).toLowerCase() === String(v).toLowerCase());
        }
        return false;
      });
      return createVisibleCollection(results);
    }

    const prop = typeof indexOrProp === 'string' ? indexOrProp : '';

    return {
      equals: (val: any) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return String(item[prop]).toLowerCase() === String(val).toLowerCase();
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      equalsIgnoreCase: (val: any) => {
        const strVal = String(val).toLowerCase();
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return String(item[prop] ?? '').toLowerCase() === strVal;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      startsWith: (val: any) => {
        const prefix = String(val);
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return String(item[prop] ?? '').startsWith(prefix);
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      startsWithIgnoreCase: (val: any) => {
        const prefix = String(val).toLowerCase();
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return String(item[prop] ?? '').toLowerCase().startsWith(prefix);
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      startsWithAnyOf: (prefixes: string[]) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            const fieldVal = String(item[prop] ?? '');
            return prefixes.some(p => fieldVal.startsWith(p));
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      startsWithIgnoreCaseAnyOf: (prefixes: string[]) => {
        const lowerPrefixes = prefixes.map(p => String(p).toLowerCase());
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            const fieldVal = String(item[prop] ?? '').toLowerCase();
            return lowerPrefixes.some(p => fieldVal.startsWith(p));
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      above: (val: any) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return item[prop] > val;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      aboveOrEqual: (val: any) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return item[prop] >= val;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      below: (val: any) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return item[prop] < val;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      belowOrEqual: (val: any) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return item[prop] <= val;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      anyOf: (vals: any[]) => {
        const valSet = new Set(vals);
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return valSet.has(item[prop]);
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      anyOfIgnoreCase: (vals: string[]) => {
        const valSet = new Set(vals.map(v => String(v).toLowerCase()));
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return valSet.has(String(item[prop] ?? '').toLowerCase());
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      noneOf: (vals: any[]) => {
        const valSet = new Set(vals);
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return !valSet.has(item[prop]);
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      notEqual: (val: any) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            return item[prop] !== val;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      between: (a: any, b: any, includeLower = true, includeUpper = true) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            const v = item[prop];
            const lowerOk = includeLower ? v >= a : v > a;
            const upperOk = includeUpper ? v <= b : v < b;
            return lowerOk && upperOk;
          }
          return false;
        });
        return createVisibleCollection(results);
      },
      inAnyRange: (ranges: [any, any][]) => {
        const results = getVisibleRows().filter(item => {
          if (typeof item === 'object' && item !== null && prop) {
            const v = item[prop];
            return ranges.some(([a, b]) => v >= a && v <= b);
          }
          return false;
        });
        return createVisibleCollection(results);
      }
    };
  };

  const mockTable: any = {
    name: tableName,
    toArray: () => Promise.resolve(getVisibleRows().map((item: any) => ({ ...item }))),
    get: (key: any) => {
      const rows = getVisibleRows();
      const found = typeof key === 'object' && key !== null
        ? rows.find(item => Object.entries(key).every(([k, v]) => item[k] === v))
        : rows.find(item => String(item.id ?? item.key) === String(key));
      return Promise.resolve(found ? { ...found } : null);
    },
    bulkGet: async (keys: any[]) => Promise.all(keys.map((key: any) => mockTable.get(key))),
    put: (item: any) => {
      const safeItem = assertWritable(item);
      const id = safeItem.id || safeItem.key || `mem-${Math.random().toString(36).substring(2, 10)}`;
      store.set(String(id), { ...safeItem, id });
      return Promise.resolve(id);
    },
    add: (item: any) => {
      const safeItem = assertWritable(item);
      const id = safeItem.id || safeItem.key || `mem-${Math.random().toString(36).substring(2, 10)}`;
      if (store.has(String(id))) throw new Error(`ConstraintError: Duplicate key in '${tableName}'.`);
      store.set(String(id), { ...safeItem, id });
      return Promise.resolve(id);
    },
    update: (key: any, changes: any) => {
      const existing = store.get(String(key));
      if (!existing) return Promise.resolve(0);
      const activeTenantId = getCurrentUserSession().tenantId;
      if (tenantScoped && (!activeTenantId || !existing.tenantId || existing.tenantId !== activeTenantId)) {
        throw new Error(`FAIL_CLOSED: In-memory cross-tenant or orphaned update blocked on '${tableName}'.`);
      }
      if (tenantScoped && changes?.tenantId !== undefined && changes.tenantId !== existing.tenantId) {
        throw new Error('FAIL_CLOSED: tenantId modification is forbidden.');
      }
      store.set(String(key), { ...existing, ...changes, ...(tenantScoped ? { tenantId: existing.tenantId } : {}) });
      return Promise.resolve(1);
    },
    delete: (key: any) => {
      const existing = store.get(String(key));
      if (tenantScoped && (!getCurrentUserSession().tenantId || !existing || existing.tenantId !== getCurrentUserSession().tenantId)) {
        throw new Error(`FAIL_CLOSED: In-memory cross-tenant delete blocked on '${tableName}'.`);
      }
      store.delete(String(key));
      return Promise.resolve(null);
    },
    bulkAdd: async (items: any[]) => {
      if (!Array.isArray(items)) throw new TypeError('bulkAdd expects an array.');
      const safeItems = items.map(item => assertWritable(item));
      for (const item of safeItems) {
        const id = item.id || item.key;
        if (id !== undefined && store.has(String(id))) throw new Error(`ConstraintError: Duplicate key in '${tableName}'.`);
      }
      return Promise.all(safeItems.map(item => mockTable.add(item)));
    },
    bulkPut: async (items: any[]) => {
      if (!Array.isArray(items)) throw new TypeError('bulkPut expects an array.');
      const safeItems = items.map(item => assertWritable(item));
      return Promise.all(safeItems.map(item => mockTable.put(item)));
    },
    bulkDelete: async (keys: any[]) => {
      if (!Array.isArray(keys)) throw new TypeError('bulkDelete expects an array of keys.');
      if (tenantScoped) {
        const tenantId = getCurrentUserSession().tenantId;
        if (!tenantId) throw new Error(`FAIL_CLOSED: In-memory bulk delete blocked on '${tableName}'.`);
        for (const key of keys) {
          const record = store.get(String(key));
          if (record && record.tenantId !== tenantId) throw new Error(`FAIL_CLOSED: In-memory cross-tenant bulk delete blocked on '${tableName}'.`);
        }
      }
      return Promise.all(keys.map(key => mockTable.delete(key)));
    },
    clear: async () => {
      if (!tenantScoped) { store.clear(); return; }
      const tenantId = getCurrentUserSession().tenantId;
      if (!tenantId) throw new Error(`FAIL_CLOSED: In-memory clear blocked on '${tableName}'.`);
      for (const [key, record] of store.entries()) if (record?.tenantId === tenantId) store.delete(key);
    },
    count: () => Promise.resolve(getVisibleRows().length),
    where: whereMock,
    orderBy: (prop: string) => {
      const results = getVisibleRows().sort((a, b) => a[prop] < b[prop] ? -1 : a[prop] > b[prop] ? 1 : 0);
      return createVisibleCollection(results);
    },
    filter: (fn: any) => createVisibleCollection(getVisibleRows().filter(fn))
  };

  return mockTable;
}

export const ALL_SCHEMA_TABLE_NAMES = [
  'products', 'invoices', 'invoiceItems', 'accounts', 'journalEntries', 'journalLines',
  'inventoryTransactions', 'accountingPeriods', 'customers', 'suppliers', 'vouchers',
  'auditLogs', 'settings', 'users', 'userPermissions', 'systemSettings', 'medicineBatches', 'exchangeRates',
  'systemBackups', 'branches', 'branchSettings', 'branchInventory', 'branchTransfers',
  'branchTransferItems', 'branchUsers', 'sales', 'purchases', 'categories', 'receipts',
  'payments', 'settlements', 'cashFlow', 'cashboxes', 'priceHistory', 'inventory', 'invoiceAdjustments',
  'systemAlerts', 'financialHealthSnapshots', 'historicalMetrics', 'voucherInvoiceLinks',
  'financialTransactions', 'warehouseStock', 'inventory_layers', 'fifo_consumption_log',
  'itemUsageLog', 'stock_movements', 'inventory_logs', 'Audit_Log', 'Accounting_Periods',
  'purchasesByItem', 'profitHealth', 'aiInsights', 'dailyAuditTasks', 'auditProgress',
  'itemProfits', 'supplierProfits', 'profit_health', 'systemPerformanceLog', 'cash_logs',
  'System_Error_Log', 'sync_queue', 'sync_logs', 'sync_failures', 'sync_conflicts',
  'sync_snapshots', 'syncQueue', 'syncEvents', 'failedMutations', 'outbox', 'syncLogs',
  'eventStore', 'readProducts', 'readInventory', 'readInvoices', 'readLedgers',
  'aggregateSnapshots', 'system_errors', 'drafts', 'draft_invoices', 'draft_in_voices',
  'idempotencyKeys', 'projectionCheckpoints', 'projectionEvents', 'supplierAliases',
  'productAliases', 'supplierProductReferences', 'aliasRejections', 'aliasAuditLogs',
  'inventoryCorrectionCases', 'system_diagnostics', 'error_aggregates', 'recovery_events',
  'system_health', 'integrity_audit_logs', 'integrity_repair_records', 'idempotency_records'
];

export function getDatabaseName(_tenantId?: string | null, _userId?: string | null): string {
  return 'PharmaFlowPRO';
}

// Persistent Global DB Instance Singleton to survive module reloads and worker context boundaries
if (!(globalThis as any).__PHARMA_FLOW_DB_INSTANCE__) {
  (globalThis as any).__PHARMA_FLOW_DB_INSTANCE__ = new PharmaFlowDB('PharmaFlowPRO');
}
export const dbInstance = (globalThis as any).__PHARMA_FLOW_DB_INSTANCE__ as PharmaFlowDB;

/**
 * Upgrade the authenticated offline user's own legacy plaintext credential.
 * The exception is bound to one read-write transaction and one exact update.
 */
export async function upgradeOwnLegacyPassword(
  userId: string,
  tenantId: string,
  expectedLegacyPassword: string,
  passwordHash: string
): Promise<void> {
  const initialIdentity = resolveTenantSessionIdentity();
  if (
    !initialIdentity ||
    initialIdentity.user.offlineOnly !== true ||
    !initialIdentity.token.startsWith('offline-local-') ||
    initialIdentity.userId !== userId ||
    initialIdentity.tenantId !== tenantId ||
    typeof expectedLegacyPassword !== 'string' ||
    expectedLegacyPassword.length === 0 ||
    typeof passwordHash !== 'string' ||
    !passwordHash.startsWith('pbkdf2-sha256$')
  ) {
    throw new Error('SELF_PASSWORD_UPGRADE_FORBIDDEN: Authenticated offline self-upgrade context is required.');
  }

  await dbInstance.transaction('rw', dbInstance.users, async () => {
    const transaction = Dexie.currentTransaction;
    if (!transaction) {
      throw new Error('SELF_PASSWORD_UPGRADE_TRANSACTION_REQUIRED: Dexie transaction context is missing.');
    }

    const activeIdentity = resolveTenantSessionIdentity();
    if (
      !activeIdentity ||
      activeIdentity.user.offlineOnly !== true ||
      activeIdentity.token !== initialIdentity.token ||
      activeIdentity.userId !== userId ||
      activeIdentity.tenantId !== tenantId
    ) {
      throw new Error('SELF_PASSWORD_UPGRADE_SESSION_CHANGED: The authenticated session changed during upgrade.');
    }

    const record = await dbInstance.users.get(userId);
    if (
      !record ||
      String(record.id || record.user_id || '') !== userId ||
      record.tenantId !== tenantId ||
      record.password !== expectedLegacyPassword ||
      record.passwordHash
    ) {
      throw new Error('SELF_PASSWORD_UPGRADE_REJECTED: The legacy credential or target record is no longer valid.');
    }

    const capability: SelfCredentialUpgradeCapability = {
      userId,
      tenantId,
      token: initialIdentity.token,
      expectedLegacyPassword,
      passwordHash,
      consumed: false
    };
    selfCredentialUpgradeCapabilities.set(transaction, capability);

    try {
      const updatedCount = await dbInstance.users.update(userId, {
        passwordHash,
        password: undefined
      });
      if (updatedCount !== 1 || !capability.consumed) {
        throw new Error('SELF_PASSWORD_UPGRADE_REJECTED: The scoped credential update was not accepted.');
      }

      const updatedRecord = await dbInstance.users.get(userId);
      const finalIdentity = resolveTenantSessionIdentity();
      if (
        !updatedRecord ||
        updatedRecord.tenantId !== tenantId ||
        updatedRecord.passwordHash !== passwordHash ||
        updatedRecord.password !== undefined ||
        !finalIdentity ||
        finalIdentity.user.offlineOnly !== true ||
        finalIdentity.token !== initialIdentity.token ||
        finalIdentity.userId !== userId ||
        finalIdentity.tenantId !== tenantId
      ) {
        throw new Error('SELF_PASSWORD_UPGRADE_VERIFICATION_FAILED: The upgraded credential did not pass post-write verification.');
      }
    } finally {
      selfCredentialUpgradeCapabilities.delete(transaction);
    }
  });
}

export async function openUserDatabase(_tenantId?: string, _userId?: string): Promise<PharmaFlowDB> {
  if (!dbInstance.isOpen()) {
    try {
      await dbInstance.open();
    } catch (e) {
      console.warn('[DB] openUserDatabase fallback:', e);
    }
  }
  return dbInstance;
}

export async function closeUserDatabase(): Promise<void> {
  // Graceful no-op to maintain open database handle
}

/**
 * Export a Proxy to support legacy code while transitioning to the new schema.
 */
function wrapQueryChain(obj: any, tableName: string): any {
  if (!obj || typeof obj !== 'object') return obj;
  return new Proxy(obj, {
    get(targetObj, targetProp) {
      if (targetProp === 'then' && typeof targetObj.then !== 'function') {
        return undefined;
      }
      if (isDbBlocked) {
        const mockTable = getMockTable(tableName);
        const fallbackObj = (mockTable as any).where ? (mockTable as any).where() : createMockCollection([]);
        return typeof fallbackObj[targetProp] === 'function'
          ? fallbackObj[targetProp].bind(fallbackObj)
          : fallbackObj[targetProp];
      }
      const val = targetObj[targetProp];
      if (typeof val === 'function') {
        return (...args: any[]) => {
            const res = val.apply(targetObj, args);
            if (res && typeof res.then === 'function') {
              return res.catch((err: any) => {
                throw err;
              });
            }
            if (res && typeof res === 'object') {
              return wrapQueryChain(res, tableName);
            }
            return res;
        };
      }
      return val;
    }
  });
}

function wrapTable(realTable: any, tableName: string): any {
  if (!realTable) return getMockTable(tableName);
  return new Proxy(realTable, {
    get(tObj, tProp) {
      if (tProp === 'name') return tableName || tObj.name;
      if (tProp === 'then' && typeof tObj.then !== 'function') return undefined;
      if (isDbBlocked) return (getMockTable(tableName) as any)[tProp];

      const tenantIndexed = (tObj.schema?.indexes || []).some((index: any) =>
        index?.keyPath === 'tenantId' ||
        (Array.isArray(index?.keyPath) && index.keyPath.includes('tenantId'))
      );
      const tenantScoped = TENANT_SCOPED_TABLES.has(tableName) || tenantIndexed;
      const requireScope = (operation: string) => requireTenantForTable(tObj, operation);
      const assertScope = (tenantId: string, operation: string) => assertTenantUnchanged(tObj, tenantId, operation);
      const rawGet = tObj.get.bind(tObj);
      const rawPut = tObj.put.bind(tObj);
      const rawAdd = tObj.add.bind(tObj);
      const rawDelete = tObj.delete.bind(tObj);
      const rawToCollection = () => tObj.toCollection();

      if (tenantScoped && tProp === 'get') {
        return async (key: any) => {
          const session = requireScope('Read');
          const record = await rawGet(key);
          assertScope(session.tenantId, 'Read');
          if (record && (!record.tenantId || record.tenantId !== session.tenantId)) {
            throw new Error(`FAIL_CLOSED: Unauthorized direct read on '${tableName}'.`);
          }
          return record;
        };
      }

      if (tenantScoped && tProp === 'update') {
        return async (key: any, changes: any) => {
          const session = requireScope('Update');
          const existing = await rawGet(key);
          assertScope(session.tenantId, 'Update');
          if (!existing) return 0;
          if (!existing.tenantId || existing.tenantId !== session.tenantId) {
            throw new Error(`FAIL_CLOSED: Unauthorized data modification attempt on '${tableName}'.`);
          }
          if (
            changes &&
            typeof changes === 'object' &&
            Object.prototype.hasOwnProperty.call(changes, 'tenantId') &&
            changes.tenantId !== existing.tenantId
          ) {
            throw new Error('FAIL_CLOSED: tenantId modification is strictly forbidden.');
          }
          const updated = await tObj.update(key, changes);
          assertScope(session.tenantId, 'Update');
          return updated;
        };
      }

      if (tenantScoped && tProp === 'bulkGet') {
        return async (keys: any[]) => {
          const session = requireScope('Bulk read');
          const records = await tObj.bulkGet(keys);
          assertScope(session.tenantId, 'Bulk read');
          for (const record of records) {
            if (record && (!record.tenantId || record.tenantId !== session.tenantId)) {
              throw new Error(`FAIL_CLOSED: Unauthorized bulk read on '${tableName}'.`);
            }
          }
          return records;
        };
      }

      if (tenantScoped && tProp === 'toArray') {
        return async () => {
          const session = requireScope('Read');
          const records = tenantIndexed
            ? await tObj.where('tenantId').equals(session.tenantId).toArray()
            : await rawToCollection().toArray().then((rows: any[]) => rows.filter(row => row?.tenantId === session.tenantId));
          assertScope(session.tenantId, 'Read');
          return records;
        };
      }

      if (tenantScoped && tProp === 'count') {
        return async () => {
          const session = requireScope('Count');
          const count = tenantIndexed
            ? await tObj.where('tenantId').equals(session.tenantId).count()
            : (await rawToCollection().toArray()).filter((row: any) => row?.tenantId === session.tenantId).length;
          assertScope(session.tenantId, 'Count');
          return count;
        };
      }

      if (tenantScoped && (tProp === 'bulkAdd' || tProp === 'bulkPut')) {
        const addOnly = tProp === 'bulkAdd';
        return async (items: any[], keysOrOptions?: any, optionsArg?: any) => {
          if (!Array.isArray(items)) throw new Error('FAIL_CLOSED: Invalid bulk payload.');
          const keys = Array.isArray(keysOrOptions) ? keysOrOptions : undefined;
          const options = optionsArg || (keys ? undefined : keysOrOptions);
          if (keys && keys.length !== items.length) throw new Error('Invalid bulk keys length.');
          if (keys && tObj.schema.primKey.keyPath) throw new Error('Bulk keys are invalid for inbound primary keys.');
          const session = requireScope(addOnly ? 'Bulk create' : 'Bulk upsert');
          return tObj.db.transaction('rw', tObj, async () => {
            const result: any[] = [];
            for (let index = 0; index < items.length; index += 1) {
              const item = items[index];
              if (!item || typeof item !== 'object' || (item.tenantId && item.tenantId !== session.tenantId)) {
                throw new Error(`FAIL_CLOSED: Cross-tenant bulk operation rejected on '${tableName}'.`);
              }
              const value = { ...item, tenantId: session.tenantId, userId: item.userId || session.userId };
              ensureItemPrimaryKey(tObj, value);
              const key = Array.isArray(keys) ? keys[index] : extractPrimaryKey(tObj, value);
              if (!addOnly && key !== undefined && key !== null) {
                const existing = await rawGet(key);
                if (existing && (!existing.tenantId || existing.tenantId !== session.tenantId)) {
                  throw new Error(`FAIL_CLOSED: Unauthorized bulk upsert target on '${tableName}'.`);
                }
              }
              assertScope(session.tenantId, addOnly ? 'Bulk create' : 'Bulk upsert');
              result.push(await (addOnly ? rawAdd : rawPut)(value, Array.isArray(keys) ? keys[index] : undefined));
            }
            return options?.allKeys === true ? result : result[result.length - 1];
          });
        };
      }

      if (tenantScoped && tProp === 'bulkDelete') {
        return async (keys: any[]) => {
          if (!Array.isArray(keys)) throw new Error('FAIL_CLOSED: Invalid bulk delete keys.');
          const session = requireScope('Bulk delete');
          return tObj.db.transaction('rw', tObj, async () => {
            for (const key of keys) {
              const record = await rawGet(key);
              assertScope(session.tenantId, 'Bulk delete');
              if (record && (!record.tenantId || record.tenantId !== session.tenantId)) {
                throw new Error(`FAIL_CLOSED: Unauthorized bulk delete target on '${tableName}'.`);
              }
            }
            for (const key of keys) {
              const record = await rawGet(key);
              if (record) {
                assertScope(session.tenantId, 'Bulk delete');
                await rawDelete(key);
              }
            }
          });
        };
      }

      if (tenantScoped && tProp === 'clear') {
        return async () => {
          const session = requireScope('Clear');
          return tObj.db.transaction('rw', tObj, async () => {
            const records = await rawToCollection().toArray();
            for (const record of records) {
              if (record?.tenantId === session.tenantId) {
                assertScope(session.tenantId, 'Clear');
                await rawDelete(extractPrimaryKey(tObj, record));
              }
            }
          });
        };
      }

      const realVal = tObj[tProp];
      if (typeof realVal === 'function') {
        const boundFn = realVal.bind(tObj);
        return (...args: any[]) => {
          const res = boundFn(...args);
          if (res && typeof res.then === 'function') return res.catch((err: any) => { throw err; });
          if (res && typeof res === 'object') return wrapQueryChain(res, tableName);
          return res;
        };
      }
      return realVal;
    }
  });
}

export const dbProxy = new Proxy({} as any, {
  get(_dummy, prop) {
    const target = dbInstance;
    if (prop === 'db') return dbProxy;
    if (prop === 'then' && typeof (target as any).then !== 'function') return undefined;

    if (prop === 'generateId') {
      return (prefix: string = 'ID') => {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `${prefix}-${timestamp}-${random}`;
      };
    }

    if (prop === 'tables') {
      try {
        if (!isDbBlocked && target.tables && Array.isArray(target.tables) && target.tables.length > 0) {
          return target.tables.map(t => wrapTable(t, t.name));
        }
      } catch {}
      return ALL_SCHEMA_TABLE_NAMES.map(name => getMockTable(name));
    }

    if (prop === 'getExistingTableNames') {
      return () => {
        try {
          if (!isDbBlocked && target.tables && Array.isArray(target.tables) && target.tables.length > 0) {
            return target.tables.map((t: any) => t.name);
          }
        } catch {}
        return ALL_SCHEMA_TABLE_NAMES;
      };
    }

    if (prop === 'init') {
      return async () => {
        try {
          if (isDbBlocked) {
            console.log("[DB] Operating in resilient in-memory mode for init.");
            return true;
          }
          if (typeof target.init === 'function') {
            return await target.init();
          }
        } catch (err) {
          console.warn("[DB Proxy] Init notice handled:", err);
          isDbBlocked = true;
        }
        return true;
      };
    }

    if (prop === 'table') {
      return (tableName: string) => dbProxy[tableName];
    }

    if (prop === 'open') {
      return async () => {
        if (isDbBlocked) {
          return dbProxy;
        }
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("IndexedDB open timeout (1500ms)")), 1500)
          );
          await Promise.race([dbInstance.open(), timeoutPromise]);
          return dbProxy;
        } catch (e) {
          console.warn("Failed or timed out opening db via proxy open():", e);
          isDbBlocked = true;
          return dbProxy;
        }
      };
    }

    if (prop === 'isOpen') {
      return () => {
        if (isDbBlocked) return true;
        try {
          return dbInstance.isOpen();
        } catch {
          return true;
        }
      };
    }

    if (prop === 'ensureOpen') {
      return async () => {
        if (isDbBlocked) return;
        try {
          if (!dbInstance.isOpen()) await dbInstance.open();
        } catch {
          isDbBlocked = true;
        }
      };
    }

    // Safe compatibility wrappers with strict tenant isolation (Fail-Closed)
    // We use the underlying 'target' (dbInstance) to avoid recursion via dbProxy
    if (prop === 'getAccounts') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.accounts.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getJournalEntries') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.journalEntries.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getAccountingPeriods') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.accountingPeriods.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getCustomers') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.customers.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getSuppliers') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.suppliers.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getProducts') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.products.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getReceipts') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.receipts.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getPayments') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.payments.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getTransactions') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.invoices.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getSales') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.invoices.where('tenantId').equals(session.tenantId).filter((i: any) => i.type === 'SALE').toArray();
    };
    if (prop === 'getPurchases') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.invoices.where('tenantId').equals(session.tenantId).filter((i: any) => i.type === 'PURCHASE').toArray();
    };
    if (prop === 'getCurrencies') return async () => target.getSetting('CURRENCIES', []);
    if (prop === 'getCashFlow') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.cashFlow.where('tenantId').equals(session.tenantId).toArray();
    };
    if (prop === 'getMedicineAlerts') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) return [];
      return await target.systemAlerts
        .where('tenantId').equals(session.tenantId)
        .filter((a: any) => a.type === 'STOCK' || ['EXPIRY', 'LOW_STOCK', 'SEASONAL'].includes(a.Type))
        .toArray();
    };
    if (prop === 'saveMedicineAlert') return async (alert: any) => dbProxy.systemAlerts.add(alert);
    if (prop === 'clearOldAlerts') return async () => {
      const session = getCurrentUserSession();
      if (!session.tenantId) throw new Error('FAIL_CLOSED: Cannot clear alerts without an active tenant session.');
      return await target.systemAlerts.where('tenantId').equals(session.tenantId)
        .filter((alert: any) => alert.type === 'STOCK' || ['EXPIRY', 'LOW_STOCK', 'SEASONAL'].includes(alert.Type)).delete();
    };
    if (prop === 'getDailyAuditTask') return async (date: string) => dbProxy.dailyAuditTasks.where('date').equals(date).first();
    if (prop === 'createDailyAuditTask') return async (task: any) => dbProxy.dailyAuditTasks.add(task);
    if (prop === 'saveAuditProgress') return async (progress: any) => dbProxy.auditProgress.put(progress);
    if (prop === 'finalizeAudit') return async (taskId: string, results: any) => dbProxy.dailyAuditTasks.update(taskId, { ...results, status: 'COMPLETED' });
    if (prop === 'saveCustomer') return async (customer: any) => dbProxy.customers.put(customer);
    if (prop === 'saveSupplier') return async (supplier: any) => dbProxy.suppliers.put(supplier);
    if (prop === 'saveProduct') return async (product: any) => dbProxy.products.put(product);
    if (prop === 'softDeleteProduct') return async (id: string) => dbProxy.products.update(id, { is_active: false });
    if (prop === 'saveAccount') return async (account: any) => dbProxy.accounts.put(account);
    if (prop === 'deleteAccount') return async (id: string) => dbProxy.accounts.delete(id);
    if (prop === 'addJournalEntry' || prop === 'addJournalEntryLegacy') return async (entry: any) => dbProxy.journalEntries.add(entry);
    if (prop === 'saveSettlement') return async (settlement: any) => dbProxy.settlements.put(settlement);
    if (prop === 'getCurrentBranchId') return async () => 'MAIN';
    if (prop === 'updatePurchaseNotes') return async (id: string, notes: string) => dbProxy.invoices.update(id, { notes });
    if (prop === 'updatePurchaseAttachment') return async (id: string, attachment: string) => dbProxy.invoices.update(id, { attachment });
    if (prop === 'updateSaleNotes') return async (id: string, notes: string) => dbProxy.invoices.update(id, { notes });
    if (prop === 'updateSaleAttachment') return async (id: string, attachment: string) => dbProxy.invoices.update(id, { attachment });
    if (prop === 'getInvoiceHistory') return async (invoiceId: string) => dbProxy.auditLogs.where('targetId').equals(invoiceId).toArray();
    if (prop === 'addInvoiceHistory') return async (log: any) => dbProxy.auditLogs.add({ id: dbProxy.generateId('HIST'), ...log });
    if (prop === 'persist') return async () => true;
    if (prop === 'resetResilientMode') return () => { isDbBlocked = false; };
    if (prop === 'updateCustomerBalance') return async (id: string, delta: number, tx?: any) => {
      const customersTable = tx ? tx.table('customers') : dbProxy.customers;
      const c = await customersTable.get(id);
      if (!c) throw new Error(`CUSTOMER_NOT_FOUND: العميل [${id}] غير موجود لتحديث الرصيد.`);
      const newBalance = Math.round(((Number(c.balance) || 0) + delta) * 100) / 100;
      await customersTable.update(id, { balance: newBalance });
      return newBalance;
    };
    if (prop === 'updateSupplierBalance') {
  return async (id: string, delta: number, tx?: any) => {
      const suppliersTable = tx ? tx.table('suppliers') : dbProxy.suppliers;

    const s = await suppliersTable.get(id);

    if (!s) {
      throw new Error(
        `SUPPLIER_NOT_FOUND: المورد [${id}] غير موجود لتحديث الرصيد.`
      );
    }

    const newBalance =
      Math.round(((Number(s.balance) || 0) + delta) * 100) / 100;

    await suppliersTable.update(id, {
      balance: newBalance
    });

    return newBalance;
  };
    }
    if (prop === 'updateAccountBalance') return async (id: string, delta: number) => {
      try {
        const a = await dbProxy.accounts.get(id);
        if (a) await dbProxy.accounts.update(id, { balance: (Number(a.balance) || 0) + delta });
      } catch {}
    };
    if (prop === 'recordCashFlow') return async (data: any) => dbProxy.cashFlow.add({ id: dbProxy.generateId('CF'), ...data });
    if (prop === 'saveAccountingEntry') return async (entry: any) => dbProxy.journalEntries.add(entry);
    if (prop === 'saveAccountingPeriod') return async (period: any) => dbProxy.accountingPeriods.put(period);
    if (prop === 'getValidationRules') return async () => [];
    if (prop === 'isDateLocked') return async (_date: string) => false;
    if (prop === 'addAuditLog') {
  return async (userId: string, action: string, targetType: string, details: string, tx?: any) => {
    const auditTable = tx?.auditLogs ?? dbProxy.auditLogs;

    return await auditTable.add({
      id: dbProxy.generateId('AUDIT'),
      userId,
      action,
      targetType,
      details,
      timestamp: new Date().toISOString()
    });
  };
    }
    if (prop === 'saveCurrency') return async (currency: any) => {
      const currencies = (await dbProxy.getCurrencies()) || [];
      await dbProxy.saveSetting('CURRENCIES', [...currencies.filter((c: any) => c.code !== currency.code), currency]);
    };
    if (prop === 'getExchangeRates') return async (_date?: string) => dbProxy.exchangeRates.toArray();
    if (prop === 'emergencyReset') return async () => { isDbBlocked = true; Object.values(memDb).forEach(store => store?.clear()); };

    if (prop === 'transaction') {
      return async (mode: any, ...args: any[]) => {
        const operation = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (isDbBlocked || !target.isOpen()) {
          try {
            if (!isDbBlocked && !target.isOpen()) await target.open();
          } catch {
            isDbBlocked = true;
          }
        }
        if (isDbBlocked) {
          return operation ? await operation({} as any) : undefined;
        }

        const rawTableArgs = args.slice(0, args.length - 1);
        const tableNames: string[] = [];
        const extractTableNames = (item: any) => {
          if (!item) return;
          if (Array.isArray(item)) {
            item.forEach(extractTableNames);
          } else if (typeof item === 'string') {
            tableNames.push(item);
          } else if (typeof item === 'object' && item.name && typeof item.name === 'string') {
            tableNames.push(item.name);
          }
        };
        rawTableArgs.forEach(extractTableNames);

        let thrownError: any = null;
        try {
          const validTables = tableNames.length > 0 ? tableNames : (target.tables ? target.tables.map(t => t.name) : ALL_SCHEMA_TABLE_NAMES);
          return await target.transaction(mode, validTables, async (tx: any) => {
            try {
              return operation ? await operation(tx) : undefined;
            } catch (err) {
              thrownError = err;
              throw err;
            }
          });
        } catch (txErr) {
          throw thrownError || txErr;
        }
      };
    }

    if (prop === 'safeTransaction' || prop === 'runTransaction') {
      return async (modeOrOp: any, tablesOrOp: any, op?: any) => {
        const operation = typeof modeOrOp === 'function' ? modeOrOp : op;
        if (isDbBlocked || !target.isOpen()) {
          try {
            if (!isDbBlocked && !target.isOpen()) await target.open();
          } catch {
            isDbBlocked = true;
          }
        }
        if (isDbBlocked) {
          return operation ? await operation({} as any) : undefined;
        }
        let thrownError: any = null;
        try {
          if (typeof (target as any)[prop] === 'function') {
            const wrappedOp = typeof modeOrOp === 'function' ? async (tx: any) => {
              try {
                return await modeOrOp(tx);
              } catch (e) {
                thrownError = e;
                throw e;
              }
            } : (op ? async (tx: any) => {
              try {
                return await op(tx);
              } catch (e) {
                thrownError = e;
                throw e;
              }
            } : undefined);

            const effectiveArgs = typeof modeOrOp === 'function' ? [wrappedOp] : [modeOrOp, tablesOrOp, wrappedOp];
            return await (target as any)[prop].apply(target, effectiveArgs);
          }
          return operation ? await operation({} as any) : undefined;
        } catch (txErr) {
          throw thrownError || txErr;
        }
      };
    }

    if (prop === 'getSetting') {
      return async (key: string, defaultValue: any = null) => {
        if (isDbBlocked) {
          const settingsTable = getMockTable('settings');
          const item = await settingsTable.get(key);
          return item ? item.value : defaultValue;
        }
        try {
          if (typeof target.getSetting === 'function') {
            return await target.getSetting(key, defaultValue);
          }
        } catch (err) {
          console.warn("[DB RESILIENT] Failed to run target.getSetting, falling back to mock:", err);
          isDbBlocked = true;
        }
        const settingsTable = getMockTable('settings');
        const item = await settingsTable.get(key);
        return item ? item.value : defaultValue;
      };
    }

    if (prop === 'saveSetting') {
      return async (key: string, value: any) => {
        if (isDbBlocked) {
          const settingsTable = getMockTable('settings');
          await settingsTable.put({ key, value });
          return;
        }
        try {
          if (typeof target.saveSetting === 'function') {
            return await target.saveSetting(key, value);
          }
        } catch (err) {
          console.warn("[DB RESILIENT] Failed to run target.saveSetting, falling back to mock:", err);
          isDbBlocked = true;
        }
        const settingsTable = getMockTable('settings');
        await settingsTable.put({ key, value });
      };
    }

    // Direct methods on target / prototype
    if (typeof (target as any)[prop] === 'function') {
      return (...args: any[]) => {
        try {
          return (target as any)[prop].apply(target, args);
        } catch (e) {
          console.warn(`[DB Proxy] Method "${String(prop)}" fallback notice:`, e);
          return null;
        }
      };
    }

    // Direct table reference if it exists on target
    if (prop in target) {
      const pVal = (target as any)[prop];
      if (pVal && typeof pVal === 'object' && typeof pVal.where === 'function') {
        return wrapTable(pVal, String(prop));
      }
      return pVal;
    }

    // Normalization & alias mappings for tables
    const propStr = String(prop).toLowerCase().replace(/_/g, '');
    
    // Check tables collection directly
    const foundTable = target.tables ? target.tables.find(t => {
      const tableName = t.name.toLowerCase().replace(/_/g, '');
      return tableName === propStr || tableName === propStr + 's' || tableName + 's' === propStr;
    }) : undefined;

    if (foundTable) {
      return wrapTable(foundTable, foundTable.name);
    }

    // Plural vs Singular Mappings
    const mappings: Record<string, string> = {
      'sale': 'invoices',
      'sales': 'invoices',
      'purchase': 'invoices',
      'purchases': 'invoices',
      'transaction': 'invoices',
      'transactions': 'invoices',
      'auditlog': 'auditLogs',
      'audit_log': 'auditLogs',
      'auditlogs': 'auditLogs',
      'medicinebatch': 'medicineBatches',
      'medicinebatches': 'medicineBatches',
      'voucherinvoicelink': 'vouchers',
      'voucher_invoice_links': 'vouchers',
      'draftinvoices': 'draft_in_voices',
      'draft_in_voices': 'draft_invoices'
    };

    const mappedName = mappings[propStr];
    if (mappedName && (target as any)[mappedName]) {
      return wrapTable((target as any)[mappedName], mappedName);
    }

    // Safe fallback table
    return getMockTable(mappedName || String(prop));
  }
});

export const db = dbProxy;

// Initialization with recovery logic
(async () => {
    try {
        await dbInstance.open();
        console.log("✅ PharmaFlow PRO DB Engine started successfully.");
    } catch (e: any) {
        console.warn("⚠️ Dexie Database Engine notice on startup, activating resilient mode:", (e as any)?.message || e);
        isDbBlocked = true;
    }
})();
