import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAuthStore } from '@/store/authStore';
import { SafeModePanel } from '@/layouts/SafeModePanel';

describe('SafeModePanel privileged recovery controls', () => {
  const setRole = (role: string) => {
    useAuthStore.setState({
      user: {
        id: 'safe-mode-user',
        role,
        tenantId: 'tenant-safe-mode',
        branchId: 'branch-safe-mode',
        permissions: [],
      } as any,
      tenantId: 'tenant-safe-mode',
      branchId: 'branch-safe-mode',
      roles: [role],
      permissions: [],
      isAuthenticated: true,
    });
  };

  beforeEach(() => {
    setRole('cashier');
  });

  it('keeps the recovery warning visible but hides all recovery controls from non-managers', () => {
    const markup = renderToStaticMarkup(<SafeModePanel />);

    expect(markup).toContain('وضع الأمان مفعل');
    expect(markup).toContain('صلاحية إدارة النظام');
    expect(markup).not.toContain('تشغيل فحص النزاهة');
    expect(markup).not.toContain('تصفير التنبيهات والعودة');
    expect(markup).not.toContain('استعادة نسخة احتياطية');
    expect(markup).not.toContain('إلغاء وضع الأمان يدوياً');
  });

  it('preserves the existing recovery controls for system administrators', () => {
    setRole('admin');
    const markup = renderToStaticMarkup(<SafeModePanel />);

    expect(markup).toContain('تشغيل فحص النزاهة');
    expect(markup).toContain('تصفير التنبيهات والعودة');
    expect(markup).toContain('استعادة نسخة احتياطية');
    expect(markup).toContain('إلغاء وضع الأمان يدوياً');
  });
});
