// src/domain/financial.domain.ts
import { DomainEntity } from "./base.types";
import { CurrencyCode } from "./enums.types";

export * from "./primitives.types";

/**
 * Financial Cash Flow Statement Line Entity
 */
export interface CashFlowEntry extends DomainEntity {
  id: string;
  date?: string;
  category?: 'OPERATING' | 'INVESTING' | 'FINANCING' | string;
  type?: 'INFLOW' | 'OUTFLOW' | 'دخل' | 'خرج' | string;
  amount?: number;
  description?: string;
  referenceId?: string;
  branchId?: string;

  // Compatibility fields
  transaction_id?: string;
  name?: string;
  notes?: string;
}

export type CashFlow = CashFlowEntry;

/**
 * Generic Financial Transaction Log Entity
 */
export interface FinancialTransaction extends DomainEntity {
  id: string;
  date?: string;
  type?: string;
  amount?: number;
  currency?: CurrencyCode | string;
  referenceId?: string;
  accountId?: string;
  partnerId?: string;
  description?: string;
  branchId?: string;

  // Compatibility fields
  Transaction_ID?: string;
  Transaction_Type?: string;
  Reference_ID?: string;
  Reference_Table?: string;
  Entity_Name?: string;
  Amount?: number;
  Direction?: string;
  Transaction_Date?: string;
  Notes?: string;
  Paid_Amount?: number;
  Created_At?: string;
  Created_By?: string;

  // Audit & Traceability
  isReversal?: boolean;
  reversalOf?: string;
  reversedBy?: string;
  isDeleted?: boolean;
}
