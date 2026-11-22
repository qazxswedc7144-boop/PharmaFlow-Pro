import { describe, expect, it } from "vitest";
import { toTrialBalanceColumns } from "../routes/accounting.routes.js";

describe("legacy trial balance debit/credit sign convention", () => {
  it("shows supplier liability and sales revenue posted as credit balances", () => {
    // Representative posted invoice journal lines. The account balance
    // projection stores debit - credit for every account type.
    const postedPurchaseLines = [
      { accountType: "LIABILITY", debit: 0, credit: 120 },
    ];
    const postedSaleLines = [
      { accountType: "REVENUE", debit: 0, credit: 85 },
    ];

    const supplierBalance = postedPurchaseLines.reduce(
      (balance, line) => balance + line.debit - line.credit,
      0,
    );
    const revenueBalance = postedSaleLines.reduce(
      (balance, line) => balance + line.debit - line.credit,
      0,
    );

    expect(supplierBalance).toBe(-120);
    expect(revenueBalance).toBe(-85);
    expect(toTrialBalanceColumns(supplierBalance)).toEqual({ debit: 0, credit: 120 });
    expect(toTrialBalanceColumns(revenueBalance)).toEqual({ debit: 0, credit: 85 });
  });

  it("shows debit-normal asset and expense balances in the debit column", () => {
    expect(toTrialBalanceColumns(40)).toEqual({ debit: 40, credit: 0 });
  });

  it("places debit balances in the debit column even for liability and revenue accounts", () => {
    // A debit balance on a normally credit account is a genuine debit balance,
    // not a reason to reverse the stored debit-minus-credit sign.
    expect(toTrialBalanceColumns(15)).toEqual({ debit: 15, credit: 0 });
  });

  it("returns zero columns for a zero balance", () => {
    expect(toTrialBalanceColumns(0)).toEqual({ debit: 0, credit: 0 });
  });
});
