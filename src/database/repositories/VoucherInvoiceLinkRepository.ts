
import { db } from '@/core/db';
import { VoucherInvoiceLink } from '@/types';

export const VoucherInvoiceLinkRepository = {
  createLink: async (voucherId: string, invoiceId: string, amount: number, note?: string, _tx?: any): Promise<string> => {
    const id = db.generateId('LNK');
    const link: VoucherInvoiceLink = {
      id,
      linkId: id,
      voucherId,
      invoiceId,
      Paid_Amount: amount,
      note,
      updatedAt: new Date().toISOString()
    };
    const linksTbl = (_tx && _tx.voucherInvoiceLinks) ? _tx.voucherInvoiceLinks : db.voucherInvoiceLinks;
    await linksTbl.put(link);
    return id;
  },

  getByVoucher: async (voucherId: string): Promise<VoucherInvoiceLink[]> => {
    return await db.voucherInvoiceLinks.where('voucherId').equals(voucherId).toArray();
  },

  getByInvoice: async (invoiceId: string): Promise<VoucherInvoiceLink[]> => {
    return await db.voucherInvoiceLinks.where('invoiceId').equals(invoiceId).toArray();
  },

  getTotalPaidForInvoice: async (invoiceId: string): Promise<number> => {
    const links = await VoucherInvoiceLinkRepository.getByInvoice(invoiceId);
    return links.reduce((sum, l) => sum + (l.Paid_Amount || 0), 0);
  }
};
