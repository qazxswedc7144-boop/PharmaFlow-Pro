export function formatProductRegistrationError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';

  const detail = message.trim() || 'سبب غير محدد';
  return `تعذر تسجيل الصنف محلياً: ${detail}`;
}
