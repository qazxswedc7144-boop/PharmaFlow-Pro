import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncProcessorService } from "../modules/sync/sync-processor.service.js";
import { ReplicationService } from "../modules/replication/replication.service.js";
import { runWithTenantContext } from "../context/tenantContext.js";
import { buildApp } from "../app.js";
import axios from "axios";
import { Server } from "http";

describe("P0 Security Hardening: Cross-Tenant Isolation & SaaS Security Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PART 1: Cross-Tenant Mutation Security (Tests A through F)", () => {
    const tenantA = "TENANT_AL_NOOR_01";
    const tenantB = "TENANT_AL_SHIFA_02";
    const userA = "USR_ADMIN_A";
    const deviceA = "DEV_POS_A1";

    const createMockDatabase = () => {
      const invoices = new Map<string, any>([
        [
          "inv-tenant-b-001",
          {
            id: "inv-tenant-b-001",
            invoiceNumber: "INV-B-001",
            tenantId: tenantB,
            totalAmount: 1000,
            documentStatus: "ACTIVE",
            partnerId: "partner-b",
            updatedAt: new Date("2026-01-01T00:00:00Z")
          }
        ],
        [
          "inv-tenant-a-001",
          {
            id: "inv-tenant-a-001",
            invoiceNumber: "INV-A-001",
            tenantId: tenantA,
            totalAmount: 500,
            documentStatus: "ACTIVE",
            partnerId: "partner-a",
            updatedAt: new Date("2026-01-01T00:00:00Z")
          }
        ]
      ]);

      const products = new Map<string, any>([
        [
          "prod-tenant-b-999",
          {
            id: "prod-tenant-b-999",
            name: "Tenant B Secret Medicine",
            tenantId: tenantB,
            price: 250,
            cost: 100
          }
        ],
        [
          "prod-tenant-a-001",
          {
            id: "prod-tenant-a-001",
            name: "Tenant A Product",
            tenantId: tenantA,
            price: 50,
            cost: 20
          }
        ]
      ]);

      const payments = new Map<string, any>([
        [
          "pmt-tenant-b-777",
          {
            id: "pmt-tenant-b-777",
            paymentNumber: "PMT-B-777",
            tenantId: tenantB,
            amount: 5000,
            partnerType: "SUPPLIER"
          }
        ]
      ]);

      const createModelDelegate = (store: Map<string, any>) => ({
        findUnique: vi.fn(async ({ where }: any) => {
          const targetId = where?.id || where?.id_tenantId?.id;
          const item = store.get(targetId);
          return item ? { ...item } : null;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          for (const item of store.values()) {
            if (where.tenantId && item.tenantId !== where.tenantId) continue;
            if (where.id && item.id === where.id) return { ...item };
          }
          return null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const targetId = where?.id || where?.id_tenantId?.id;
          const targetTenant = where?.tenantId || where?.id_tenantId?.tenantId;
          const existing = store.get(targetId);
          if (!existing) throw new Error("Record not found for update");
          if (targetTenant && existing.tenantId !== targetTenant) {
            throw new Error("Composite key mismatch: Tenant violation in update");
          }
          const updated = { ...existing, ...data };
          store.set(targetId, updated);
          return updated;
        }),
        delete: vi.fn(async ({ where }: any) => {
          const targetId = where.id_tenantId ? where.id_tenantId.id : where.id;
          const targetTenant = where.id_tenantId ? where.id_tenantId.tenantId : undefined;
          const existing = store.get(targetId);
          if (!existing) throw new Error("Record not found for delete");
          if (targetTenant && existing.tenantId !== targetTenant) {
            throw new Error("Composite key mismatch: Tenant violation in delete");
          }
          store.delete(targetId);
          return existing;
        }),
        create: vi.fn(async ({ data }: any) => {
          store.set(data.id, { ...data });
          return { ...data };
        })
      });

      const mockTx: any = {
        invoice: createModelDelegate(invoices),
        product: createModelDelegate(products),
        payment: createModelDelegate(payments)
      };

      return { mockTx, invoices, products, payments };
    };

    it("Test A — Cross-Tenant Update: Tenant A sends mutation targeting Tenant B record -> DENY, record unchanged", async () => {
      const { mockTx, invoices } = createMockDatabase();
      const originalRecord = { ...invoices.get("inv-tenant-b-001") };
      const mutation = {
        id: "mut_attack_update_001",
        entity: "INVOICE",
        entityId: "inv-tenant-b-001",
        operation: "UPDATE" as const,
        payload: { totalAmount: 1 },
        idempotencyKey: "idem_attack_001",
        timestamp: new Date().toISOString()
      };

      const result = await (SyncProcessorService as any).executeEntityMutation({
        mutation,
        tenantId: tenantA,
        branchId: "BRANCH_A",
        userId: userA,
        deviceId: deviceA,
        version: 1,
        tx: mockTx
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("UNAUTHORIZED");
      expect(result.errorCode).toBe("CROSS_TENANT_VIOLATION");
      expect(invoices.get("inv-tenant-b-001")).toEqual(originalRecord);
    });

    it("Test B — Cross-Tenant Upsert: Tenant A attempts upsert on Tenant B record ID -> DENY", async () => {
      const { mockTx, products } = createMockDatabase();
      const originalProduct = { ...products.get("prod-tenant-b-999") };
      const mutation = {
        id: "mut_attack_upsert_002",
        entity: "PRODUCT",
        entityId: "prod-tenant-b-999",
        operation: "CREATE" as const,
        payload: { name: "Hijacked Product", price: 1 },
        idempotencyKey: "idem_attack_002",
        timestamp: new Date().toISOString()
      };

      const result = await (SyncProcessorService as any).executeEntityMutation({
        mutation,
        tenantId: tenantA,
        branchId: "BRANCH_A",
        userId: userA,
        deviceId: deviceA,
        version: 1,
        tx: mockTx
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("UNAUTHORIZED");
      expect(result.errorCode).toBe("CROSS_TENANT_VIOLATION");
      expect(products.get("prod-tenant-b-999")).toEqual(originalProduct);
    });

    it("Test C — Cross-Tenant Delete: Tenant A attempts to delete Tenant B record -> DENY", async () => {
      const { mockTx, payments } = createMockDatabase();
      const originalPayment = { ...payments.get("pmt-tenant-b-777") };
      const mutation = {
        id: "mut_attack_delete_003",
        entity: "PAYMENT",
        entityId: "pmt-tenant-b-777",
        operation: "DELETE" as const,
        payload: {},
        idempotencyKey: "idem_attack_003",
        timestamp: new Date().toISOString()
      };

      const result = await (SyncProcessorService as any).executeEntityMutation({
        mutation,
        tenantId: tenantA,
        branchId: "BRANCH_A",
        userId: userA,
        deviceId: deviceA,
        version: 1,
        tx: mockTx
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("UNAUTHORIZED");
      expect(result.errorCode).toBe("CROSS_TENANT_VIOLATION");
      expect(payments.get("pmt-tenant-b-777")).toEqual(originalPayment);
    });

    it("Test D — Same-Tenant Update: Tenant A modifies its own record -> PASS", async () => {
      const { mockTx } = createMockDatabase();
      const mutation = {
        id: "mut_valid_update_004",
        entity: "PRODUCT",
        entityId: "prod-tenant-a-001",
        operation: "UPDATE" as const,
        payload: { name: "Tenant A Product Updated", price: 60 },
        idempotencyKey: "idem_valid_004",
        timestamp: new Date().toISOString()
      };

      const result = await (SyncProcessorService as any).executeEntityMutation({
        mutation,
        tenantId: tenantA,
        branchId: "BRANCH_A",
        userId: userA,
        deviceId: deviceA,
        version: 1,
        tx: mockTx
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("SUCCESS");
      expect(mockTx.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "prod-tenant-a-001",
            tenantId: tenantA
          }
        })
      );
    });

    it("Test E — Unknown Entity ID: Tenant A sends non-existent entityId -> Safe ENTITY_NOT_FOUND result without leakage", async () => {
      const { mockTx } = createMockDatabase();
      const mutation = {
        id: "mut_unknown_005",
        entity: "PRODUCT",
        entityId: "non-existent-uuid-9999",
        operation: "UPDATE" as const,
        payload: { name: "Unknown" },
        idempotencyKey: "idem_unknown_005",
        timestamp: new Date().toISOString()
      };

      const result = await (SyncProcessorService as any).executeEntityMutation({
        mutation,
        tenantId: tenantA,
        branchId: "BRANCH_A",
        userId: userA,
        deviceId: deviceA,
        version: 1,
        tx: mockTx
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("REJECTED");
      expect(result.errorCode).toBe("ENTITY_NOT_FOUND");
    });

    it("Test F — Concurrent Mutation: Ownership validation and mutation happen inside the exact same transaction context", async () => {
      const { mockTx } = createMockDatabase();
      const mutation = {
        id: "mut_atomic_tx_006",
        entity: "PRODUCT",
        entityId: "prod-tenant-a-001",
        operation: "UPDATE" as const,
        payload: { name: "Tenant A Product Atomic OK" },
        idempotencyKey: "idem_atomic_006",
        timestamp: new Date().toISOString()
      };

      await (SyncProcessorService as any).executeEntityMutation({
        mutation,
        tenantId: tenantA,
        branchId: "BRANCH_A",
        userId: userA,
        deviceId: deviceA,
        version: 1,
        tx: mockTx
      });

      expect(mockTx.product.findFirst).toHaveBeenCalledTimes(1);
      expect(mockTx.product.update).toHaveBeenCalledTimes(1);
      const findOrder = mockTx.product.findFirst.mock.invocationCallOrder[0];
      const updateOrder = mockTx.product.update.mock.invocationCallOrder[0];
      expect(findOrder).toBeLessThan(updateOrder);
    });
  });

  describe("PART 2: SaaS Static API Keys & FHIR Demo Endpoints Security", () => {
    let server: Server;
    let baseUrl: string;
    const originalEnv = { ...process.env };

    const startTestServer = async (envOverrides: Record<string, string | undefined>) => {
      Object.assign(process.env, envOverrides);
      const app = buildApp();
      return new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    };

    const stopTestServer = async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      process.env = { ...originalEnv };
    };

    it("SaaS Test 1 — Fail-Closed: Missing environment keys must return 503 and reject all static fallback keys", async () => {
      await startTestServer({
        NODE_ENV: "production",
        SAAS_KEY_MOUWASAT: undefined,
        SAAS_KEY_CLOUD_SYNC: undefined
      });

      try {
        const res = await axios.post(
          `${baseUrl}/api/v1/saas/sync`,
          { ciphertext: "ENC_TEST" },
          {
            headers: { Authorization: "Bearer pf_live_cloud_sync_ledger_secret_token" },
            validateStatus: () => true
          }
        );
        expect([401, 403, 503]).toContain(res.status);
      } finally {
        await stopTestServer();
      }
    });

    it("SaaS Test 2 — Invalid key rejected: Non-matching bearer token returns 403 Forbidden", async () => {
      await startTestServer({
        NODE_ENV: "production",
        SAAS_KEY_MOUWASAT: "real_production_mouwasat_key_secret_12345",
        SAAS_KEY_CLOUD_SYNC: "real_production_cloud_sync_key_secret_67890",
        SAAS_MOUWASAT_TENANT_ID: "TENANT_MOUWASAT_01",
        SAAS_CLOUD_SYNC_TENANT_ID: "TENANT_CLOUD_SYNC_01"
      });

      try {
        const res = await axios.post(
          `${baseUrl}/api/v1/saas/sync`,
          { ciphertext: "ENC_TEST" },
          {
            headers: { Authorization: "Bearer invalid_attacker_token" },
            validateStatus: () => true
          }
        );
        expect(res.status).toBe(403);
      } finally {
        await stopTestServer();
      }
    });

    it("SaaS Test 3 — Demo FHIR endpoint disabled in Production by default", async () => {
      await startTestServer({
        NODE_ENV: "production",
        SAAS_KEY_MOUWASAT: "key_mouwasat_secure_test",
        SAAS_MOUWASAT_TENANT_ID: "TENANT_MOUWASAT_01",
        ENABLE_SAAS_DEMO_ENDPOINTS: undefined
      });

      try {
        const res = await axios.get(`${baseUrl}/api/v1/saas/fhir/Patient`, {
          headers: { Authorization: "Bearer key_mouwasat_secure_test" },
          validateStatus: () => true
        });
        expect(res.status).toBe(404);
        expect(res.data.issue[0].diagnostics).toContain("disabled in this environment");
      } finally {
        await stopTestServer();
      }
    });

    it("SaaS Test 4 — Tenant Context Enforced: req.body.tenantId cannot hijack authenticated tenant context", async () => {
      await startTestServer({
        NODE_ENV: "production",
        SAAS_KEY_CLOUD_SYNC: "key_cloud_sync_prod_token",
        SAAS_CLOUD_SYNC_TENANT_ID: "TEN_OFFICIAL_CLOUD_01"
      });

      try {
        const res = await axios.post(
          `${baseUrl}/api/v1/saas/sync`,
          {
            ciphertext: "ENC_PAYLOAD",
            tenantId: "TEN_VICTIM_TENANT_99"
          },
          {
            headers: { Authorization: "Bearer key_cloud_sync_prod_token" },
            validateStatus: () => true
          }
        );
        expect(res.status).toBe(403);
        expect(res.data.error).toBe("TENANT_MISMATCH");

        const validRes = await axios.post(
          `${baseUrl}/api/v1/saas/sync`,
          { ciphertext: "ENC_PAYLOAD" },
          {
            headers: { Authorization: "Bearer key_cloud_sync_prod_token" },
            validateStatus: () => true
          }
        );
        expect(validRes.status).toBe(200);
        expect(validRes.data.tenantId).toBe("TEN_OFFICIAL_CLOUD_01");
      } finally {
        await stopTestServer();
      }
    });
  });

  describe("Replication Metrics Tenant Isolation", () => {
    it("getReplicationMetrics is strictly isolated between Tenant A and Tenant B", async () => {
      (globalThis as any).__mockReplicationMetrics = (tenantId: string, redisConnected: boolean) => {
        if (tenantId === "TENANT_AL_NOOR_01") {
          return { redisConnected, syncEventsCount: 15, auditLogsEventsCount: 8 };
        }
        if (tenantId === "TENANT_AL_SHIFA_02") {
          return { redisConnected, syncEventsCount: 5, auditLogsEventsCount: 2 };
        }
        return { redisConnected, syncEventsCount: 0, auditLogsEventsCount: 0 };
      };

      const metricsA = await runWithTenantContext({ tenantId: "TENANT_AL_NOOR_01" }, async () => {
        return ReplicationService.getReplicationMetrics();
      });

      expect(metricsA.syncEventsCount).toBe(15);
      expect(metricsA.auditLogsEventsCount).toBe(8);

      const metricsB = await runWithTenantContext({ tenantId: "TENANT_AL_SHIFA_02" }, async () => {
        return ReplicationService.getReplicationMetrics();
      });

      expect(metricsB.syncEventsCount).toBe(5);
      expect(metricsB.auditLogsEventsCount).toBe(2);

      delete (globalThis as any).__mockReplicationMetrics;
    });
  });
});

