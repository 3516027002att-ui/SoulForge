#!/usr/bin/env node
/**
 * 编辑器布局门禁：App.tsx 编辑壳不得重新承载底栏、证据折叠区、底部日志或三张证据卡。
 *
 * 这里使用 TypeScript 的 TSX AST，而不是源码字符串扫描。这样 JSX 注释、普通
 * 文本、data 属性和无关函数参数不会被当成渲染点，同时仍能识别 className 的
 * 字符串、JSX 表达式、模板、静态拼接和常见 class 组合调用。
 *
 * 本门禁只证明 App.tsx 的 JSX 结构；不证明运行期布局、CSS 高度或面板内部布局。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const LABEL = 'editor-layout';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');
const MAX_STATIC_COMBINATIONS = 128;

const PROHIBITED_CLASSES = [
  {
    token: 'resource-evidence-details',
    code: 'EVIDENCE_DETAILS_PRESENT',
    message: 'App.tsx 编辑壳里出现了 resource-evidence-details 证据折叠区。'
  },
  {
    token: 'status-bar',
    code: 'STATUS_BAR_PRESENT',
    message: 'App.tsx 编辑壳里出现了 status-bar 状态栏。'
  }
];

const PROHIBITED_COMPONENTS = new Map([
  [
    'DiagnosticsLog',
    {
      code: 'DIAGNOSTICS_LOG_PRESENT',
      message: 'App.tsx 编辑壳里渲染了 DiagnosticsLog 底部日志区。'
    }
  ],
  [
    'StructuredPreviewCard',
    {
      code: 'EVIDENCE_CARD_PRESENT',
      card: 'StructuredPreviewCard',
      message: 'App.tsx 编辑壳里渲染了 StructuredPreviewCard 证据卡。'
    }
  ],
  [
    'NativeInspectionCard',
    {
      code: 'EVIDENCE_CARD_PRESENT',
      card: 'NativeInspectionCard',
      message: 'App.tsx 编辑壳里渲染了 NativeInspectionCard 证据卡。'
    }
  ],
  [
    'HexEditorPanel',
    {
      code: 'EVIDENCE_CARD_PRESENT',
      card: 'HexEditorPanel',
      message: 'App.tsx 编辑壳里渲染了 HexEditorPanel 证据卡。'
    }
  ]
]);

const CLASS_COMPOSERS = new Set([
  'classNames',
  'classnames',
  'clsx',
  'cn',
  'cx',
  'mergeClasses'
]);

/**
 * 验证一段 App.tsx TSX 源码。fixture 可以直接调用此函数，不需要改写真实
 * App.tsx 或进程级退出。
 */
export function verifyEditorLayoutSource(rawSource, { fileName = 'App.tsx' } = {}) {
  if (typeof rawSource !== 'string') {
    return {
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'APP_SOURCE_INVALID',
      message: 'App.tsx 源码不是字符串。'
    };
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    rawSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return {
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'APP_PARSE_FAILED',
      message: 'App.tsx 的 TSX AST 解析失败，门禁失败关闭。',
      diagnostics: parseDiagnostics.map((diagnostic) => diagnosticLocation(sourceFile, diagnostic))
    };
  }

  const jsxElements = collectJsxElements(sourceFile);
  const mainElements = jsxElements.filter((entry) => (
    !entry.selfClosing && entry.tagName === 'main'
  ));
  if (mainElements.length !== 1) {
    return {
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'APP_SHELL_UNPARSEABLE',
      message: '在 App.tsx 中无法唯一提取编辑器 <main> 壳；门禁失败关闭。',
      mainCount: mainElements.length,
      jsxElementCount: jsxElements.length
    };
  }

  const context = {
    sourceFile,
    initializers: collectStaticInitializers(sourceFile)
  };
  const findings = [];

  for (const entry of jsxElements) {
    const componentRule = PROHIBITED_COMPONENTS.get(entry.tagName);
    if (componentRule) {
      addFinding(findings, sourceFile, entry, componentRule.code, componentRule.message, {
        ...(componentRule.card ? { card: componentRule.card } : {})
      });
    }

    const classNameAttribute = findClassNameAttribute(entry.opening);
    if (!classNameAttribute) continue;

    const classValues = analyzeClassNameInitializer(
      classNameAttribute.initializer,
      context
    );
    for (const rule of PROHIBITED_CLASSES) {
      if (!containsClassToken(classValues, rule.token)) continue;
      addFinding(findings, sourceFile, entry, rule.code, rule.message, {
        classToken: rule.token,
        classNameExpression: classNameAttribute.initializer
          ? classNameAttribute.initializer.getText(sourceFile).slice(0, 240)
          : null
      });
    }
  }

  if (findings.length > 0) {
    return {
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'EDITOR_SHELL_VIOLATION',
      message: 'App.tsx 编辑壳里出现了 S12 已卸载的底栏、证据区、日志或证据卡。',
      findings
    };
  }

  return {
    ok: true,
    gate: LABEL,
    status: 'passed',
    message: 'App.tsx 编辑壳没有 status-bar / DiagnosticsLog / resource-evidence-details，也没有三张证据卡渲染。',
    jsxElementCount: jsxElements.length,
    mainCount: mainElements.length,
    nonClaim: '本门禁只读取 App.tsx 的 TSX AST，不证明运行期视觉顺序、不检查 CSS 高度，'
      + '也不覆盖各编辑器面板内部的布局。'
  };
}

/**
 * 验证真实 App.tsx 文件；保留旧入口的 APP_MISSING 失败码。
 */
export function verifyEditorLayoutFile(appPath = APP) {
  if (!existsSync(appPath)) {
    return {
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'APP_MISSING',
      message: '缺少 ' + appPath
    };
  }

  let rawSource;
  try {
    rawSource = readFileSync(appPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      gate: LABEL,
      status: 'failed',
      code: 'APP_READ_FAILED',
      message: '无法读取 ' + appPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return verifyEditorLayoutSource(rawSource, { fileName: appPath });
}

function collectJsxElements(sourceFile) {
  const elements = [];
  visit(sourceFile, (node) => {
    if (ts.isJsxOpeningElement(node)) {
      elements.push({
        opening: node,
        tagName: node.tagName.getText(sourceFile),
        selfClosing: false
      });
    } else if (ts.isJsxSelfClosingElement(node)) {
      elements.push({
        opening: node,
        tagName: node.tagName.getText(sourceFile),
        selfClosing: true
      });
    }
  });
  return elements;
}

function collectStaticInitializers(sourceFile) {
  const initializers = new Map();
  visit(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && !initializers.has(node.name.text)
    ) {
      initializers.set(node.name.text, node.initializer);
    }
  });
  return initializers;
}

function findClassNameAttribute(opening) {
  for (const property of opening.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.text === 'className') {
      return property;
    }
  }
  return null;
}

function analyzeClassNameInitializer(initializer, context) {
  if (!initializer) return classValueUnknown();
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return classValueFromText(initializer.text);
  }
  if (!ts.isJsxExpression(initializer)) return classValueUnknown();
  if (!initializer.expression) return classValueUnknown();
  return analyzeExpression(initializer.expression, context, new Set());
}

function analyzeExpression(expression, context, seen) {
  const node = unwrapExpression(expression);
  if (!node) return classValueUnknown();

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return classValueFromText(node.text);
  }

  if (ts.isTemplateExpression(node)) {
    return analyzeTemplateExpression(node, context, seen);
  }

  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) {
      return combineClassValues(
        analyzeExpression(node.left, context, seen),
        analyzeExpression(node.right, context, seen)
      );
    }
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken
      || operator === ts.SyntaxKind.BarBarToken
      || operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return mergeClassValues([
        analyzeExpression(node.left, context, seen),
        analyzeExpression(node.right, context, seen)
      ]);
    }
  }

  if (ts.isConditionalExpression(node)) {
    return mergeClassValues([
      analyzeExpression(node.whenTrue, context, seen),
      analyzeExpression(node.whenFalse, context, seen)
    ]);
  }

  if (ts.isIdentifier(node)) {
    const initializer = context.initializers.get(node.text);
    if (!initializer || seen.has(node.text)) return classValueUnknown();
    const nextSeen = new Set(seen);
    nextSeen.add(node.text);
    return analyzeExpression(initializer, context, nextSeen);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return mergeClassValues(
      node.elements.map((element) => analyzeExpression(
        ts.isSpreadElement(element) ? element.expression : element,
        context,
        seen
      ))
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    return mergeClassValues(node.properties.map((property) => {
      if (
        ts.isPropertyAssignment(property)
        && (ts.isStringLiteral(property.name)
          || ts.isNoSubstitutionTemplateLiteral(property.name))
      ) {
        return classValueFromText(property.name.text);
      }
      return classValueUnknown();
    }));
  }

  if (ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'join'
    ) {
      const array = unwrapExpression(node.expression.expression);
      if (array && ts.isArrayLiteralExpression(array)) {
        const elementValues = array.elements.map((element) => analyzeExpression(
          ts.isSpreadElement(element) ? element.expression : element,
          context,
          seen
        ));
        const separator = node.arguments.length > 0
          ? analyzeExpression(node.arguments[0], context, seen)
          : classValueFromText(',');
        const joined = joinStaticClassValues(elementValues, separator);
        if (joined.strings.size > 0) return joined;
        return mergeClassValues([...elementValues, separator]);
      }
    }

    const callableName = getCallableName(node.expression);
    if (callableName && CLASS_COMPOSERS.has(callableName)) {
      return mergeClassValues(node.arguments.map((argument) => analyzeExpression(
        ts.isSpreadElement(argument) ? argument.expression : argument,
        context,
        seen
      )));
    }
  }

  return classValueUnknown();
}

function analyzeTemplateExpression(node, context, seen) {
  let possible = new Set([node.head.text]);
  const fragments = new Set([node.head.text]);
  let unknown = false;

  for (const span of node.templateSpans) {
    const expression = analyzeExpression(span.expression, context, seen);
    for (const fragment of expression.fragments) fragments.add(fragment);
    if (possible.size > 0 && expression.strings.size > 0) {
      const next = new Set();
      for (const prefix of possible) {
        for (const value of expression.strings) {
          if (next.size >= MAX_STATIC_COMBINATIONS) break;
          next.add(prefix + value);
        }
        if (next.size >= MAX_STATIC_COMBINATIONS) break;
      }
      possible = next;
    } else {
      possible = new Set();
      unknown = true;
    }
    fragments.add(span.literal.text);
    if (possible.size > 0) {
      possible = new Set([...possible].map((value) => value + span.literal.text));
    }
  }

  return {
    strings: possible,
    fragments,
    unknown
  };
}

function joinStaticClassValues(elementValues, separator) {
  if (elementValues.some((value) => value.strings.size === 0) || separator.strings.size === 0) {
    return classValueUnknown();
  }
  const strings = new Set(['']);
  for (const values of elementValues) {
    const next = new Set();
    for (const prefix of strings) {
      for (const value of values.strings) {
        if (next.size >= MAX_STATIC_COMBINATIONS) break;
        next.add(prefix.length === 0 ? value : prefix + separator.strings.values().next().value + value);
      }
      if (next.size >= MAX_STATIC_COMBINATIONS) break;
    }
    strings.clear();
    for (const value of next) strings.add(value);
  }
  return classValueFromStrings(strings);
}

function unwrapExpression(expression) {
  let node = expression;
  while (node) {
    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node))
      || (typeof ts.isNonNullExpression === 'function' && ts.isNonNullExpression(node))
    ) {
      node = node.expression;
      continue;
    }
    break;
  }
  return node;
}

function getCallableName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function containsClassToken(classValues, token) {
  for (const candidate of [...classValues.strings, ...classValues.fragments]) {
    if (candidate.split(/\s+/u).includes(token)) return true;
  }
  return false;
}

function classValueFromText(text) {
  return {
    strings: new Set([text]),
    fragments: new Set([text]),
    unknown: false
  };
}

function classValueFromStrings(strings) {
  const fragments = new Set(strings);
  return {
    strings: new Set(strings),
    fragments,
    unknown: false
  };
}

function classValueUnknown() {
  return {
    strings: new Set(),
    fragments: new Set(),
    unknown: true
  };
}

function mergeClassValues(values) {
  const strings = new Set();
  const fragments = new Set();
  let unknown = false;
  for (const value of values) {
    if (!value) continue;
    for (const item of value.strings) {
      if (strings.size < MAX_STATIC_COMBINATIONS) strings.add(item);
    }
    for (const item of value.fragments) {
      if (fragments.size < MAX_STATIC_COMBINATIONS) fragments.add(item);
    }
    unknown ||= value.unknown;
  }
  return { strings, fragments, unknown };
}

function combineClassValues(left, right) {
  const strings = new Set();
  for (const leftValue of left.strings) {
    for (const rightValue of right.strings) {
      if (strings.size >= MAX_STATIC_COMBINATIONS) break;
      strings.add(leftValue + rightValue);
    }
    if (strings.size >= MAX_STATIC_COMBINATIONS) break;
  }
  const fragments = new Set([...left.fragments, ...right.fragments, ...strings]);
  return {
    strings,
    fragments,
    unknown: left.unknown || right.unknown || strings.size === 0
  };
}

function addFinding(findings, sourceFile, entry, code, message, extra = {}) {
  const location = locationOf(sourceFile, entry.opening);
  findings.push({
    code,
    tag: entry.tagName,
    line: location.line,
    column: location.column,
    at: location.at,
    message,
    ...extra
  });
}

function locationOf(sourceFile, node) {
  const at = node.getStart(sourceFile);
  const location = sourceFile.getLineAndCharacterOfPosition(at);
  return {
    at,
    line: location.line + 1,
    column: location.character + 1
  };
}

function diagnosticLocation(sourceFile, diagnostic) {
  const at = Math.min(
    diagnostic.start ?? 0,
    sourceFile.text.length
  );
  const location = sourceFile.getLineAndCharacterOfPosition(at);
  return {
    line: location.line + 1,
    column: location.character + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  };
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  const result = verifyEditorLayoutFile();
  report(result, result.ok ? 0 : 1);
}
