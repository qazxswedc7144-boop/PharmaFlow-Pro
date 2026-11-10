-- Keep tenant sales policies inaccessible through the public Data API.
-- The trusted Express/Prisma server connects with the database owner role.
ALTER TABLE "tenant_sales_policies" ENABLE ROW LEVEL SECURITY;
