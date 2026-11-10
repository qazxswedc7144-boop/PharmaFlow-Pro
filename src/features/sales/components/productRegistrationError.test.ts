import { describe, expect, it } from 'vitest';
import { formatProductRegistrationError } from './productRegistrationError';

describe('formatProductRegistrationError', () => {
  it('keeps the actionable workflow error code and message visible', () => {
    expect(formatProductRegistrationError(new Error('AUTHORIZATION_DENIED: products.manage is required')))
      .toContain('AUTHORIZATION_DENIED: products.manage is required');
  });

  it('does not expose an empty or undefined error message', () => {
    expect(formatProductRegistrationError(undefined))
      .toContain('سبب غير محدد');
  });
});
