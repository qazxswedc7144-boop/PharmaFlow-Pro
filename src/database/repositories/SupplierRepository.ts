
import { db } from '@/core/db';
import { Supplier } from '@/types';

export const SupplierRepository = {
  getAll: async (): Promise<Supplier[]> => {
    return await db.suppliers.toArray();
  },

  getSuppliers: async (): Promise<Supplier[]> => {
    return await db.suppliers.toArray();
  },

  searchSuppliers: async (term: string): Promise<any[]> => {
    return await db.suppliers
      .filter((c: any) => 
        (c.Supplier_Name.toLowerCase().includes(term.toLowerCase()) || 
         c.Supplier_ID.toLowerCase().includes(term.toLowerCase())) &&
        c.Is_Active !== false
      )
      .limit(10)
      .toArray();
  },

  searchCustomers: async (term: string): Promise<any[]> => {
    return await db.customers
      .filter((c: any) => 
        (c.Supplier_Name.toLowerCase().includes(term.toLowerCase()) || 
         c.Supplier_ID.toLowerCase().includes(term.toLowerCase())) &&
        c.Is_Active !== false
      )
      .limit(10)
      .toArray();
  },

  getCustomers: async (): Promise<any[]> => {
    return await db.customers.toArray();
  },

  getById: async (id: string, type?: 'S' | 'C'): Promise<Supplier | undefined> => {
    if (type === 'C' || id.startsWith('C-')) {
      return await db.customers.get(id);
    }
    return await db.suppliers.get(id);
  },

  save: async (partner: Supplier, type?: 'S' | 'C'): Promise<string> => {
    const isCustomer = type === 'C' || partner.Supplier_ID?.startsWith('C-') || partner.id?.startsWith('C-');
    const partnerId = partner.id || partner.Supplier_ID || (isCustomer ? `C-${Date.now()}` : `S-${Date.now()}`);
    const partnerPayload = {
      ...partner,
      id: partnerId,
      Supplier_ID: partner.Supplier_ID || partnerId
    };
    if (isCustomer) {
       const key = await db.customers.put(partnerPayload);
       return String(key);
    }
    const key = await db.suppliers.put(partnerPayload);
    return String(key);
  },

  delete: async (id: string): Promise<void> => {
    if (id.startsWith('C-')) {
      await db.customers.delete(id);
    } else {
      await db.suppliers.delete(id);
    }
  },

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
    let query = db.journalEntries.where('partnerId').equals(partnerId);
    
    let entries = await query.toArray();

    if (start) {
      entries = entries.filter((e: any) => e.date >= start);
    }
    if (end) {
      entries = entries.filter((e: any) => e.date <= end);
    }

    return entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  },

  getInvoicePaymentHistory: async (invoiceId: string): Promise<any[]> => {
    const links = await db.vouchers.where('invoiceId').equals(invoiceId).toArray();
    if (links.length === 0) return [];

    const voucherIds = links.map((l: any) => l.voucherId);
    const vouchers = await db.vouchers.where('id').anyOf(voucherIds).toArray();

    return vouchers.map((v: any) => ({
      id: v.id,
      voucherId: v.voucher_id || v.id,
      date: v.date,
      amount: v.amount || 0
    }));
  }
};
