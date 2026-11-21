import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const sourcePath = resolve(process.cwd(), 'src/features/sales/hooks/useSales.ts');
const sourceText = readFileSync(sourcePath, 'utf8');
const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function findNode<T extends ts.Node>(node: ts.Node, predicate: (candidate: ts.Node) => candidate is T): T | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => findNode(child, predicate));
}

function getHandlePostCallback(): string {
  const declaration = findNode(
    sourceFile,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'handlePost'
  );

  if (!declaration?.initializer || !ts.isCallExpression(declaration.initializer)) {
    throw new Error('Could not locate the useSales handlePost callback.');
  }

  const callback = declaration.initializer.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) {
    throw new Error('The useSales handlePost callback is not an arrow function.');
  }

  return sourceText.slice(callback.getStart(sourceFile), callback.end);
}

describe('useSales handlePost resolved failure contract', () => {
  const handlePost = findNode(
    sourceFile,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'handlePost'
  );

  it('moves a resolved unsuccessful result to failed and reports the failure', () => {
    expect(handlePost?.initializer).toBeDefined();
    const failureBranch = findNode(
      handlePost!.initializer!,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && sourceText.slice(node.expression.getStart(sourceFile), node.expression.end).includes('!res?.success')
    );

    expect(failureBranch).toBeDefined();
    const branchText = sourceText.slice(failureBranch!.thenStatement.getStart(sourceFile), failureBranch!.thenStatement.end);

    expect(branchText).toContain("setSavePhase('failed')");
    expect(branchText).toContain("showNotification('❌ تعذر حفظ فاتورة المبيعات', 'error')");
    expect(branchText).toContain("addToast(failureMessage, 'error')");
    expect(branchText).toContain('return;');
  });

  it('preserves the operation key and draft on failure so a retry reuses the same request', () => {
    const failureBranch = findNode(
      handlePost!.initializer!,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && sourceText.slice(node.expression.getStart(sourceFile), node.expression.end).includes('!res?.success')
    );
    const branchText = sourceText.slice(failureBranch!.thenStatement.getStart(sourceFile), failureBranch!.thenStatement.end);

    expect(branchText).not.toContain('currentOperationRef.current = null');
    expect(branchText).not.toContain('clearInvoiceDraft');
    expect(branchText).not.toContain('clearDraft');
    expect(sourceText).toContain("if (isSavingRef.current || savePhase === 'saving') return;");
    expect(sourceText).toContain('isSavingRef.current = false;');
  });

  it('executes the real handlePost callback: retries a resolved failure with the identical transactionUuid', async () => {
    let savePhase: 'idle' | 'saving' | 'failed' = 'idle';
    const currentOperationRef: { current: string | null } = { current: null };
    const isSavingRef = { current: false };
    const addInvoiceRequests: Array<Record<string, any>> = [];
    const savedDraftUuids: string[] = [];
    const savingTransitions: boolean[] = [];
    const notifications: string[] = [];
    const toasts: string[] = [];
    let generatedUuidCount = 0;

    let addInvoiceCallCount = 0;
    const addInvoice = async (request: Record<string, any>) => {
      addInvoiceRequests.push(request);
      addInvoiceCallCount += 1;
      return addInvoiceCallCount === 1
        ? { success: false, error: 'SIMULATED_WORKFLOW_FAILURE' }
        : { success: true, refId: 'invoice-retry-success', syncStatus: 'SYNCED' };
    };

    const dependencies = {
      isSavingRef,
      savePhase,
      items: [{ id: 'item-1', product_id: 'product-1', qty: 1, price: 10 }],
      isLocked: false,
      isDuplicate: false,
      salesPolicy: { tenantId: 'tenant-test' },
      pricingState: { result: { totalAmount: '10.00' }, error: null },
      addToast: (message: string) => toasts.push(message),
      setIsSaving: (value: boolean) => savingTransitions.push(value),
      setSavePhase: (value: 'idle' | 'saving' | 'failed') => { savePhase = value; },
      showNotification: (message: string) => notifications.push(message),
      currentOperationRef,
      generateTransactionUuid: () => {
        generatedUuidCount += 1;
        return 'SALE-retry-stable-uuid';
      },
      customers: [],
      header: {
        customer_id: 'customer-1',
        invoice_number: 'SALE-TEST-001',
        payment_method: 'Cash',
        notes: '',
        attachment: '',
        date: '2026-11-21',
        isReturn: false
      },
      DraftService: {
        saveInvoiceDraft: async (_key: string, _type: string, _items: unknown[], metadata: { transactionUuid: string }) => {
          savedDraftUuids.push(metadata.transactionUuid);
        }
      },
      vTotalSum: 10,
      InvoiceWorkflowEngine: {
        determineNextStatus: () => 'POSTED'
      },
      editingInvoiceId: null,
      currency: 'YER',
      addInvoice,
      reportCache: { purge: async () => undefined },
      db: { incrementDataVersion: async () => undefined },
      ReportEngine: { scheduleRefreshInBackground: async () => undefined },
      refreshGlobal: async () => undefined,
      auditLogService: { logSale: async () => undefined },
      configurationService: { delete: async () => undefined },
      setSaveSuccessData: () => undefined,
      setEditingInvoiceId: () => undefined,
      resetInvoiceState: async () => { currentOperationRef.current = null; },
      onNavigate: () => undefined
    };

    const dependencyNames = Object.keys(dependencies);
    const callbackSource = getHandlePostCallback();
    const javascriptCallback = ts.transpileModule(callbackSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None
      }
    }).outputText.trim().replace(/;\\s*$/, '');
    const compileCallback = new Function(...dependencyNames, `return (${javascriptCallback});`) as (...args: unknown[]) => () => Promise<void>;

    const renderHandlePost = () => compileCallback(...dependencyNames.map(name =>
      name === 'savePhase' ? savePhase : dependencies[name as keyof typeof dependencies]
    ));

    await renderHandlePost()();

    expect(savePhase).toBe('failed');
    expect(isSavingRef.current).toBe(false);
    expect(savingTransitions).toEqual([true, false]);
    expect(addInvoiceRequests).toHaveLength(1);
    expect(savedDraftUuids).toEqual(['SALE-retry-stable-uuid']);
    expect(currentOperationRef.current).toBe('SALE-retry-stable-uuid');

    // A React rerender creates a fresh callback closure with savePhase='failed',
    // while the operation ref and the exact draft/request identity remain stable.
    await renderHandlePost()();

    expect(savePhase).toBe('idle');
    expect(isSavingRef.current).toBe(false);
    expect(savingTransitions).toEqual([true, false, true, false]);
    expect(addInvoiceRequests).toHaveLength(2);
    expect(addInvoiceRequests.map(request => request.payload.transactionUuid)).toEqual([
      'SALE-retry-stable-uuid',
      'SALE-retry-stable-uuid'
    ]);
    expect(savedDraftUuids).toEqual([
      'SALE-retry-stable-uuid',
      'SALE-retry-stable-uuid'
    ]);
    expect(generatedUuidCount).toBe(1);
    expect(notifications.filter(message => message.includes('تعذر حفظ فاتورة المبيعات'))).toHaveLength(2);
    expect(toasts).toContain('SIMULATED_WORKFLOW_FAILURE');
  });
});
