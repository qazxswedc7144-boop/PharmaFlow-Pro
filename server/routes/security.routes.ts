import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { EncryptionService } from '../security/encryption.service.js';
import { prisma } from '../database/prisma.js';
import { authenticateToken, requireRoles, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

const securityRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false },
  message: {
    status: 'error',
    code: 'SEC_RATE_LIMIT_EXCEEDED',
    message: 'Cryptographic request threshold breached. Access has been temporarily restricted.'
  }
});

router.use(securityRateLimiter);

const validateRawPayload = (req: Request, res: Response, next: NextFunction): void => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({
      status: 'error',
      code: 'SEC_BAD_INPUT',
      message: 'Body template validation error: A "text" string property is required.'
    });
    return;
  }
  next();
};

// ✅ إضافة authenticateToken للمسارات الحساسة (Defense in Depth)
router.post('/encrypt', authenticateToken, validateRawPayload, (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    const encrypted = EncryptionService.encrypt(text);
    return res.json({ status: 'success', data: encrypted });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'SEC_ENCRYPT_FAILURE', message: 'Cryptographic core failure.' });
  }
});

router.post('/decrypt', authenticateToken, (req: Request, res: Response) => {
  try {
    const { iv, encryptedData, authTag } = req.body;
    if (!iv || !encryptedData || !authTag) {
      return res.status(400).json({ status: 'error', code: 'SEC_BAD_INPUT', message: 'Missing parameters.' });
    }
    const decryptedText = EncryptionService.decrypt({ iv, encryptedData, authTag });
    return res.json({ status: 'success', data: { decryptedText } });
  } catch (error: any) {
    return res.status(400).json({ status: 'error', code: 'SEC_DECRYPT_FAILURE', message: 'Integrity check failed.' });
  }
});

router.post('/encrypt-backup', authenticateToken, validateRawPayload, (req: Request, res: Response) => {
  try {
    const { text, password } = req.body;
    const encrypted = EncryptionService.encryptBackup(text, password);
    return res.json({ status: 'success', data: encrypted });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'SEC_BACKUP_ENCRYPT_FAILURE', message: 'Operational failure.' });
  }
});

router.post('/decrypt-backup', authenticateToken, (req: Request, res: Response) => {
  try {
    const { salt, iv, encrypted_data, password } = req.body;
    if (!salt || !iv || !encrypted_data) {
      return res.status(400).json({ status: 'error', code: 'SEC_BAD_INPUT', message: 'Missing parameters.' });
    }
    const decryptedText = EncryptionService.decryptBackup({ salt, iv, encrypted_data }, password);
    return res.json({ status: 'success', data: { decryptedText } });
  } catch (error: any) {
    return res.status(400).json({ status: 'error', code: 'SEC_BACKUP_DECRYPT_FAILURE', message: 'Auth check failed.' });
  }
});

router.post('/crash', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { branchId, route, deviceFingerprint, appVersion, stackTrace, errorMessage, timestamp } = req.body;
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;

    if (!route || !errorMessage) {
      return res.status(400).json({ status: 'error', code: 'CRASH_BAD_INPUT', message: 'Missing required fields.' });
    }

    const rawDate = timestamp ? new Date(timestamp) : new Date();
    const parsedDate = isNaN(rawDate.getTime()) ? new Date() : rawDate;

    const crashEntry = await prisma.crashLog.create({
      data: {
        tenantId: tenantId || null,
        branchId: branchId || null,
        userId: userId || null,
        route,
        deviceFingerprint: deviceFingerprint || null,
        appVersion: appVersion || null,
        stackTrace: stackTrace || null,
        errorMessage,
        timestamp: parsedDate
      }
    });

    return res.status(201).json({ status: 'success', data: crashEntry });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'CRASH_LOG_CORE_FAILURE', message: 'Failed to record crash trace.' });
  }
});

router.post('/device/register', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deviceId, branchId, deviceName, androidVersion, appVersion } = req.body;
    const tenantId = req.user!.tenantId;

    if (!deviceId || !tenantId || !branchId || !deviceName) {
      return res.status(400).json({ status: 'error', code: 'REG_BAD_INPUT', message: 'Missing required properties.' });
    }

    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
    if (!branch) {
      return res.status(400).json({ status: 'error', code: 'BRANCH_TENANT_MISMATCH', message: 'الفرع المحدد لا ينتمي إلى هذه المؤسسة.' });
    }

    const count = await prisma.deviceRegistration.count({ where: { tenantId } });
    const existingDevice = await prisma.deviceRegistration.findFirst({ where: { deviceId, tenantId } });

    if (existingDevice && existingDevice.tenantId !== tenantId) {
      return res.status(403).json({ status: 'error', code: 'CROSS_TENANT_DEVICE_FORBIDDEN', message: 'هذا الجهاز مسجل لمؤسسة أخرى.' });
    }

    const subscription = await prisma.tenantSubscription.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    });

    let maxDevices = 3;
    if (subscription && subscription.plan) {
      if (subscription.plan.code === 'BUSINESS') maxDevices = 6;
      else if (subscription.plan.code === 'ENTERPRISE') maxDevices = 999;
    }

    if (count >= maxDevices && !existingDevice) {
      return res.status(403).json({ status: 'error', code: 'DEVICE_COUNT_EXCEEDED', message: `الحد الأقصى للأجهزة (${maxDevices}).` });
    }

    const registered = await prisma.deviceRegistration.upsert({
      where: { deviceId },
      update: { deviceName, androidVersion, appVersion, lastSync: new Date() },
      create: { deviceId, tenantId, branchId, deviceName, androidVersion, appVersion, lastSync: new Date() }
    });

    return res.json({ status: 'success', data: registered });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'DEVICE_REG_FAILURE', message: 'Failed to process device registration.' });
  }
});

router.get('/device/status/:deviceId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deviceId } = req.params;
    const tenantId = req.user!.tenantId;

    const device = await prisma.deviceRegistration.findFirst({ where: { deviceId, tenantId } });

    if (!device) {
      return res.status(404).json({ status: 'error', code: 'DEVICE_NOT_FOUND', message: 'Device not found.' });
    }

    return res.json({ status: 'success', data: device });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'DEVICE_STATUS_FAILURE', message: 'Failed to retrieve device status.' });
  }
});

router.get('/devices', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const devices = await prisma.deviceRegistration.findMany({ where: { tenantId }, orderBy: { lastSync: 'desc' } });
    return res.json({ status: 'success', data: devices });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'DEVICES_FETCH_FAILURE', message: 'Failed to retrieve devices.' });
  }
});

router.post('/license/generate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deviceFingerprint, expiryDate } = req.body;
    const tenantId = req.user!.tenantId;

    if (!deviceFingerprint || !tenantId || !expiryDate) {
      return res.status(400).json({ status: 'error', code: 'LICENSE_GENERATE_BAD_INPUT', message: 'Missing parameters.' });
    }

    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error("ENCRYPTION_KEY is not defined.");

    const message = `${deviceFingerprint}:${tenantId}:${expiryDate}`;
    const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

    return res.json({ status: 'success', signature });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', code: 'LICENSE_GENERATE_FAIL', message: 'Failed to generate signature.' });
  }
});

router.post('/license/verify', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deviceFingerprint, expiryDate, signature } = req.body;
    const tenantId = req.user!.tenantId;

    if (!deviceFingerprint || !tenantId || !expiryDate || !signature) {
      return res.status(400).json({ status: 'error', code: 'LICENSE_VERIFY_BAD_INPUT', message: 'Missing parameters.' });
    }

    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error("ENCRYPTION_KEY is not defined.");

    const message = `${deviceFingerprint}:${tenantId}:${expiryDate}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(message).digest('hex');

    const signatureBuf = Buffer.from(signature, 'hex');
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const isValid = signatureBuf.length === expectedBuf.length && crypto.timingSafeEqual(signatureBuf, expectedBuf);

    return res.json({ status: 'success', isValid });
  } catch (err: any) {
    return res.status(200).json({ status: 'success', isValid: false, message: 'License verification errored.' });
  }
});

router.post('/backup/upload', authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId, filename, payload } = req.body;
    if (!tenantId || !filename || !payload) {
      return res.status(400).json({ status: 'error', code: 'BACKUP_UPLOAD_BAD_INPUT', message: 'Missing parameters.' });
    }

    if (req.user?.tenantId && req.user.tenantId !== tenantId && req.user.role !== Role.PLATFORM_OWNER) {
      return res.status(403).json({ status: 'error', code: 'TENANT_MISMATCH', message: 'Unauthorized access.' });
    }

    const safeTenantId = path.basename(String(tenantId).trim());
    const safeFilename = path.basename(String(filename).trim());

    const allowedExtensions = ['.json', '.bak', '.pfb', '.zip'];
    const hasValidExt = allowedExtensions.some(ext => safeFilename.endsWith(ext));
    if (!hasValidExt) {
      return res.status(400).json({ status: 'error', code: 'INVALID_FILE_EXTENSION', message: 'Extension not allowed.' });
    }

    // 🚀 التعامل مع الملفات النصية والثنائية
    const isBase64 = safeFilename.endsWith('.zip') || safeFilename.endsWith('.pfb');
    const payloadBuffer = Buffer.from(payload, isBase64 ? 'base64' : 'utf8');

    if (payloadBuffer.length > 50 * 1024 * 1024) {
      return res.status(400).json({ status: 'error', code: 'FILE_SIZE_LIMIT_EXCEEDED', message: 'Max limit 50MB.' });
    }

    const baseDir = path.join('/tmp', 'backups_cloud_simulated');
    const folderPath = path.resolve(baseDir, safeTenantId);
    const filePath = path.resolve(folderPath, safeFilename);

    if (!filePath.startsWith(baseDir)) {
      return res.status(403).json({ status: 'error', code: 'PATH_TRAVERSAL_BLOCKED', message: 'Directory traversal detected.' });
    }

    const clientChecksum = (req.headers['x-backup-checksum'] as string) || req.body?.checksum;
    const computedChecksum = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
    if (clientChecksum && clientChecksum.toLowerCase() !== computedChecksum.toLowerCase()) {
      return res.status(400).json({ status: 'error', code: 'CHECKSUM_MISMATCH', message: 'Checksum mismatch.' });
    }

    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(filePath, payloadBuffer);

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId || null,
        action: 'BACKUP_UPLOAD',
        entity: 'Backup',
        entityId: safeFilename,
        before: null,
        after: JSON.stringify({ tenantId: safeTenantId, filename: safeFilename, sizeInBytes: payloadBuffer.length, checksum: computedChecksum }),
        ipAddress: req.ip
      }
    }).catch(() => {});

    return res.json({ status: 'success', filename: safeFilename, checksum: computedChecksum });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'BACKUP_UPLOAD_FAILURE', message: 'Failed to upload backup.' });
  }
});

router.get('/backup/list', authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.query.tenantId as string) || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: 'error', code: 'BACKUP_LIST_MISSING_TENANT', message: 'tenantId required.' });

    if (req.user?.tenantId && req.user.tenantId !== tenantId && req.user.role !== Role.PLATFORM_OWNER) {
      return res.status(403).json({ status: 'error', code: 'TENANT_MISMATCH', message: 'Unauthorized.' });
    }

    const safeTenantId = path.basename(String(tenantId).trim());
    const baseDir = path.join('/tmp', 'backups_cloud_simulated');
    const folderPath = path.resolve(baseDir, safeTenantId);

    if (!folderPath.startsWith(baseDir)) return res.status(403).json({ status: 'error', code: 'PATH_TRAVERSAL_BLOCKED', message: 'Traversal blocked.' });

    try {
      const files = await fs.readdir(folderPath);
      const listBackups = await Promise.all(files.filter(f => ['.bak', '.json', '.pfb', '.zip'].some(ext => f.endsWith(ext))).map(async file => {
        const stats = await fs.stat(path.join(folderPath, file));
        return { filename: file, sizeInKB: Math.round(stats.size / 1024), createdAt: stats.mtime.toISOString() };
      }));
      return res.json({ status: 'success', backups: listBackups });
    } catch (e) {
      return res.json({ status: 'success', backups: [] });
    }
  } catch (error: any) {
    return res.status(500).json({ status: 'error', code: 'BACKUP_LIST_FAILURE', message: 'Failed to retrieve backups.' });
  }
});

router.get('/backup/download', authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.query.tenantId as string) || req.user?.tenantId;
    const filename = req.query.filename as string;

    if (!tenantId || !filename) return res.status(400).json({ status: 'error', code: 'BACKUP_DOWNLOAD_BAD_INPUT', message: 'Missing parameters.' });

    if (req.user?.tenantId && req.user.tenantId !== tenantId && req.user.role !== Role.PLATFORM_OWNER) {
      return res.status(403).json({ status: 'error', code: 'TENANT_MISMATCH', message: 'Unauthorized.' });
    }

    const safeTenantId = path.basename(String(tenantId).trim());
    const safeFilename = path.basename(String(filename).trim());
    const baseDir = path.join('/tmp', 'backups_cloud_simulated');
    const filePath = path.resolve(baseDir, safeTenantId, safeFilename);

    if (!filePath.startsWith(baseDir)) return res.status(403).json({ status: 'error', code: 'PATH_TRAVERSAL_BLOCKED', message: 'Traversal blocked.' });

    const contentBuffer = await fs.readFile(filePath);

    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId || null, action: 'BACKUP_DOWNLOAD', entity: 'Backup', entityId: safeFilename,
        before: null, after: JSON.stringify({ tenantId: safeTenantId, filename: safeFilename }), ipAddress: req.ip
      }
    }).catch(() => {});

    // ✅ الحل الجذري للتلف: إرسال Buffer بدلاً من JSON
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.send(contentBuffer);
  } catch (error: any) {
    return res.status(404).json({ status: 'error', code: 'BACKUP_FILE_NOT_FOUND', message: 'File not found.' });
  }
});

router.get('/backup/verify', authenticateToken, requireRoles([Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.ADMIN]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = (req.query.tenantId as string) || req.user?.tenantId;
    const filename = req.query.filename as string;
    const expectedChecksum = (req.query.checksum as string) || '';

    if (!tenantId || !filename) return res.status(400).json({ status: 'error', code: 'BACKUP_VERIFY_BAD_INPUT', message: 'Missing parameters.' });

    if (req.user?.tenantId && req.user.tenantId !== tenantId && req.user.role !== Role.PLATFORM_OWNER) {
      return res.status(403).json({ status: 'error', code: 'TENANT_MISMATCH', message: 'Unauthorized.' });
    }

    const safeTenantId = path.basename(String(tenantId).trim());
    const safeFilename = path.basename(String(filename).trim());
    const baseDir = path.join('/tmp', 'backups_cloud_simulated');
    const filePath = path.resolve(baseDir, safeTenantId, safeFilename);

    if (!filePath.startsWith(baseDir)) return res.status(403).json({ status: 'error', code: 'PATH_TRAVERSAL_BLOCKED', message: 'Traversal blocked.' });

    const stats = await fs.stat(filePath);
    const contentBuffer = await fs.readFile(filePath);
    const computedChecksum = crypto.createHash('sha256').update(contentBuffer).digest('hex');

    const checksumMatched = expectedChecksum ? expectedChecksum.toLowerCase() === computedChecksum.toLowerCase() : undefined;

    return res.json({
      status: 'success', valid: checksumMatched !== false, filename: safeFilename,
      sizeInBytes: stats.size, sizeInKB: Math.round(stats.size / 1024), checksum: computedChecksum,
      checksumMatched, verifiedAt: new Date().toISOString()
    });
  } catch (error: any) {
    return res.status(404).json({ status: 'error', code: 'BACKUP_NOT_FOUND', message: 'Cloud backup file could not be verified.' });
  }
});

export default router;
