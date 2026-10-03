// src/shared/network/transport/unifiedTransport.ts

import { TokenProvider } from "@/services/auth/tokenProvider";
import { generateIdempotencyKey } from "@/shared/network/idempotency";
import { getActiveCorrelationId } from "@/core/observability/correlation";
import { observabilityService } from "@/core/observability/observabilityService";
import {
  Transport,
  RequestConfig,
  RequestOptions,
  RequestProfile,
  UnifiedNetworkError,
  NetworkErrorCode,
} from "./types";

/**
 * Enterprise Profile Default Configurations
 */
const PROFILE_DEFAULTS: Record<RequestProfile, { timeoutMs: number; retries: number; requireIdempotency: boolean }> = {
  FINANCIAL: { timeoutMs: 30000, retries: 3, requireIdempotency: true },
  SYNC: { timeoutMs: 60000, retries: 2, requireIdempotency: true },
  AUTH: { timeoutMs: 15000, retries: 1, requireIdempotency: false },
  AI: { timeoutMs: 45000, retries: 2, requireIdempotency: false },
  OCR: { timeoutMs: 60000, retries: 1, requireIdempotency: false },
  UPLOAD: { timeoutMs: 120000, retries: 1, requireIdempotency: false },
  DEFAULT: { timeoutMs: 15000, retries: 2, requireIdempotency: false },
};

let inMemoryDeviceId: string | null = null;

/**
 * Helper to get or generate stable Device ID
 */
function getStableDeviceId(): string {
  const session = TokenProvider.getCurrentSession();
  if (session?.deviceId) return session.deviceId;
  if (!inMemoryDeviceId) {
    inMemoryDeviceId = `PF-DEV-${generateIdempotencyKey().slice(0, 8).toUpperCase()}`;
  }
  return inMemoryDeviceId;
}

/**
 * Creates a normalized UnifiedNetworkError
 */
export function createNetworkError(
  message: string,
  code: NetworkErrorCode,
  options?: { status?: number; requestId?: string; retryable?: boolean; originalError?: unknown }
): UnifiedNetworkError {
  const error = new Error(message) as UnifiedNetworkError;
  error.code = code;
  error.status = options?.status;
  error.requestId = options?.requestId;
  error.retryable = options?.retryable ?? false;
  error.originalError = options?.originalError;
  return error;
}

/**
 * Map HTTP status code to NetworkErrorCode
 */
function mapStatusToErrorCode(status: number): NetworkErrorCode {
  switch (status) {
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 409: return 'CONFLICT';
    case 422: return 'VALIDATION_ERROR';
    case 429: return 'RATE_LIMITED';
    case 500:
    case 502:
    case 503:
    case 504: return 'SERVER_ERROR';
    default: return 'UNKNOWN_NETWORK_ERROR';
  }
}

/**
 * Check if HTTP status or error is retryable
 */
function isRetryable(status?: number, errName?: string): boolean {
  if (errName === 'AbortError') return false;
  if (!status) return true; // Network errors are retryable
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

/**
 * Unified Network Transport Engine
 * Single Source of Truth for Enterprise HTTP Traffic in PharmaFlow PRO ERP.
 */
export class UnifiedTransport implements Transport {
  private static instance: UnifiedTransport;

  public static getInstance(): UnifiedTransport {
    if (!UnifiedTransport.instance) {
      UnifiedTransport.instance = new UnifiedTransport();
    }
    return UnifiedTransport.instance;
  }

  /**
   * Main HTTP Request Execution Pipeline
   */
  public async request<T>(config: RequestConfig): Promise<T> {
    const profile = config.profile || 'DEFAULT';
    const profileDef = PROFILE_DEFAULTS[profile];

    const timeoutMs = config.timeoutMs ?? profileDef.timeoutMs;
    const maxRetries = config.retries ?? profileDef.retries;
    const method = (config.method || 'GET').toUpperCase();
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    // Check offline status first to prevent retry storms
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw createNetworkError('Network is offline. Request aborted.', 'NETWORK_OFFLINE', { retryable: false });
    }

    // Context Resolution
    const session = TokenProvider.getCurrentSession();
    const tenantId = config.tenantId || session.tenantId || '';
    const branchId = config.branchId || session.branchId || '';
    const userId = config.userId || session.user?.id || session.user?.user_id || '';
    const deviceId = config.deviceId || getStableDeviceId();
    const requestId = generateIdempotencyKey();

    // Idempotency Resolution (Reuse exact key across retries)
    const idempotencyKey = config.idempotencyKey || 
      (isMutating && (profileDef.requireIdempotency || profile === 'FINANCIAL') ? generateIdempotencyKey() : undefined);

    // Auth Resolution
    const authHeaders: Record<string, string> = {};
    if (!config.skipAuth) {
      const rawAuth = TokenProvider.getAuthHeaders();
      if (rawAuth.Authorization) authHeaders['Authorization'] = rawAuth.Authorization;
      if (rawAuth['x-tenant-id']) authHeaders['x-tenant-id'] = rawAuth['x-tenant-id'];
      if (rawAuth['x-branch-id']) authHeaders['x-branch-id'] = rawAuth['x-branch-id'];
    }

    const correlationId = getActiveCorrelationId();

    // Build Request Headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
      'X-Correlation-ID': correlationId,
      'X-Device-ID': deviceId,
      ...(tenantId ? { 'X-Tenant-ID': tenantId } : {}),
      ...(branchId ? { 'X-Branch-ID': branchId } : {}),
      ...(userId ? { 'X-User-ID': userId } : {}),
      ...authHeaders,
      ...Object.fromEntries(
        Object.entries(config.headers || {}).map(([k, v]) => [k, String(v)])
      ),
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
      headers['X-Idempotency-Key'] = idempotencyKey;
    }

    // Prepare Body
    let bodyData: BodyInit | null = null;
    if (config.body !== undefined && config.body !== null) {
      if (typeof config.body === 'string' || config.body instanceof FormData || config.body instanceof Blob) {
        bodyData = config.body as BodyInit;
      } else {
        bodyData = JSON.stringify(config.body);
      }
    }

    let attempt = 0;
    let refreshedToken = false;

    while (attempt <= maxRetries) {
      const controller = new AbortController();
      let timer: any = null;

      if (config.signal) {
        config.signal.addEventListener('abort', () => controller.abort());
      }

      timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[UnifiedTransport] ${method} ${config.url} (Attempt ${attempt + 1}/${maxRetries + 1}, Profile: ${profile}, ReqID: ${requestId.slice(0, 8)})`);
        }

        const response = await fetch(config.url, {
          method,
          headers,
          body: bodyData,
          signal: controller.signal,
          mode: config.mode,
          credentials: config.credentials,
        });

        clearTimeout(timer);

        // Handle 401 Single-Flight Token Refresh
        if (response.status === 401 && !config.skipAuth && !config.url.includes('/api/auth/') && !config.url.includes('/api/v1/auth/')) {
          if (typeof navigator !== 'undefined' && navigator.onLine && !refreshedToken) {
            refreshedToken = true;
            try {
              const newToken = await TokenProvider.refreshAccessToken();
              if (newToken) {
                headers['Authorization'] = `Bearer ${newToken}`;
                // Re-attempt immediately with refreshed token
                continue;
              }
            } catch {
              // Token refresh failed, proceed to error throw
            }
          }
          throw createNetworkError('Unauthorized session or token expired', 'UNAUTHORIZED', {
            status: 401,
            requestId,
            retryable: false,
          });
        }

        if (!response.ok) {
          const status = response.status;
          const bodyText = await response.text().catch(() => '');
          const retryable = isRetryable(status);
          const errorCode = mapStatusToErrorCode(status);

          // Handle 429 Rate Limiting Retry-After
          let retryAfterMs = 0;
          if (status === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            if (retryAfterHeader) {
              const seconds = parseInt(retryAfterHeader, 10);
              if (!isNaN(seconds)) {
                retryAfterMs = seconds * 1000;
              }
            }
          }

          const netErr = createNetworkError(
            `HTTP ${status}: ${bodyText || response.statusText}`,
            errorCode,
            { status, requestId, retryable, originalError: bodyText }
          );

          if (!retryable || attempt >= maxRetries) {
            throw netErr;
          }

          // Delay for retryable status
          attempt++;
          const baseDelay = retryAfterMs || Math.pow(2, attempt) * 1000;
          const jitter = Math.random() * 200;
          await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
          continue;
        }

        if (config.raw) {
          return response as unknown as T;
        }

        // Parse Response Body
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const json = await response.json().catch(() => ({}));
          return json as T;
        } else {
          const text = await response.text().catch(() => '');
          return text as unknown as T;
        }

      } catch (err: any) {
        clearTimeout(timer);

        if (err.name === 'AbortError') {
          throw createNetworkError(`Request timed out after ${timeoutMs}ms or was cancelled`, 'NETWORK_TIMEOUT', {
            requestId,
            retryable: false,
            originalError: err,
          });
        }

        if (err.code && typeof err.code === 'string' && err.code.startsWith('NETWORK_')) {
          // Already normalized UnifiedNetworkError
          if (!err.retryable || attempt >= maxRetries) {
            observabilityService.recordError(err, { feature: 'NETWORK' }, 'NETWORK', 'ERROR').catch(() => {});
            throw err;
          }
        }

        attempt++;
        if (attempt > maxRetries) {
          if (err.code) throw err;
          throw createNetworkError(err.message || 'Network request failed', 'UNKNOWN_NETWORK_ERROR', {
            requestId,
            retryable: false,
            originalError: err,
          });
        }

        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw createNetworkError('Request failed after max retries', 'UNKNOWN_NETWORK_ERROR', {
      requestId,
      retryable: false,
    });
  }

  public async get<T>(url: string, config?: RequestOptions): Promise<T> {
    return this.request<T>({ ...config, url, method: 'GET' });
  }

  public async post<T>(url: string, body?: unknown, config?: RequestOptions): Promise<T> {
    return this.request<T>({ ...config, url, method: 'POST', body });
  }

  public async put<T>(url: string, body?: unknown, config?: RequestOptions): Promise<T> {
    return this.request<T>({ ...config, url, method: 'PUT', body });
  }

  public async patch<T>(url: string, body?: unknown, config?: RequestOptions): Promise<T> {
    return this.request<T>({ ...config, url, method: 'PATCH', body });
  }

  public async delete<T>(url: string, config?: RequestOptions): Promise<T> {
    return this.request<T>({ ...config, url, method: 'DELETE' });
  }
}

// Global Singleton Export
export const unifiedTransport = UnifiedTransport.getInstance();
