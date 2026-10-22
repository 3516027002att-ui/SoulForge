import ts from 'typescript';

/** Read syntax identifiers, so regexes, comments and literal text cannot hide
 * later calls or invent renderer wiring. TypeScript selects TS/TSX by filename. */
export function rendererIdentifiers(source, fileName = 'renderer.tsx') {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  if (parsed.parseDiagnostics.length > 0) {
    throw new Error(`RENDERER_SOURCE_UNPARSEABLE: ${fileName}: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, ' ')}`);
  }
  const names = new Set();
  function visit(node) {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'getBridgeMethod' && ts.isStringLiteral(node.arguments[0])) {
      names.add(node.arguments[0].text);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      names.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return names;
}
