import { describe, expect, it, vi } from 'vitest';
import { findExistingProductByName } from './productLookup';

describe('findExistingProductByName', () => {
  it('uses indexed case-insensitive equality and falls back to the legacy lowercase index', async () => {
    const first = { id: 'P-1', Name: 'Panadol Extra' };
    const where = vi.fn((index: 'Name' | 'name') => ({
      equalsIgnoreCase: vi.fn((value: string) => ({
        first: vi.fn(async () => index === 'name' && value === 'Panadol Extra' ? first : undefined)
      }))
    }));
    const result = await findExistingProductByName({ where }, '  Panadol Extra  ');
    expect(result).toBe(first);
    expect(where).toHaveBeenNthCalledWith(1, 'Name');
    expect(where).toHaveBeenNthCalledWith(2, 'name');
  });

  it('does not query for an empty name', async () => {
    const where = vi.fn();
    await expect(findExistingProductByName({ where }, '  ')).resolves.toBeNull();
    expect(where).not.toHaveBeenCalled();
  });
});
