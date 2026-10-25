// server/modules/sync/device.service.ts
// Device Identity and Access Control Engine for Phase 8.3 Enterprise Synchronization

import { DeviceIdentity, DeviceStatus, SYNC_PROTOCOL_VERSION } from "./sync.types.js";
import { prisma } from "../../database/prisma.js";

export class DeviceService {
  // In-memory caching layer with durable Prisma fallback
  private static deviceCache = new Map<string, DeviceIdentity>();

  /**
   * Generates composite device cache key scoped by tenant
   */
  private static getCacheKey(tenantId: string, deviceId: string): string {
    return `${tenantId}:${deviceId}`;
  }

  /**
   * Registers a new device or updates an existing device identity record
   */
  static async registerDevice(data: {
    deviceId: string;
    installationId?: string;
    deviceName: string;
    tenantId: string;
    branchId: string;
    userId: string;
    appVersion: string;
    schemaVersion?: number;
    initialSequence?: number;
    initialVector?: Record<string, number>;
  }): Promise<DeviceIdentity> {
    const now = new Date();
    const cacheKey = this.getCacheKey(data.tenantId, data.deviceId);

    const existing = this.deviceCache.get(cacheKey);
    let status: DeviceStatus = "ACTIVE";

    if (existing && (existing.status === "REVOKED" || existing.status === "SUSPENDED")) {
      // If a device was explicitly revoked by security admin, keep it revoked
      status = existing.status;
    }

    const record: DeviceIdentity = {
      deviceId: data.deviceId,
      installationId: data.installationId || existing?.installationId || `INST-${data.deviceId}`,
      deviceName: data.deviceName || "Unidentified POS Device",
      tenantId: data.tenantId,
      branchId: data.branchId,
      userId: data.userId,
      lastSeenAt: now.toISOString(),
      appVersion: data.appVersion || "1.0.0",
      schemaVersion: data.schemaVersion || SYNC_PROTOCOL_VERSION,
      status,
      syncHealth: status === "ACTIVE" ? "HEALTHY" : "UNHEALTHY",
      lastSyncedSequence: data.initialSequence || existing?.lastSyncedSequence || 0,
      lastAcknowledgedSequence: data.initialSequence || existing?.lastAcknowledgedSequence || 0,
      versionVector: data.initialVector || existing?.versionVector || { [data.deviceId]: 0 },
      registeredAt: existing?.registeredAt || now.toISOString(),
      revokedAt: existing?.revokedAt || null,
      revocationReason: existing?.revocationReason || null
    };

    this.deviceCache.set(cacheKey, record);

    // Persist to Prisma database when available
    if (prisma.isConnected && prisma.isConnected()) {
      try {
        await prisma.deviceRegistration.upsert({
          where: { deviceId: data.deviceId },
          update: {
            deviceName: data.deviceName,
            tenantId: data.tenantId,
            branchId: data.branchId,
            appVersion: data.appVersion,
            lastSync: now
          },
          create: {
            deviceId: data.deviceId,
            deviceName: data.deviceName,
            tenantId: data.tenantId,
            branchId: data.branchId,
            appVersion: data.appVersion,
            lastSync: now,
            createdAt: now
          }
        }).catch((err) => {
          console.warn("[DeviceService] Prisma device registration warning:", err.message);
        });
      } catch (err: any) {
        console.warn("[DeviceService] Persistence warning:", err.message);
      }
    }

    return record;
  }

  /**
   * Retrieves device record with dynamically computed sync health
   */
  static async getDevice(tenantId: string, deviceId: string): Promise<DeviceIdentity | (DeviceIdentity & { lastSeen: string }) | null> {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    const dev = this.deviceCache.get(cacheKey);
    if (!dev) return null;

    const now = Date.now();
    const lastSeenMs = new Date(dev.lastSeenAt).getTime();
    const ageSeconds = Math.max(0, (now - lastSeenMs) / 1000);

    // Dynamically evaluate sync health based on age, sequence lag, and security status
    let health: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "STALE" = "HEALTHY";
    const sequenceLag = Math.max(0, (dev.lastSyncedSequence || 0) - (dev.lastAcknowledgedSequence || 0));

    if (dev.status === "REVOKED" || dev.status === "SUSPENDED") {
      health = "UNHEALTHY";
    } else if (sequenceLag > 100) {
      health = "DEGRADED";
    } else if (ageSeconds > 3600) {
      health = "UNHEALTHY";
      if (dev.status === "ACTIVE") dev.status = "OFFLINE";
    } else if (ageSeconds > 600) {
      health = "STALE";
      if (dev.status === "ACTIVE") dev.status = "STALE";
    } else if (ageSeconds > 120 || sequenceLag > 20) {
      health = "DEGRADED";
    }

    dev.syncHealth = health;
    const lastSeenStr = dev.lastSeenAt instanceof Date ? dev.lastSeenAt.toISOString() : String(dev.lastSeenAt || new Date().toISOString());
    return {
      ...dev,
      lastSeen: lastSeenStr
    };
  }

  /**
   * Verifies if a device is allowed to synchronize
   */
  static async verifyDevice(tenantId: string, deviceId: string): Promise<{
    allowed: boolean;
    status: DeviceStatus;
    reason?: string;
    device?: DeviceIdentity;
  }> {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    let device = this.deviceCache.get(cacheKey);

    // If not in cache, check database
    if (!device && prisma.isConnected && prisma.isConnected()) {
      try {
        const dbDevice = await prisma.deviceRegistration.findUnique({
          where: { deviceId }
        }).catch(() => null);

        if (dbDevice) {
          device = {
            deviceId: dbDevice.deviceId,
            deviceName: dbDevice.deviceName,
            tenantId: dbDevice.tenantId,
            branchId: dbDevice.branchId,
            userId: "system",
            lastSeenAt: dbDevice.lastSync.toISOString(),
            appVersion: dbDevice.appVersion || "1.0.0",
            schemaVersion: SYNC_PROTOCOL_VERSION,
            status: "ACTIVE",
            registeredAt: dbDevice.createdAt.toISOString()
          };
          this.deviceCache.set(cacheKey, device);
        }
      } catch (err: any) {
        console.warn("[DeviceService] Error querying device:", err.message);
      }
    }

    // If device is completely unknown, return UNKNOWN with allowed grace
    if (!device) {
      return {
        allowed: true,
        status: "UNKNOWN"
      };
    }

    if (device.status === "REVOKED") {
      return {
        allowed: false,
        status: "REVOKED",
        reason: device.revocationReason || "تم إيقاف والغاء اعتماد هذا الجهاز من قبل إدارة أمن النظام.",
        device
      };
    }

    if (device.status === "SUSPENDED") {
      return {
        allowed: false,
        status: "SUSPENDED",
        reason: "تم تعليق هذا الجهاز مؤقتاً لمراجعة صلاحيات الأمان.",
        device
      };
    }

    return {
      allowed: true,
      status: "ACTIVE",
      device
    };
  }

  /**
   * Updates lastSeen heartbeat for a device
   */
  static touchDevice(tenantId: string, deviceId: string): void {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    const existing = this.deviceCache.get(cacheKey);
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      this.deviceCache.set(cacheKey, existing);
    }
  }

  /**
   * Records heartbeat explicitly
   */
  static async recordHeartbeat(tenantId: string, deviceId: string): Promise<void> {
    this.touchDevice(tenantId, deviceId);
  }

  /**
   * Updates device operational status (e.g. security revocation or suspension)
   */
  static async updateDeviceStatus(
    tenantId: string,
    deviceId: string,
    status: DeviceStatus,
    reason?: string
  ): Promise<DeviceIdentity | null> {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    let device = this.deviceCache.get(cacheKey);

    if (!device) {
      device = {
        deviceId,
        deviceName: "POS Device",
        tenantId,
        branchId: "",
        userId: "admin",
        lastSeenAt: new Date().toISOString(),
        appVersion: "8.3.0",
        schemaVersion: SYNC_PROTOCOL_VERSION,
        status: "ACTIVE"
      };
    }

    device.status = status;
    if (status === "REVOKED") {
      device.revokedAt = new Date().toISOString();
      device.revocationReason = reason || "Security Policy Revocation";
    } else if (status === "ACTIVE") {
      device.revokedAt = null;
      device.revocationReason = null;
    } else if (status === "SUSPENDED") {
      device.revocationReason = reason || "Suspension Policy";
    }

    this.deviceCache.set(cacheKey, device);
    return device;
  }

  /**
   * Quick security check for device authorization
   */
  static getDeviceSecurityStatus(tenantId: string, deviceId: string): { isAuthorized: boolean; status: DeviceStatus; reason?: string } {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    const device = this.deviceCache.get(cacheKey);
    if (!device) {
      return { isAuthorized: true, status: "ACTIVE" };
    }
    if (device.status === "REVOKED") {
      return { isAuthorized: false, status: "REVOKED", reason: device.revocationReason || "Revoked by Administrator" };
    }
    if (device.status === "SUSPENDED") {
      return { isAuthorized: false, status: "SUSPENDED", reason: device.revocationReason || "Suspended by Administrator" };
    }
    return { isAuthorized: true, status: "ACTIVE" };
  }

  /**
   * List all registered devices for a given tenant or all tenants if '*'
   */
  static getTenantDevices(tenantId: string): DeviceIdentity[] {
    const devices: DeviceIdentity[] = [];
    for (const [key, dev] of this.deviceCache.entries()) {
      if (tenantId === '*' || key.startsWith(`${tenantId}:`)) {
        devices.push(dev);
      }
    }
    return devices;
  }

  /**
   * Updates last synced sequence cursor and acknowledged sequence for a device
   */
  static updateDeviceSequence(
    tenantId: string,
    deviceId: string,
    params: { syncedSequence?: number; ackSequence?: number }
  ): DeviceIdentity | null {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    const device = this.deviceCache.get(cacheKey);
    if (!device) return null;

    if (params.syncedSequence !== undefined) {
      device.lastSyncedSequence = Math.max(device.lastSyncedSequence || 0, params.syncedSequence);
    }
    if (params.ackSequence !== undefined) {
      device.lastAcknowledgedSequence = Math.max(device.lastAcknowledgedSequence || 0, params.ackSequence);
    }
    device.lastSeenAt = new Date().toISOString();
    this.deviceCache.set(cacheKey, device);
    return device;
  }

  /**
   * Updates or merges the version vector for a device
   */
  static updateVersionVector(
    tenantId: string,
    deviceId: string,
    vector: Record<string, number>
  ): DeviceIdentity | null {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    const device = this.deviceCache.get(cacheKey);
    if (!device) return null;

    device.versionVector = {
      ...(device.versionVector || {}),
      ...vector
    };
    device.lastSeenAt = new Date().toISOString();
    this.deviceCache.set(cacheKey, device);
    return device;
  }

  /**
   * Explicitly sets device sync health
   */
  static setDeviceHealth(
    tenantId: string,
    deviceId: string,
    health: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "STALE"
  ): DeviceIdentity | null {
    const cacheKey = this.getCacheKey(tenantId, deviceId);
    const device = this.deviceCache.get(cacheKey);
    if (!device) return null;

    device.syncHealth = health;
    this.deviceCache.set(cacheKey, device);
    return device;
  }
}
