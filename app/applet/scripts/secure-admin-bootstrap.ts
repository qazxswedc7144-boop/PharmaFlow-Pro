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

  // Check if any admin/user already exists
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    console.log(`⚠️ Notice: Users already exist in the database (${userCount} users found). Bootstrap aborted to prevent duplicate initialization.`);
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(`[BOOTSTRAP] Creating tenant "${tenantName}" and admin user "${username}"...`);

  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  // 1. Create Tenant
  const tenant = await prisma.tenant.create({
    data: {
      name: tenantName,
      isActive: true,
    },
  });

  // 2. Create User
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      role: "TENANT_ADMIN",
      isActive: true,
    },
  });

  // 3. Link User to Tenant
  await prisma.tenantUser.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      role: "TENANT_ADMIN",
    },
  });

  // 4. Create Main Branch
  const branchCode = `BRH-${tenant.id.slice(0, 4).toUpperCase()}-001`;
  const branch = await prisma.branch.create({
    data: {
      code: branchCode,
      name: "الفرع الرئيسي",
      isActive: true,
      tenantId: tenant.id,
    },
  });

  await prisma.branchSettings.create({
    data: {
      branchId: branch.id,
    },
  });

  await prisma.branchUser.create({
    data: {
      branchId: branch.id,
      userId: user.id,
      isDefault: true,
    },
  });

  console.log("✅ Secure Admin Bootstrap completed successfully!");
  console.log(`- Tenant ID: ${tenant.id}`);
  console.log(`- Admin User ID: ${user.id} (${username})`);
  console.log(`- Branch ID: ${branch.id}`);

  await prisma.$disconnect();
}

bootstrap().catch(async (err) => {
  console.error("❌ Secure Admin Bootstrap failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
