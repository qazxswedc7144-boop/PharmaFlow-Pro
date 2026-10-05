import { PrismaClient } from "@prisma/client";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;

export class OfflineDatabaseError extends Error {
  constructor(model: string, operation: string) {
    super(`Database unavailable (Can't reach database). Cannot perform ${operation} on ${model}.`);
    this.name = 'OfflineDatabaseError';
  }
}

let basePrisma: PrismaClient | null = null;
let isDatabaseDisabled = false;
let disabledUntil = 0;

function isConnectionError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || err?.cause || err?.kind || err || "");
  const code = String(err?.code || "");
  const name = String(err?.name || "");
  if (name) {}

  // ONLY real connection/network error codes from Prisma
  if (['P1001', 'P1002', 'P1008', 'P1010', 'P1017', 'P2024'].includes(code)) return true;

  // Network errors
  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes("Can't reach database") ||
    msg.includes('Connection pool timeout') ||
    msg.includes('Kind: Closed')
  ) return true;

  // Offline error class
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

function getOfflineProxy(): PrismaClient {
  return new Proxy({} as any, {
    get: (_target, prop) => {
      if (prop === '$connect' || prop === '$disconnect') return async () => {};
      
      // In production, the proxy should throw for all operations to prevent silent failures
      if (isProduction) {
        return async () => {
          throw new OfflineDatabaseError('Prisma', String(prop));
        };
      }

      if (prop === '$transaction') {
        return async () => {
          throw new OfflineDatabaseError('Prisma', '$transaction');
        };
      }
      if (prop === '$queryRaw' || prop === '$executeRaw' || prop === '$executeRawUnsafe' || prop === '$queryRawUnsafe') {
        return async () => [];
      }
      
      return new Proxy({}, {
        get: (_modelTarget, modelProp) => {
          const operation = String(modelProp);
          
          // Read operations
          if (['findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow'].includes(operation)) {
            return async () => null;
          }
          if (['findMany', 'groupBy'].includes(operation)) {
            return async () => [];
          }
          if (operation === 'count') {
            return async () => 0;
          }
          
          // Write operations
          if (['createMany', 'updateMany', 'deleteMany'].includes(operation)) {
            return async () => ({ count: 0 });
          }
          if (['create', 'update', 'delete', 'upsert'].includes(operation)) {
            return async () => ({ id: 'offline-' + Date.now(), createdAt: new Date(), updatedAt: new Date() });
          }
          
          return async () => null;
        }
      });
    }
  });
}

// Resilient wrapper with exponential backoff and auto-reconnection
async function withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
  if (isDatabaseDisabled || (disabledUntil > 0 && Date.now() < disabledUntil)) {
    return handleOfflineFallback<T>(operationName);
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await operation();
    } catch (error: any) {
      if (isConnectionError(error)) {
        isDatabaseDisabled = true;
        if (basePrisma) {
          const clientToDisconnect = basePrisma;
          basePrisma = null;
          try {
            clientToDisconnect.$disconnect().catch(() => {});
          } catch {
            // ignore
          }
        }
        console.info(`[Prisma] Offline/local mode activated for '${operationName}'.`);
        break;
      }

      if (i < MAX_RETRIES - 1) {
        const delay = INITIAL_DELAY * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.info(`[Prisma] Handled fallback for '${operationName}'.`);
      }
    }
  }

  return handleOfflineFallback<T>(operationName);
}

function getPrismaClient(): PrismaClient {
  if (isDatabaseDisabled || (disabledUntil > 0 && Date.now() < disabledUntil)) {
    return getOfflineProxy();
  }

  if (basePrisma) return basePrisma;

  let databaseUrl = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, '');
  
  const isValidUrl = databaseUrl && databaseUrl !== "undefined" && databaseUrl !== "null" && databaseUrl !== "" && databaseUrl.includes("://");
  if (!isValidUrl) {
    console.info("[Prisma] DATABASE_URL is not set or empty. Running in offline/local mode.");
    isDatabaseDisabled = true;
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
    console.info("[Prisma] Bypassing direct Prisma connection. Defaulting to local offline proxy.");
    isDatabaseDisabled = true;
    return getOfflineProxy();
  }
}

// Resilient dynamic proxy wrapper
const prismaTarget: any = {
  disable: () => {
    isDatabaseDisabled = true;
    console.warn("[Prisma] Database client disabled due to persistent connection failures.");
  },
  enable: () => {
    isDatabaseDisabled = false;
    disabledUntil = 0;
    console.log("[Prisma] Database client re-enabled.");
  },
  isConnected: () => !isDatabaseDisabled && (disabledUntil === 0 || Date.now() >= disabledUntil),
};

const prismaClient = new Proxy(prismaTarget, {
  get(_target, prop, receiver) {
    if (_target[prop] !== undefined && (prop === 'isConnected' || prop === 'disable' || prop === 'enable')) {
      return _target[prop];
    }

    const currentClient = getPrismaClient();

    // Standard behavior for essential properties
    if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') {
      return Reflect.get(currentClient, prop, receiver);
    }

    const value = (currentClient as any)[prop];

    // Handle top-level functions directly
    if (typeof value === 'function') {
      if (prop === '$transaction') {
        return (callback: any, options?: any) => withRetry(() => (getPrismaClient() as any).$transaction(callback, options), '$transaction');
      }
      return value.bind(currentClient);
    }

    // Handle models (objects that don't start with '$')
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

