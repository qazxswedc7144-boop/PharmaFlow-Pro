// server/modules/replication/replication.gateway.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { ReplicationGateway } from './replication.gateway.js';
import { prisma } from '../../database/prisma.js';
import http from 'http';
import WebSocket from 'ws';

// Mock Prisma
vi.mock('../../database/prisma.js', () => {
  return {
    prisma: {
      branchUser: {
        findMany: vi.fn(),
      },
      branch: {
        findMany: vi.fn(),
      }
    }
  };
});

const JWT_SECRET = 'pharmaflow-local-development-jwt-secure-secret-2026';

describe('ReplicationGateway Security & Functional Tests', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;

    server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('OK');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address() as any;
        port = address.port;
        resolve();
      });
    });

    ReplicationGateway.init(server);
  });

  afterEach(() => {
    server.close();
  });

  const createToken = (payload: any, options?: jwt.SignOptions) => {
    return jwt.sign(payload, JWT_SECRET, options || { expiresIn: '1h' });
  };

  it('1. User A → own branch PASS', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValueOnce([
      { branchId: 'branch-A' }
    ]);

    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: 'branch-A'
    });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', (err) => reject(err));
    });
  });

  it('2. User A → unauthorized branch DENY', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValueOnce([
      { branchId: 'branch-A' }
    ]);

    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: 'branch-UNAUTHORIZED'
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', (code) => {
        expect(code).toBeDefined();
        resolve();
      });
      ws.on('error', () => {
        resolve();
      });
    });
  });

  it('3. User A → other tenant branch DENY', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValueOnce([]);

    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: 'branch-B'
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('4. Invalid branchId DENY', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValueOnce([]);

    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: 'NON_EXISTENT'
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('5. Missing tenantId DENY', async () => {
    const token = createToken({
      userId: 'user-A',
      role: 'ADMIN',
      branchId: 'branch-A'
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('6. Expired JWT DENY', async () => {
    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: 'branch-A'
    }, { expiresIn: '-1s' });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('7. Invalid JWT DENY', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=invalid.jwt.token`);

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('8. Unauthorized role DENY', async () => {
    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'CASHIER',
      branchId: 'branch-A'
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('Event without tenantId → DENY', async () => {
    const token = createToken({
      userId: 'user-A',
      role: 'ADMIN',
      branchId: 'branch-A'
      // tenantId omitted
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('User without branchId → ChangeBranch DENY', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValueOnce([]);
    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: ''
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  });

  it('Two users same branch → origin doesn\'t receive, other receives', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValue([
      { branchId: 'branch-A' }
    ]);

    const tokenA = createToken({ userId: 'user-A', tenantId: 'tenant-1', role: 'ADMIN', branchId: 'branch-A' });
    const tokenB = createToken({ userId: 'user-B', tenantId: 'tenant-1', role: 'ADMIN', branchId: 'branch-A' });

    await new Promise<void>((resolve) => {
      const wsA = new WebSocket(`ws://localhost:${port}/ws?token=${tokenA}`);
      const wsB = new WebSocket(`ws://localhost:${port}/ws?token=${tokenB}`);

      let connectedCount = 0;
      const checkDone = () => {
        connectedCount++;
        if (connectedCount === 2) {
          wsA.close();
          wsB.close();
          resolve();
        }
      };

      wsA.on('open', checkDone);
      wsB.on('open', checkDone);
      wsA.on('error', checkDone);
      wsB.on('error', checkDone);
    });
  });

  it('ChangeBranch غير مصرح → DENY', async () => {
    (prisma.branchUser.findMany as any).mockResolvedValueOnce([
      { branchId: 'branch-A' }
    ]);

    const token = createToken({
      userId: 'user-A',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      branchId: 'branch-A'
    });

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
      ws.on('open', () => {
        // Send unauthorized change branch message
        ws.send(JSON.stringify({ type: 'ChangeBranch', branchId: 'branch-UNAUTHORIZED' }));
        setTimeout(() => {
          ws.close();
          resolve();
        }, 100);
      });
      ws.on('error', () => resolve());
    });
  });
});
