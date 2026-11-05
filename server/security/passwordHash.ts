import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const PBKDF2_PREFIX = 'pbkdf2-sha256';
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;

/**
 * Verifies the current bcrypt server format and the temporary PBKDF2 format
 * produced by the Web Crypto local-user flow. Unknown formats fail closed.
 */
export async function verifyPasswordHash(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encodedHash !== 'string' || !encodedHash) {
    return false;
  }

  if (!encodedHash.startsWith(`${PBKDF2_PREFIX}$`)) {
    try {
      return await bcrypt.compare(password, encodedHash);
    } catch {
      return false;
    }
  }

  const parts = encodedHash.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return false;

  const iterations = Number(parts[1]);
  const saltText = parts[2];
  const hashText = parts[3];
  const validBase64 = (value: string) =>
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS ||
    !validBase64(saltText) ||
    !validBase64(hashText)
  ) {
    return false;
  }

  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(hashText, 'base64');
  if (salt.length !== 16 || expected.length !== 32) return false;

  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(password, salt, iterations, expected.length, 'sha256', (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      });
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
