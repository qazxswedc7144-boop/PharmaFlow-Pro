import { describe, expect, it } from 'vitest';
import { validateActiveBranchRecord } from './activeBranchRegistry';

describe('active branch registration', () => {
  const expected = { tenantId: 'tenant-a', branchId: 'branch-a' };

  it('accepts only the requested active branch bound to the current tenant', () => {
    expect(validateActiveBranchRecord({
      id: 'branch-a',
      code: 'BR-A',
      name: 'Branch A',
      tenantId: 'tenant-a',
      isActive: true
    }, expected)).toMatchObject({ id: 'branch-a', tenantId: 'tenant-a' });
  });

  it('rejects a branch belonging to another tenant', () => {
    expect(() => validateActiveBranchRecord({
      id: 'branch-a',
      tenantId: 'tenant-b',
      isActive: true
    }, expected)).toThrow(/CROSS_TENANT_VIOLATION/);
  });

  it('rejects a different branch even when tenant matches', () => {
    expect(() => validateActiveBranchRecord({
      id: 'branch-b',
      tenantId: 'tenant-a',
      isActive: true
    }, expected)).toThrow(/BRANCH_CONTEXT_MISMATCH/);
  });

  it('rejects inactive or unbound branch records', () => {
    expect(() => validateActiveBranchRecord({
      id: 'branch-a',
      tenantId: 'tenant-a',
      isActive: false
    }, expected)).toThrow(/BRANCH_INACTIVE/);

    expect(() => validateActiveBranchRecord({
      id: 'branch-a',
      isActive: true
    }, expected)).toThrow(/CROSS_TENANT_VIOLATION/);
  });
});
