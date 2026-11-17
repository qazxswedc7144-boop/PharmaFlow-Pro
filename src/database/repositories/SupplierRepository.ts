import { db } from '@/core/db';
import { Supplier } from '@/types';
import { getCurrentUserSession } from '@/core/db';

export const SupplierRepository = {
  // --- القراءة مع فلترة المؤسسة ---
  getAll: async (): Promise<Supplier[]> => {
    const session = getCurrentUserSession();
    if (!session.tenantId) {
      console.warn('[SupplierRepository] getAll called without tenant context');
      return [];
    }
    return await db.suppliers
      .where('tenantId')
      .equals(session.tenantId)
      .toArray();
  },

  getSuppliers: async (): Promise<Supplier[]> => {
    return await SupplierRepository.getAll();
  },

  getCustomers: async (): Promise<any[]> => {
    const session = getCurrentUserSession();
    if (!session.tenantId) {
      console.warn('[SupplierRepository] getCustomers called without tenant context');
      return [];
    }
    return await db.customers
      .where('tenantId')
      .equals(session.tenantId)
      .toArray();
  },

  // --- البحث مع Optional Chaining لمنع Crash ---
  searchSuppliers: async (term: string): Promise<any[]> => {
    const session = getCurrentUserSession();
    const searchTerm = term?.toLowerCase() || '';
    
    if (!searchTerm) {
      return [];
    }

    let query = db.suppliers
      .filter((c: any) => {
        // FAIL_SAFE: استخدام Optional Chaining لمنع Crash
        const name = c.Supplier_Name?.toLowerCase() || '';
        const id = c.Supplier_ID?.toLowerCase() || '';
        
        const matchesSearch = 
          name.includes(searchTerm) || 
          id.includes(searchTerm);
        
        const isActive = c.Is_Active !== false;
        
        // فلترة المؤسسة إذا كانت متوفرة
        const matchesTenant = !session.tenantId || 
                              c.tenantId === session.tenantId;
        
        return matchesSearch && isActive && matchesTenant;
      })
      .limit(10);

    return await query.toArray();
  },

  searchCustomers: async (term: string): Promise<any[]> => {
    const session = getCurrentUserSession();
    const searchTerm = term?.toLowerCase() || '';
    
    if (!searchTerm) {
      return [];
    }

    let query = db.customers
      .filter((c: any) => {
        // FAIL_SAFE: استخدام Optional Chaining لمنع Crash
        const name = c.Supplier_Name?.toLowerCase() || '';
        const id = c.Supplier_ID?.toLowerCase() || '';
        
        const matchesSearch = 
          name.includes(searchTerm) || 
          id.includes(searchTerm);
        
        const isActive = c.Is_Active !== false;
        
        // فلترة المؤسسة إذا كانت متوفرة
        const matchesTenant = !session.tenantId || 
                              c.tenantId === session.tenantId;
        
        return matchesSearch && isActive && matchesTenant;
      })
      .limit(10);

    return await query.toArray();
  },

  // --- القراءة بالمعرّف ---
  getById: async (id: string, type?: 'S' | 'C'): Promise<Supplier | undefined> => {
    if (type === 'C' || id.startsWith('C-')) {
      return await db.customers.get(id);
    }
    return await db.suppliers.get(id);
  },

  // --- الحفظ مع تسجيل حدث المزامنة ---
  save: async (partner: Supplier, type?: 'S' | 'C'): Promise<string> => {
    const session = getCurrentUserSession();
    const isCustomer = type === 'C' || 
                       partner.Supplier_ID?.startsWith('C-') || 
                       partner.id?.startsWith('C-');
    
    const partnerId = partner.id || 
                      partner.Supplier_ID || 
                      (isCustomer ? `C-${Date.now()}` : `S-${Date.now()}`);
    
    const partnerPayload = {
      ...partner,
      id: partnerId,
      Supplier_ID: partner.Supplier_ID || partnerId,
      // إضافة سياق المؤسسة
      tenantId: partner.tenantId || session.tenantId,
      branchId: partner.branchId || session.branchId,
      lastModified: new Date().toISOString()
    };

    let key: string;
    if (isCustomer) {
      key = String(await db.customers.put(partnerPayload));
    } else {
      key = String(await db.suppliers.put(partnerPayload));
    }

    // تسجيل حدث المزامنة
    try {
      await db.syncQueue.add({
        id: `sync-${Date.now()}-${key}`,
        entityType: isCustomer ? 'CUSTOMER' : 'SUPPLIER',
        operation: 'CREATE',
        entityId: key,
        tenantId: session.tenantId,
        branchId: session.branchId,
        createdAt: new Date().toISOString(),
        status: 'PENDING'
      });
    } catch (syncErr) {
      console.warn('[SupplierRepository] Failed to enqueue sync event:', syncErr);
      // لا نفشل العملية إذا فشل تسجيل المزامنة
    }

    return key;
  },

  // --- الحذف مع التحقق من التبعيات ---
  delete: async (id: string): Promise<void> => {
    // التحقق من وجود فواتير مرتبطة
    const hasInvoices = await db.invoices
      .where('partnerId')
      .equals(id)
      .count();
    
    if (hasInvoices > 0) {
      throw new Error(
        `CANNOT_DELETE: Cannot delete partner ${id} because it has ${hasInvoices} associated invoices.`
      );
    }

    // التحقق من وجود سندات مرتبطة
    const hasVouchers = await db.vouchers
      .where('partnerId')
      .equals(id)
      .count();
    
    if (hasVouchers > 0) {
      throw new Error(
        `CANNOT_DELETE: Cannot delete partner ${id} because it has ${hasVouchers} associated vouchers.`
      );
    }

    // الحذف الآمن
    if (id.startsWith('C-')) {
      await db.customers.delete(id);
    } else {
      await db.suppliers.delete(id);
    }

    // تسجيل حدث المزامنة للحذف
    try {
      const session = getCurrentUserSession();
      await db.syncQueue.add({
        id: `sync-${Date.now()}-${id}`,
        entityType: id.startsWith('C-') ? 'CUSTOMER' : 'SUPPLIER',
        operation: 'DELETE',
        entityId: id,
        tenantId: session.tenantId,
        branchId: session.branchId,
        createdAt: new Date().toISOString(),
        status: 'PENDING'
      });
    } catch (syncErr) {
      console.warn('[SupplierRepository] Failed to enqueue delete sync event:', syncErr);
    }
  },

  // --- Ledger ---
  postToLedger: async (entry: any, tx?: any): Promise<void> => {
    const journalEntriesTable = tx ? tx.table('journalEntries') : db.journalEntries;
    await journalEntriesTable.add({
      ...entry,
      created_at: new Date().toISOString()
    });
  },

  getPartnerBalance: async (id: string, type: 'S' | 'C'): Promise<number> => {
    const partner = await SupplierRepository.getById(id, type);
    return partner?.balance || 0;
  },

  getLedger: async (partnerId: string, start?: string, end?: string): Promise<any[]> => {
    const session = getCurrentUserSession();
    
    let query = db.journalEntries
      .where('partnerId')
      .equals(partnerId);
    
    // فلترة المؤسسة
    if (session.tenantId) {
      query = query.and((entry: any) => 
        entry.tenantId === session.tenantId
      );
    }
    
    let entries = await query.toArray();
    
    if (start) {
      entries = entries.filter((e: any) => e.date >= start);
    }
    if (end) {
      entries = entries.filter((e: any) => e.date <= end);
    }
    
    return entries.sort((a, b) => 
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );
  },

  getInvoicePaymentHistory: async (invoiceId: string): Promise<any[]> => {
    const session = getCurrentUserSession();
    
    const links = await db.vouchers
      .where('invoiceId')
      .equals(invoiceId)
      .and((v: any) => !session.tenantId || v.tenantId === session.tenantId)
      .toArray();
    
    if (links.length === 0) return [];
    
    const voucherIds = links.map((l: any) => l.voucherId);
    const vouchers = await db.vouchers
      .where('id')
      .anyOf(voucherIds)
      .and((v: any) => !session.tenantId || v.tenantId === session.tenantId)
      .toArray();
    
    return vouchers.map((v: any) => ({
      id: v.id,
      voucherId: v.voucher_id || v.id,
      date: v.date,
      amount: v.amount || 0
    }));
  }
};
