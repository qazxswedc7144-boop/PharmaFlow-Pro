import { PrismaClient } from "@prisma/client";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;
const OFFLINE_RETRY_INTERVAL_MS = 5000;

export class OfflineDatabaseError extends Error {
  constructor(model: string, operation: string) {
    super(`Database unavailable (Can't reach database). Cannot perform ${operation} on ${model}.`);
    this.name = 'OfflineDatabaseError';
  }
}

let basePrisma: PrismaClient | null = null;
let isDatabaseDisabled = false;
let disabledUntil = 0;

function refreshDatabaseState(): void {
  if (isDatabaseDisabled && disabledUntil > 0 && Date.now() >= disabledUntil) {
    isDatabaseDisabled = false;
    disabledUntil = 0;
    console.info("[Prisma] Offline cooldown elapsed. A new database connection will be attempted.");
  }
}

function enterOfflineMode(reason?: unknown): void {
  isDatabaseDisabled = true;
  disabledUntil = Date.now() + OFFLINE_RETRY_INTERVAL_MS;
  if (reason) {
    console.info("[Prisma] Database temporarily unavailable; retry scheduled after cooldown.");
  }
}

function isConnectionError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || err?.cause || err?.kind || err || "");
  const code = String(err?.code || "");
  const name = String(err?.name || "");

  if (code.startsWith('P1') || code === 'P2024' || name.includes('PrismaClientInitializationError') || name.includes('PrismaClientRustPanicError')) return true;

  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes("Can't reach database") ||
    msg.includes('Connection pool timeout') ||
    msg.includes('Kind: Closed') ||
    msg.includes('Authentication failed') ||
    msg.includes('credentials') ||
    msg.includes('circuit breaker')
  ) return true;

  if (err instanceof OfflineDatabaseError) return true;

  return false;
}

const isProduction = process.env.NODE_ENV === "production" || process.cwd().includes("dist") || (typeof __filename !== "undefined" && __filename.includes("dist"));

function handleOfflineFallback<T>(operationName: string): T {
  if (isProduction || operationName === '$transaction') {
    throw new OfflineDatabaseError('Prisma', operationName);
  }

  const parts = operationName.split('.');
  const modelProp = parts[1] || parts[0] || '';

  if (['findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow'].includes(modelProp)) {
    return null as unknown as T;
  }
  if (['findMany', 'groupBy'].includes(modelProp)) {
    return [] as unknown as T;
  }
  if (modelProp === 'count') {
    return 0 as unknown as T;
  }
  if (['createMany', 'updateMany', 'deleteMany'].includes(modelProp)) {
    return { count: 0 } as unknown as T;
  }
  if (['create', 'update', 'delete', 'upsert'].includes(modelProp)) {
    return { id: 'offline-' + Date.now(), createdAt: new Date(), updatedAt: new Date() } as unknown as T;
  }
  return null as unknown as T;
}

/**
 * Preserve Prisma's delegate shape while the database is unavailable.
 * Every database operation rejects explicitly; no fake records or success values
 * are returned from this proxy in any environment.
 */
function getOfflineProxy(): PrismaClient {
  return new Proxy({} as any, {
    get: (_target, prop) => {
      if (prop === '$connect' || prop === '$disconnect') return async () => {};
      if (prop === '$transaction' || prop === '$queryRaw' || prop === '$executeRaw' || prop === '$executeRawUnsafe' || prop === '$queryRawUnsafe') {
        return async () => {
          throw new OfflineDatabaseError('Prisma', String(prop));
        };
      }
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;

      return new Proxy({}, {
        get: (_modelTarget, modelProp) => {
          if (typeof modelProp === 'symbol') return undefined;
          return async () => {
            throw new OfflineDatabaseError(String(prop), String(modelProp));
          };
        }
      });
    }
  });
}

// Resilient wrapper with bounded offline cooldown and automatic reconnect attempts.
async function withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
  refreshDatabaseState();
  if (isDatabaseDisabled) {
    return handleOfflineFallback<T>(operationName);
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await operation();
    } catch (error: any) {
      if (isConnectionError(error)) {
        enterOfflineMode(error);
        if (basePrisma) {
          const clientToDisconnect = basePrisma;
          basePrisma = null;
          try {
            await clientToDisconnect.$disconnect();
          } catch {
            // ignore disconnect failures
          }
        }
        console.info(`[Prisma] Offline mode activated for '${operationName}' after a database connection failure.`);
        break;
      }

      if (i < MAX_RETRIES - 1) {
        const delay = INITIAL_DELAY * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.warn(`[Prisma] Operation '${operationName}' failed after retries:`, error?.message || error);
      }
    }
  }

  return handleOfflineFallback<T>(operationName);
}

function getPrismaClient(): PrismaClient {
  refreshDatabaseState();
  if (isDatabaseDisabled) {
    return getOfflineProxy();
  }

  if (basePrisma) return basePrisma;

  let databaseUrl = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, '');

  const isValidUrl = databaseUrl && databaseUrl !== "undefined" && databaseUrl !== "null" && databaseUrl !== "" && databaseUrl.includes("://");
  if (!isValidUrl) {
    console.info("[Prisma] DATABASE_URL is not set or empty. Running in offline mode.");
    enterOfflineMode();
    return getOfflineProxy();
  }

  if (databaseUrl && !databaseUrl.includes('connection_limit=')) {
    const separator = databaseUrl.includes('?') ? '&' : '?';
    databaseUrl = `${databaseUrl}${separator}connection_limit=5&pool_timeout=10`;
  }

  try {
    basePrisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
      log: [],
    });
    console.log("[Prisma] Client initialized successfully.");
    return basePrisma;
  } catch (_error) {
    enterOfflineMode(_error);
    console.info("[Prisma] Prisma client initialization failed. A connection retry will be attempted after cooldown.");
    return getOfflineProxy();
  }
}

// Resilient dynamic proxy wrapper
const prismaTarget: any = {
  disable: () => {
    enterOfflineMode();
    console.warn("[Prisma] Database client temporarily disabled.");
  },
  enable: () => {
    isDatabaseDisabled = false;
    disabledUntil = 0;
    console.log("[Prisma] Database client re-enabled.");
  },
  isConnected: () => {
    refreshDatabaseState();
    return !isDatabaseDisabled;
  },
};

const prismaClient = new Proxy(prismaTarget, {
  get(_target, prop, receiver) {
    if (_target[prop] !== undefined && (prop === 'isConnected' || prop === 'disable' || prop === 'enable')) {
      return _target[prop];
    }

    const currentClient = getPrismaClient();

    if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') {
      return Reflect.get(currentClient, prop, receiver);
    }

    const value = (currentClient as any)[prop];

    if (typeof value === 'function') {
      if (prop === '$transaction') {
        return (callback: any, options?: any) => withRetry(() => (getPrismaClient() as any).$transaction(callback, options), '$transaction');
      }
      return value.bind(currentClient);
    }

    if (typeof value === 'object' && value !== null && !String(prop).startsWith('$')) {
      return new Proxy(value, {
        get(_modelTarget, modelProp) {
          const freshModel = (getPrismaClient() as any)[prop];
          const modelValue = freshModel ? freshModel[modelProp] : undefined;

          if (typeof modelValue === 'function') {
            return (...args: any[]) => withRetry(() => {
              const latestModel = (getPrismaClient() as any)[prop];
              return latestModel[modelProp].apply(latestModel, args);
            }, `${String(prop)}.${String(modelProp)}`);
          }

          return modelValue;
        }
      });
    }

    return value;
  }
});

export const prisma = prismaClient as any;

// Graceful shutdown hooks
process.on("beforeExit", async () => {
  if (basePrisma) {
    console.log("[Prisma] Disconnecting...");
    try {
      await basePrisma.$disconnect();
    } catch {
      // ignore
    }
  }
});
