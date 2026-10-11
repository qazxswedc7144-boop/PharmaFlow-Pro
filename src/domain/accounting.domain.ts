// src/domain/accounting.domain.ts
import { DomainEntity } from "./base.types";
import { AccountType, BalanceType, VoucherType, JournalType } from "./enums.types";

/**
 * Chart of Accounts Domain Entity
 */
export interface Account extends DomainEntity {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  balanceType: BalanceType;
  balance: number;
  debit: number;
  credit: number;
  isSystem: boolean;
  isActive: boolean;
  description?: string;
  parentId?: string;
  branchId?: string;

  // Compatibility fields
  account_id?: string;
  account_name?: string;
  account_type?: AccountType;
  balance_type?: BalanceType;
  parent_id?: string;
}

/**
 * Double-Entry Journal Line Item
 */
export interface JournalLine extends DomainEntity {
  id: string;
  lineId: string;
  entryId: string;
  accountId: string;
  accountCode?: string;
  accountName: string;
  debit: number;
  credit: number;
  type: 'DEBIT' | 'CREDIT';
  amount: number;
  description?: string;
  branchId?: string;

  // Compatibility fields
  entry_id?: string;
  account_id?: string;
}

/**
 * Double-Entry Journal Entry Domain Entity
 */
export interface JournalEntry extends DomainEntity {
  id: string;
  entryNumber?: string;
  date: string;
  referenceId?: string;
  description?: string;
  totalAmount?: number;
  status: 'Posted' | 'Saved' | 'DRAFT' | 'CANCELLED';
  sourceId: string;
  sourceType: string;
  journalType?: JournalType;
  tenantId?: string;
  branchId?: string;
  partnerId?: string;
  lines: JournalLine[];
  hash?: string;

  // Compatibility fields
  entry_id?: string;
  TotalAmount?: number;
  created_at?: string;
  timestamp?: string;
}

/**
 * General & Partner Ledger Entry
 */
export interface LedgerEntry extends DomainEntity {
  id: string;
  accountId?: string;
  accountCode?: string;
  partnerId?: string;
  partnerType?: 'CUSTOMER' | 'SUPPLIER';
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  referenceId: string;
  sourceType?: string;
  runningBalance?: number;
}

/**
 * Financial Voucher (Receipt / Payment / Journal)
 */
export interface Voucher extends DomainEntity {
  id: string;
  voucherNumber?: string;
  voucherType?: VoucherType;
  type?: string;
  date: string;
  partnerId?: string;
  partnerName?: string;
  accountId?: string;
  amount?: number;
  paymentMethod?: string;
  referenceId?: string;
  notes?: string;
  userId?: string;
  branchId?: string;
  status?: 'DRAFT' | 'POSTED' | 'CANCELLED';
  lines?: JournalLine[];

  // Compatibility fields
  linkId?: string;
  voucherId?: string;
  invoiceId?: string;
  Paid_Amount?: number;
  note?: string;
}

/**
 * Accounting Period Domain Entity
 */
export interface AccountingPeriod extends DomainEntity {
  id: string;
  startDate?: string;
  endDate?: string;
  isLocked?: boolean;
  lockedBy?: string;
  lockedAt?: string;

  // Compatibility fields
  Start_Date?: string;
  End_Date?: string;
  Is_Locked?: boolean;
  Locked_By?: string;
  Locked_At?: string;
}
