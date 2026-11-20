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
    expect(sourceText).toContain('if (isSavingRef.current || savePhase === \'saving\') return;');
    expect(sourceText).toContain('isSavingRef.current = false;');
  });
});
