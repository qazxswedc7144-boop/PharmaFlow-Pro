// ==========================================
// FILE: src/features/sync/device.manager.ts
// Phase 8.3 Persistent Device Identity Manager
// ==========================================

import { DeviceMetadata, SYNC_PROTOCOL_VERSION } from "./sync.types";
import { getCurrentUserSession } from "@/core/db";
import { configurationService } from "@/services/config/configurationService";
import { unifiedTransport } from "@/shared/network/transport/unifiedTransport";

const DEVICE_STORAGE_KEY = "pharmaflow_device_identity";

export class DeviceManager {
  private static cachedIdentity: DeviceMetadata | null = null;

  /**
   * Generates or retrieves persistent device identity
   */
  static getDeviceIdentity(): DeviceMetadata {
    const session = getCurrentUserSession();

    if (this.cachedIdentity) {
      return {
        ...this.cachedIdentity,
        tenantId: session.tenantId || this.cachedIdentity.tenantId,
        branchId: session.branchId || this.cachedIdentity.branchId,
        userId: session.userId || this.cachedIdentity.userId
      };
    }

    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
        if (raw) {
          const stored = JSON.parse(raw);
          if (stored && stored.deviceId) {
            this.cachedIdentity = {
              ...stored,
              tenantId: session.tenantId || stored.tenantId,
              branchId: session.branchId || stored.branchId,
              userId: session.userId || stored.userId
            };
            return this.cachedIdentity!;
          }
        }
      } catch {}
    }

    try {
      const stored = configurationService.getSync<DeviceMetadata>(DEVICE_STORAGE_KEY);
      if (stored && stored.deviceId) {
        this.cachedIdentity = {
          ...stored,
          tenantId: session.tenantId || stored.tenantId,
          branchId: session.branchId || stored.branchId,
          userId: session.userId || stored.userId
        };
        return this.cachedIdentity!;
      }
    } catch (err) {
      console.warn("[DeviceManager] Error reading stored device identity:", err);
    }

    // Generate fresh persistent device ID
    const randomUuid = (typeof crypto !== "undefined" && crypto.randomUUID) 
      ? crypto.randomUUID() 
      : Math.random().toString(36).substring(2, 15);
    const newDeviceId = `DEV-${randomUuid.substring(0, 12).toUpperCase()}`;
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "Desktop POS";
    const deviceName = userAgent.includes("Android") 
      ? "Android POS Terminal" 
      : (userAgent.includes("Mobile") ? "Mobile Terminal" : "Workstation Terminal");

    const identity: DeviceMetadata = {
      deviceId: newDeviceId,
      installationId: `INST-${newDeviceId}`,
      deviceName,
      tenantId: session.tenantId || "",
      branchId: session.branchId || "",
      userId: session.userId || "",
      status: "ACTIVE",
      syncHealth: "HEALTHY",
      lastSyncedSequence: 0,
      lastAcknowledgedSequence: 0,
      versionVector: { [newDeviceId]: 0 },
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };

    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity));
      } catch {}
    }

    this.cachedIdentity = identity;
    return identity;
  }

  /**
   * Updates local sequence cursors for this device
   */
  static updateSequence(syncedSequence?: number, ackSequence?: number): void {
    const identity = this.getDeviceIdentity();
    if (syncedSequence !== undefined) {
      identity.lastSyncedSequence = Math.max(identity.lastSyncedSequence || 0, syncedSequence);
    }
    if (ackSequence !== undefined) {
      identity.lastAcknowledgedSequence = Math.max(identity.lastAcknowledgedSequence || 0, ackSequence);
    }
    identity.lastSeenAt = new Date().toISOString();
    this.cachedIdentity = identity;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity));
      } catch {}
    }
  }

  /**
   * Updates version vector for this device
   */
  static updateVersionVector(vector: Record<string, number>): void {
    const identity = this.getDeviceIdentity();
    identity.versionVector = {
      ...(identity.versionVector || {}),
      ...vector
    };
    this.cachedIdentity = identity;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity));
      } catch {}
    }
  }

  /**
   * Registers or sends heartbeat for this device to the server
   */
  static async registerWithServer(): Promise<boolean> {
    if (typeof window === "undefined" || !navigator.onLine) return false;

    const identity = this.getDeviceIdentity();
    const session = getCurrentUserSession();

    try {
      const response = await unifiedTransport.post<any>("/api/v1/sync/device/register", {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        branchId: session.branchId || "",
        appVersion: "8.3.0",
        schemaVersion: SYNC_PROTOCOL_VERSION
      }, {
        headers: {
          "X-Tenant-ID": session.tenantId || "",
          "X-Branch-ID": session.branchId || "",
          "X-Device-ID": identity.deviceId
        },
        timeoutMs: 10000
      });

      const result = response.data;
      if (result && result.success && result.data) {
        identity.status = result.data.status || "ACTIVE";
        configurationService.set(DEVICE_STORAGE_KEY, identity).catch(() => {});
        return true;
      }
    } catch (err) {
      console.warn("[DeviceManager] Background device registration deferred:", err);
    }
    return false;
  }
}
