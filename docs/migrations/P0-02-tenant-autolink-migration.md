# P0-02 — Tenant Auto-Link Removal and Manual Reassignment

## Purpose

This document supports a controlled review of users affected by removal of automatic tenant membership creation during login. It does not execute a migration, change the Prisma schema, or modify production data.

## 1. Discover potentially affected users

Run the SQL in a read-only session against the intended database:

```sql
SELECT
  u.id,
  u.username,
  u.role,
  u."isActive",
  u."createdAt"
FROM public.users AS u
LEFT JOIN public.tenant_users AS tu ON tu."userId" = u.id
WHERE tu.id IS NULL
ORDER BY u."createdAt", u.username;
```

Count only:

```sql
SELECT COUNT(*) AS users_without_tenant_membership
FROM public.users AS u
WHERE NOT EXISTS (
  SELECT 1
  FROM public.tenant_users AS tu
  WHERE tu."userId" = u.id
);
```

Equivalent Prisma read-only discovery:

```ts
const usersWithoutTenant = await prisma.user.findMany({
  where: { tenantUsers: { none: {} } },
  select: {
    id: true,
    username: true,
    role: true,
    isActive: true,
    createdAt: true
  },
  orderBy: [{ createdAt: "asc" }, { username: "asc" }]
});
```

To inspect multi-tenant memberships:

```sql
SELECT
  u.id,
  u.username,
  COUNT(tu.id)::int AS tenant_count,
  ARRAY_AGG(tu."tenantId" ORDER BY tu."tenantId") FILTER (WHERE tu.id IS NOT NULL) AS tenant_ids
FROM public.users AS u
LEFT JOIN public.tenant_users AS tu ON tu."userId" = u.id
GROUP BY u.id, u.username
HAVING COUNT(tu.id) > 1
ORDER BY u.username;
```

## 2. Possible scenarios

1. **User without membership:** no row exists in tenant_users. Login is intentionally rejected with HTTP 403 and error TENANT_UNASSIGNED until reviewed and assigned.
2. **User with an incorrect membership:** a membership exists but points to the wrong tenant. Do not create another membership automatically; verify ownership and correct it through an explicitly approved administrative process.
3. **User belonging to multiple tenants:** multiple TenantUser rows exist. Do not assume which tenant is the correct login context. Review expected tenant selection and current login behavior before making any change.

## 3. Manual review steps

1. Run the discovery queries read-only and export the results securely.
2. Match each account to authoritative business/tenant ownership records.
3. Confirm the account is active and identify the intended tenant and, if applicable, branch.
4. Review existing TenantUser and BranchUser records, including duplicate or conflicting assignments.
5. Obtain owner approval for each assignment. Do not bulk-assign users based only on role, username, or a default tenant.
6. Keep a record of the reviewer, decision, source evidence, and execution time.

## 4. Use the administrative endpoint

After deploying the reviewed PR, an authorized PLATFORM_OWNER may submit:

```http
POST /api/admin/users/{userId}/assign-tenant
Authorization: Bearer {platform-owner-access-token}
Content-Type: application/json
```

Body:

```json
{
  "tenantId": "verified-tenant-id",
  "branchId": "verified-branch-id"
}
```

Omit branchId when no branch assignment is approved. The endpoint validates the tenant, target user, and optional branch ownership; creates the TenantUser (least-privilege role STAFF), optionally creates BranchUser, and records an AuditLog in one transaction. Repeating an existing (userId, tenantId) assignment returns created=false and does not create another audit event.

**Current authentication constraint:** the existing authenticateToken middleware rejects JWTs without a tenantId claim (403 MISSING_TENANT), even for PLATFORM_OWNER. The route is mounted before tenantContextMiddleware, but this PR does not change authenticateToken. Therefore, the platform-owner token used by this endpoint must still contain a valid tenantId claim. A truly tenant-independent platform-owner session requires a separate security design and change to the authentication middleware.

## 5. Before/after checklist

### Before deployment
- [ ] Run the SQL and Prisma discovery queries against Production in read-only mode.
- [ ] Review every user with zero memberships.
- [ ] Review users with multiple memberships and any suspected incorrect memberships.
- [ ] Confirm tenant and branch IDs against authoritative records.
- [ ] Obtain explicit owner approval for each reassignment.
- [ ] Confirm that the platform-owner token satisfies the current tenantId claim requirement.
- [ ] Back up the database and confirm the recovery procedure.

### After each approved assignment
- [ ] Verify exactly one TenantUser exists for the intended userId and tenantId.
- [ ] If branchId was supplied, verify the BranchUser belongs to that same tenant.
- [ ] Verify the AuditLog entity and eventType.
- [ ] Verify the assigned user can log in and receives only the intended tenant/branch context.
- [ ] Verify no unrelated tenant, branch, or membership rows changed.

⚠️ **لم يُتحقق من بيانات Production. يجب على المالك تشغيل الاستعلامات قبل النشر.**
