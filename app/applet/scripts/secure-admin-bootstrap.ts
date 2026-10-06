import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function bootstrap() {
  console.log("=== SECURE ADMIN BOOTSTRAP ===");

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const tenantName = process.env.TENANT_NAME || "الشركة الدوائية المركزية";

  if (!username || !password) {
    console.error("❌ Error: ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required.");
    process.exit(1);
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Check if any admin/user already exists inside transaction
      const userCount = await tx.user.count();
      if (userCount > 0) {
        console.log(`⚠️ Notice: Users already exist in the database (${userCount} users found). Bootstrap aborted to prevent duplicate initialization.`);
        return;
      }

      console.log(`[BOOTSTRAP] Creating tenant "${tenantName}" and admin user "${username}" atomically...`);

      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // 1. Create Tenant
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          isActive: true,
        },
      });

      // 2. Create User
      const user = await tx.user.create({
        data: {
          username,
          passwordHash,
          role: "ADMIN",
          isActive: true,
        },
      });

      // 3. Link User to Tenant
      await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: "TENANT_ADMIN",
        },
      });

      // 4. Create Main Branch
      const branchCode = `BRH-${tenant.id.slice(0, 4).toUpperCase()}-001`;
      const branch = await tx.branch.create({
        data: {
          code: branchCode,
          name: "الفرع الرئيسي",
          isActive: true,
          tenantId: tenant.id,
        },
      });

      await tx.branchSettings.create({
        data: {
          branchId: branch.id,
        },
      });

      await tx.branchUser.create({
        data: {
          branchId: branch.id,
          userId: user.id,
          isDefault: true,
        },
      });

      // 5. Audit log
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "SYSTEM_BOOTSTRAP",
          entity: "System",
          entityId: "SYSTEM_BOOTSTRAP",
          after: JSON.stringify({
            userId: user.id,
            username: user.username,
            tenantId: tenant.id,
            tenantName: tenant.name,
            systemInitialized: true
          })
        }
      });

      console.log("✅ Secure Admin Bootstrap completed successfully!");
      console.log(`- Tenant ID: ${tenant.id}`);
      console.log(`- Admin User ID: ${user.id} (${username})`);
      console.log(`- Branch ID: ${branch.id}`);
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      console.log("⚠️ Notice: Concurrent bootstrap detected or username already exists. Aborting safely.");
    } else {
      throw err;
    }
  } finally {
    await prisma.$disconnect();
  }
}

bootstrap().catch(async (err) => {
  console.error("❌ Secure Admin Bootstrap failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
