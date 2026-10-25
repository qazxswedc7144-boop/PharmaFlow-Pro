import { describe, it, expect, vi, beforeEach } from "vitest";
import 'fake-indexeddb/auto';
import { db } from "../../src/core/db";
import { backupService } from "../../src/services/backupScheduler";
import { BackupService as CoreBackupService } from "../../src/services/backupService";
import jwt from "jsonwebtoken";
import { syncRouter } from "../modules/sync/sync.router";

// Mock CoreBackupService
vi.mock("../../src/services/backupService", () => {
  return {
    BackupService: {
      createBackup: vi.fn(async () => "test-backup-id"),
      exportBackupToFile: vi.fn(async () => new Blob(["test-content"]))
    }
  };
});

// Mock Express Response
const mockResponse = () => {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

describe("P0 Hotfix: Sync Metrics & Backup Scheduler Security Tests", () => {
  describe("PART A: Sync Metrics Tenant Safety (Router Logic)", () => {
    const metricsHandler = (syncRouter.stack.find(s => s.route?.path === '/metrics')?.route?.stack[0]?.handle) as any;

    it("1. metrics handler rejects if req.user.tenantId is missing", async () => {
      const req: any = { user: {} };
      const res = mockResponse();
      await metricsHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "TRUSTED_TENANT_CONTEXT_REQUIRED" }));
    });

    it("2. metrics handler rejects forbidden tenant 'TEN-DEV-001'", async () => {
      const req: any = { user: { tenantId: "TEN-DEV-001" } };
      const res = mockResponse();
      await metricsHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("3. metrics handler rejects 'default-tenant'", async () => {
      const req: any = { user: { tenantId: "default-tenant" } };
      const res = mockResponse();
      await metricsHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("4. metrics handler allows valid tenant", async () => {
      const req: any = { user: { tenantId: "REAL-TENANT-XYZ" } };
      const res = mockResponse();
      await metricsHandler(req, res);
      expect(res.status).toBeCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe("PART B: Backup Password Hardening", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      if (typeof indexedDB !== 'undefined' && db && db.settings) {
        await db.settings.clear();
      }
    });

    it("1. Backup with valid stored password should work", async () => {
      await db.saveSetting('backup_schedule_config', {
        enabled: true,
        frequency: 'daily',
        destination: 'local',
        password: 'my-secret-password'
      });

      const backupId = await backupService.runUnifiedBackup();
      expect(backupId).toBe("test-backup-id");
      expect(CoreBackupService.createBackup).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        false,
        'my-secret-password'
      );
    });

    it("2. Backup without password should fail closed", async () => {
      await db.saveSetting('backup_schedule_config', {
        enabled: true,
        frequency: 'daily',
        destination: 'local',
        password: undefined
      });

      await expect(backupService.runUnifiedBackup()).rejects.toThrow(/BACKUP_PASSWORD_REQUIRED/);
    });

    it("3. Backup should not use 'pharma-safe-123' as fallback", async () => {
      await expect(backupService.runUnifiedBackup({
        enabled: true,
        frequency: 'daily',
        destination: 'local'
      } as any)).rejects.toThrow(/BACKUP_PASSWORD_REQUIRED/);
      
      expect(CoreBackupService.createBackup).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        false,
        'pharma-safe-123'
      );
    });
  });
});
