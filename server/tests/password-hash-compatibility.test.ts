import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { verifyPasswordHash } from '../security/passwordHash';
import { hashLocalPassword } from '../../src/features/auth/services/localPasswordService';

async function makePbkdf2Hash(password: string): Promise<string> {
  const iterations = 600_000;
  const salt = crypto.randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

describe('password hash compatibility', () => {
  it('verifies Web Crypto PBKDF2 hashes and rejects wrong passwords', async () => {
    const encoded = await makePbkdf2Hash('Safe-PBKDF2-Password-2026');
    expect(await verifyPasswordHash('Safe-PBKDF2-Password-2026', encoded)).toBe(true);
    expect(await verifyPasswordHash('incorrect-password', encoded)).toBe(false);
  });

  it('verifies the exact PBKDF2 format emitted by the browser Web Crypto helper', async () => {
    const password = 'CrossRuntime-WebCrypto-Password-2026';
    const encoded = await hashLocalPassword(password);
    expect(await verifyPasswordHash(password, encoded)).toBe(true);
    expect(await verifyPasswordHash('incorrect-password', encoded)).toBe(false);
  });

  it('continues to verify existing bcrypt server hashes', async () => {
    const encoded = await bcrypt.hash('Existing-Bcrypt-Password', 8);
    expect(await verifyPasswordHash('Existing-Bcrypt-Password', encoded)).toBe(true);
    expect(await verifyPasswordHash('incorrect-password', encoded)).toBe(false);
  });

  it('rejects malformed or weakened PBKDF2 parameters', async () => {
    expect(await verifyPasswordHash('password', 'pbkdf2-sha256$1000$bad$bad')).toBe(false);
    expect(await verifyPasswordHash('password', 'pbkdf2-sha256$not-a-number$bad$bad')).toBe(false);
  });
});
