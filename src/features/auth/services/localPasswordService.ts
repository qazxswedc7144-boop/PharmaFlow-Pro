const PBKDF2_PREFIX = 'pbkdf2-sha256';
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function derivePasswordBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('PASSWORD_CRYPTO_UNAVAILABLE: يتطلب حفظ كلمة المرور اتصالاً آمناً يدعم Web Crypto API.');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    DERIVED_KEY_BITS
  );
  return new Uint8Array(bits);
}

export async function hashLocalPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 1) {
    throw new Error('PASSWORD_REQUIRED: كلمة المرور مطلوبة.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derivePasswordBits(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

export async function verifyLocalPassword(
  password: string,
  storedHash?: string | null,
  legacyPlaintext?: string | null
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, needsUpgrade: false };
  }

  if (!storedHash) {
    return {
      valid: typeof legacyPlaintext === 'string' && legacyPlaintext.length > 0 && legacyPlaintext === password,
      needsUpgrade: typeof legacyPlaintext === 'string' && legacyPlaintext.length > 0 && legacyPlaintext === password
    };
  }

  const [algorithm, iterationText, saltText, hashText, extra] = storedHash.split('$');
  if (algorithm !== PBKDF2_PREFIX || extra !== undefined || !iterationText || !saltText || !hashText) {
    return { valid: false, needsUpgrade: false };
  }

  const iterations = Number(iterationText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    return { valid: false, needsUpgrade: false };
  }

  try {
    const salt = base64ToBytes(saltText);
    const expected = base64ToBytes(hashText);
    if (salt.length !== SALT_BYTES || expected.length !== DERIVED_KEY_BITS / 8) {
      return { valid: false, needsUpgrade: false };
    }
    const actual = await derivePasswordBits(password, salt, iterations);
    let difference = actual.length ^ expected.length;
    for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
      difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
    }
    return { valid: difference === 0, needsUpgrade: false };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}
