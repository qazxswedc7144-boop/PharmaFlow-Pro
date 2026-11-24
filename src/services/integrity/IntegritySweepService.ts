
import { db, getCurrentUserSession } from '@/core/db';
import { SystemAlert } from '@/types';
import { LoadTestService } from '@/services/system/LoadTestService';

import { IS_PREVIEW } from '@/constants';
import { AnomalyScoringEngine } from '@/services/audit/AnomalyScoringEngine';

export class IntegritySweepService {
  
  /**
   * Main entry point to run the integrity sweep
   */
  static async runSweep(autoFix = false): Promise<boolean> {
    const { tenantId, userId } = getCurrentUserSession();
    if (!tenantId) {
      throw new Error('FAIL_CLOSED: لا يمكن تنفيذ فحص سلامة البيانات دون جلسة مؤسسة نشطة.');
    }
    
    console.log(`Starting Integrity Sweep (autoFix: ${autoFix})...`);
    const startTime = performance.now();
    let isHealthy = true;
    const errors: string[] = [];

    // Generic integrity sweeps are diagnostic-only. Financial, voucher, date,
    // and stock corrections require domain-specific reviewed workflows.
    if (autoFix) {
      console.warn('[IntegritySweep] AUTO_FIX_BLOCKED: generic integrity sweeps never mutate business records.');
    }

    try {
      // 1. Validate Journal Balance
      try {
        const journalBalance = await this.validateJournal();
        if (!journalBalance) {
          isHealthy = false;
          errors.push("Journal imbalance detected (Debits != Credits)");
        }
      } catch (e) {
        console.error("Journal check failed", e);
        isHealthy = false;
        errors.push("Journal integrity validation failed; no automatic repair was performed");
      }

      // 2. Validate Stock Balance
      try {
        const stockBalance = await this.validateStock();
        if (!stockBalance) {
          isHealthy = false;
          errors.push("Stock balance mismatch detected (Transactions != StockQuantity)");
        }
      } catch (e) {
        console.error("Stock check failed", e);
        isHealthy = false;
        errors.push("Stock integrity validation failed");
      }

      // 3. Validate AR/AP Consistency
      try {
        const arapConsistency = await this.validateARAP();
        if (!arapConsistency) {
          isHealthy = false;
          errors.push("AR/AP consistency mismatch detected");
        }
      } catch (e) {
        console.error("AR/AP check failed", e);
        isHealthy = false;
        errors.push("AR/AP integrity validation failed");
      }

      // 4. Validate No Orphan References
      try {
        const noOrphans = await this.validateOrphans();
        if (!noOrphans) {
          isHealthy = false;
          errors.push("Orphan references detected in transactions");
        }
      } catch (e) {
        console.error("Orphans check failed", e);
        isHealthy = false;
        errors.push("Orphan-reference validation failed");
      }

      // 5. Validate Voucher Consistency
      try {
        const voucherConsistency = await this.validateVouchers();
        if (!voucherConsistency) {
          isHealthy = false;
          errors.push("Voucher allocation inconsistency detected");
        }
      } catch (e) {
        console.error("Voucher check failed", e);
        isHealthy = false;
        errors.push("Voucher integrity validation failed");
      }

      // 6. Validate Date Formats (New)
      try {
        const datesHealthy = await this.validateDates();
        if (!datesHealthy) {
          isHealthy = false;
          errors.push("Malformed date strings detected in records");
        }
      } catch (e) {
        console.error("Date check failed", e);
        isHealthy = false;
        errors.push("Date integrity validation failed");
      }

      if (!isHealthy) {
        await this.handleCriticalError(errors, autoFix, userId || 'SYSTEM');
      }

      const endTime = performance.now();
      await LoadTestService.logMetric("INTEGRITY_SWEEP_TIME", Math.round(endTime - startTime), { isHealthy, errors });
      
      console.log(`Integrity Sweep Completed. Healthy: ${isHealthy}`);
      return isHealthy;
    } catch (error) {
      console.error("Integrity Sweep Failed:", error);
      return false;
    }
  }

  private static async validateJournal(): Promise<boolean> {
    const entries = await db.getJournalEntries();
    let healthy = true;

    for (const entry of entries) {
      const debits = (entry.lines || []).reduce((sum: number, line: any) => sum + (line.debit || 0), 0);
      const credits = (entry.lines || []).reduce((sum: number, line: any) => sum + (line.credit || 0), 0);

      if (Math.abs(debits - credits) > 0.01) {
        console.error(
          `[IntegritySweep] Imbalanced journal entry [${entry.id || 'unknown'}] was preserved. Manual review and an approved compensating reversal are required.`
        );
        healthy = false;
      }
    }

    return healthy;
  }

  private static async validateStock(): Promise<boolean> {
    const products = await db.getProducts();
    let healthy = true;

    for (const product of products) {
      if (!product.id) continue;
      const transactions = await db.inventoryTransactions.where('productId').equals(product.id).toArray();
      const calculatedStock = transactions.reduce((sum: number, transaction: any) => sum + (transaction.QuantityChange || 0), 0);
      const currentStock = Number(product.stock || product.StockQuantity || 0);

      if (Math.abs(calculatedStock - currentStock) > 0.01) {
        console.warn(
          `[IntegritySweep] Stock mismatch for [${product.name || product.Name}]: ledger=${calculatedStock}, stored=${currentStock}. No automatic stock mutation was performed.`
        );
        healthy = false;
      }
    }

    return healthy;
  }

  private static async validateARAP(): Promise<boolean> {
    const sales = await db.getSales();
    let healthy = true;

    for (const sale of sales) {
      if (sale.InvoiceStatus === 'CANCELLED') continue;
      const balance = sale.finalTotal - (sale.paidAmount || 0);

      if (balance < -0.01) {
        console.warn(
          `[IntegritySweep] Overpaid sale [${sale.SaleID}] detected. Payment history and paidAmount were preserved for manual reconciliation.`
        );
        healthy = false;
      }
    }

    const purchases = await db.getPurchases();
    for (const purchase of purchases) {
      if (purchase.invoiceStatus === 'CANCELLED') continue;
      const totalAmount = purchase.totalAmount || purchase.finalTotal || 0;
      const balance = totalAmount - (purchase.paidAmount || 0);

      if (balance < -0.01) {
        console.warn(
          `[IntegritySweep] Overpaid purchase [${purchase.invoiceId}] detected. Payment history and paidAmount were preserved for manual reconciliation.`
        );
        healthy = false;
      }
    }

    return healthy;
  }

  private static async validateOrphans(): Promise<boolean> {
    const transactions = await db.inventoryTransactions.toArray();
    let healthy = true;

    for (const transaction of transactions) {
      if (transaction.SourceDocumentType === 'SALE') {
        const sale = await db.sales.get(transaction.SourceDocumentID);
        if (!sale) {
          console.error(
            `[IntegritySweep] Orphan inventory transaction [${transaction.TransactionID}] references a missing sale. The record was preserved.`
          );
          healthy = false;
        }
      } else if (transaction.SourceDocumentType === 'PURCHASE') {
        const purchase = await db.purchases.get(transaction.SourceDocumentID);
        if (!purchase) {
          console.error(
            `[IntegritySweep] Orphan inventory transaction [${transaction.TransactionID}] references a missing purchase. The record was preserved.`
          );
          healthy = false;
        }
      }
    }

    return healthy;
  }

  private static async validateVouchers(): Promise<boolean> {
    const settlements = await db.settlements.toArray();
    const cashFlow = await db.getCashFlow();
    const vouchers = cashFlow.filter((item: any) => item.notes?.includes('سند #'));
    let healthy = true;

    for (const voucher of vouchers) {
      const voucherIdMatch = voucher.notes?.match(/سند #([A-Z0-9-]+)/);
      if (!voucherIdMatch) continue;

      const voucherId = voucherIdMatch[1];
      const voucherSettlements = settlements.filter((settlement: any) => settlement.voucherId === voucherId);
      const settledTotal = voucherSettlements.reduce((sum: number, settlement: any) => sum + settlement.amount, 0);

      if (settledTotal > voucher.amount + 0.01) {
        console.error(
          `[IntegritySweep] Over-allocated voucher [${voucherId}] detected. Settlement records were preserved for manual reconciliation.`
        );
        healthy = false;
      }
    }

    return healthy;
  }

  private static async validateDates(): Promise<boolean> {
    const tables = [
      'sales', 'purchases', 'journalEntries', 'Audit_Log', 'financialTransactions',
      'inventoryTransactions', 'cashFlow', 'settlements', 'Accounting_Periods',
      'systemAlerts', 'systemPerformanceLog', 'userBehavior', 'historicalMetrics'
    ] as const;
    let healthy = true;

    const actualTableNames = typeof db.getExistingTableNames === 'function'
      ? db.getExistingTableNames()
      : (Array.isArray(db.tables) ? db.tables.map((table: any) => table.name) : []);

    for (const tableName of tables) {
      if (!actualTableNames.includes(tableName)) continue;
      const table = (db.db as any)[tableName];
      if (!table) continue;

      try {
        const records = await table.toArray();
        for (const record of records) {
          const dateFields = [
            'date', 'TransactionDate', 'timestamp', 'Created_At', 'Modified_At',
            'Last_Updated', 'deleted_at', 'updatedAt', 'Start_Date', 'End_Date'
          ];

          for (const field of dateFields) {
            const dateValue = record[field];
            if (dateValue === undefined || dateValue === null) continue;

            const parsedDate = new Date(dateValue);
            if (Number.isNaN(parsedDate.getTime())) {
              console.error(
                `[IntegritySweep] Invalid historical date in ${tableName}.${field} for record ${record.id || record.TransactionID || record.Log_ID}. The original value was preserved.`
              );
              healthy = false;
            }
          }
        }
      } catch (error) {
        console.error(`Failed to validate dates in table ${tableName}:`, error);
        healthy = false;
      }
    }

    return healthy;
  }

  private static async handleCriticalError(errors: string[], autoFixRequested = false, actorUserId = 'SYSTEM') {
    const now = new Date().toISOString();

    // Persist the failed/blocked integrity action independently of alert de-duplication.
    // A repeated alert may be suppressed, but the audit trail must retain each repair attempt.
    const auditDetails = JSON.stringify({
      event: autoFixRequested ? 'INTEGRITY_REPAIR_BLOCKED' : 'INTEGRITY_FAILURE_DETECTED',
      autoFixRequested,
      errors,
      timestamp: now,
    });
    try {
      await db.addAuditLog(actorUserId, 'SYSTEM', 'INTEGRITY_SWEEP', auditDetails);
    } catch (auditError) {
      // Audit failure must not suppress the critical system alert or make the sweep healthy.
      console.error('[IntegritySweep] Failed to persist critical sweep audit record:', auditError);
    }

    // Check if we already have a recent critical alert for the same issues to prevent flooding
    const recentAlerts = await db.systemAlerts
      .where('timestamp').above(new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .filter((a: any) => a.severity === 'CRITICAL')
      .toArray();
    
    if (recentAlerts.length > 0) {
      console.warn("Critical error detected but skipping alert creation to prevent flooding.");
      return;
    }

    // Log CRITICAL_ERROR
    const alert: SystemAlert = {
      id: db.generateId('CRIT'),
      type: 'SYSTEM',
      severity: 'CRITICAL',
      message: `خطأ فادح في نزاهة البيانات: ${errors.join(' | ')}`,
      timestamp: now,
      isRead: false
    };
    await db.systemAlerts.put(alert);

    if (IS_PREVIEW) {
      console.warn("PREVIEW GUARD: Critical data integrity failure detected, but bypassing RECOVERY_MODE switch.");
      return;
    }

    // Instead of direct switch, we trigger the AnomalyScoringEngine
    // which will evaluate the overall risk score and decide if RECOVERY_MODE is needed.
    await AnomalyScoringEngine.calculateCurrentRiskScore();
    
    console.error("CRITICAL ERROR DETECTED: AnomalyScoringEngine triggered to evaluate system safety. 🛡️");
  }
}
