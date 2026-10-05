/**
 * 套件依赖自动判定（静态分析，唯一实现）。
 *
 * 为什么不手写一张 100+ 行的依赖表：手写表会立刻漂移——有人给某个 smoke
 * 加一行 process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY，表却不会跟着改，
 * 于是 verify.mjs 会把一个「缺环境就静默跳过」的套件当成静态套件报成通过。
 *
 * 因此依赖从代码本身推导：解析 npm script 链找到真实入口 .ts/.mjs 文件，
 * 再看该文件及其本仓库内的 import 闭包里读了哪些环境变量。表只保留无法
 * 从代码推导的事实（tier 归属、opt-in 开关语义）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { parseNpmForward, tokenizeCommands } from './commandPlan.mjs';

// Discovery analyzes many entry points sharing the same source modules. Cache
// syntax only; caller-specific inputs and requirements remain independent.
const sourceCache = new Map();
function parseSource(file) {
  const text = readFileSync(file, 'utf8');
  const cached = sourceCache.get(file);
  if (cached?.text === text) return cached.source;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  sourceCache.set(file, {text, source});
  return source;
}

/** 环境变量 → 需求类别。未列出的 SOULFORGE_* 不构成外部依赖。 */
const ENV_REQUIREMENT = Object.freeze({
  SOULFORGE_NATIVE_FIXTURE_REGISTRY: 'native-env',
  SOULFORGE_NATIVE_FIXTURE_ROOT: 'native-env',
  SOULFORGE_SEKIRO_GAME_ROOT: 'native-env',
  SOULFORGE_SEKIRO_ROOT: 'native-env',
  SOULFORGE_SEKIRO_MOD_ROOT: 'native-env',
  SOULFORGE_MSB_FIELDS: 'native-env',
  SOULFORGE_MSB_CAPTURE: 'native-env',
  SOULFORGE_MSB_PRODUCER: 'native-env',
  SOULFORGE_TAE_PIN_CONTROL_PRODUCT: 'native-env',
  SOULFORGE_TAE_INTERNAL_ORACLE_PATH: 'native-env',
  SOULFORGE_TPF_PRODUCT_ROOT: 'native-env',
  SF_REAL_TAE_SOURCE: 'native-env',
  SOULFORGE_EMEDF_PATH: 'emedf',
  SOULFORGE_INSTALLER_LIFECYCLE_RUN: 'opt-in',
  // script 容器 game-load 真实加载确认：opt-in 用户游戏内确认，未设置时该 leg 结构化跳过。
  SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED: 'opt-in',
  SOULFORGE_DOTNET: 'dotnet'
});

/** dotnet 依赖也可由这些模块引入（Bridge 进程）。 */
const DOTNET_MODULE_HINTS = Object.freeze([
  'scripts/run-dotnet.mjs',
  'bridge/runBridge',
  'bridgeDaemon'
]);

/**
 * 从 npm script 命令行解析出本仓库内的入口文件与转发目标。
 *
 * 支持的形态：
 * - `node scripts/x.mjs [args]`
 * - `npm run <name> -w <workspace>` / `--workspace <ws>`（转发）
 * - `tsc -b ... && node dist/testing/x.js`（workspace 内编译后执行）
 * - `a && b`（取全部段）
 *
 * @returns {{ entries: string[], forwards: Array<{script: string, workspace: string|null}> }}
 */
export function parseScriptCommand(command, workspaceDir) {
  const entries = [];
  const forwards = [];
  for (const tokens of tokenizeCommands(command) ?? []) {
    const forward = parseNpmForward(tokens);
    if (forward) {
      const { args, ...target } = forward;
      forwards.push({ ...target, ...(args.length ? { args } : {}) });
      continue;
    }
    if (tokens[0] === 'node') {
      const file = tokens.slice(1).find((token) => !token.startsWith('-'));
      if (file) entries.push({ file, workspaceDir });
    }
  }
  return { entries, forwards };
}

/**
 * dist/testing/xSmoke.js → packages/<ws>/src/testing/xSmoke.ts
 * 编译产物不进版本库，静态分析必须回到源码。
 */
function toSourcePath(repoRoot, workspaceDir, file) {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.startsWith('dist/')) {
    const relative = normalized.slice('dist/'.length).replace(/\.js$/, '.ts');
    return resolve(repoRoot, workspaceDir, 'src', relative);
  }
  return resolve(repoRoot, workspaceDir, normalized);
}


/** 解析相对 import 到实际文件（.ts / .mjs / .js / index）。 */
function resolveImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, 'index.ts')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 收集入口文件 import 闭包内读到的环境变量与 dotnet 线索。
 * 闭包限定在本仓库源码内；node_modules 与包名 import 不跟进。
 */
export function analyzeEntry(entryFile, { maxFiles = 512 } = {}) {
  const modules = new Map();
  const envVars = new Set();
  let dotnetHint = false;
  let packagedAppInput = false;
  let truncated = false;
  const unknown = Symbol('unknown input');
  const nonemptyPath = Symbol('nonempty owned path');
  const temporaryBase = Symbol('temporary allocation parent');
  const packagedPath = Symbol('packaged application resources');
  const envObject = Symbol('environment');
  const processObject = Symbol('global process');
  const taintedInputs = new WeakSet();
  const tasks = [];
  const visited = new Set();
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isNonNullExpression(node) || ts.isAwaitExpression(node))) node = node.expression;
    return node;
  };
  const property = node => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
  const isFunction = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  const known = value => value !== unknown;
  const containsEnvironment = value => value === envObject || (value && typeof value === 'object'
    && Object.values(value).some(containsEnvironment));
  const truthy = value => value === nonemptyPath || (known(value) && Boolean(value));
  // A literal path can still select private resources. Only an allocated,
  // test-owned root proves that a native input fallback is unnecessary.
  const safeFallback = value => truthy(value) && value !== temporaryBase && value !== packagedPath && typeof value !== 'string';
  const isPackagedPath = value => value === packagedPath || (typeof value === 'string'
    && /\brelease[\\/](?:win|linux|mac)-unpacked[\\/]resources\b/u.test(value));
  const keyValue = value => value === unknown ? '?' : value === nonemptyPath ? '<path>'
    : value === temporaryBase ? '<temporary-parent>'
    : value === packagedPath ? '<packaged-resources>'
    : value === envObject ? '<env>' : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, keyValue(item)])) : value;

  // Only values proven by syntax can remove a fallback. Unknown, empty and
  // externally selected roots retain the native requirement. This is a small
  // input analysis, never execution of a check or a read of the user's corpus.
  const valueOf = (raw, scope, module) => {
    const node = unwrap(raw);
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      if (isPackagedPath(node.head.text) || node.templateSpans.some(span => isPackagedPath(span.literal.text)
        || isPackagedPath(valueOf(span.expression, scope, module)))) return packagedPath;
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = valueOf(span.expression, scope, module);
        if (typeof value !== 'string') return unknown;
        text += value + span.literal.text;
      }
      return text;
    }
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      const value = node.text === 'undefined' ? undefined : scope.has(node.text) ? scope.get(node.text)
        : node.text === 'process' ? processObject : unknown;
      return value && typeof value === 'object' && taintedInputs.has(value) ? unknown : value;
    }
    if (ts.isBinaryExpression(node)) {
      const left = valueOf(node.left, scope, module);
      if (!known(left)) return unknown;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: {
          const right = valueOf(node.right, scope, module);
          if (isPackagedPath(left) || isPackagedPath(right)) return packagedPath;
          return typeof left === 'string' && typeof right === 'string' ? left + right : unknown;
        }
        case ts.SyntaxKind.BarBarToken: return truthy(left) ? safeFallback(left) ? left : unknown : valueOf(node.right, scope, module);
        case ts.SyntaxKind.AmpersandAmpersandToken: return truthy(left) ? valueOf(node.right, scope, module) : left;
        case ts.SyntaxKind.QuestionQuestionToken: return left != null ? safeFallback(left) ? left : unknown : valueOf(node.right, scope, module);
        default: return unknown;
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result = Object.create(null);
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) return valueOf(item.expression, scope, module) === envObject ? envObject : unknown;
        if (ts.isPropertyAssignment(item) && !ts.isComputedPropertyName(item.name)) result[item.name.text] = valueOf(item.initializer, scope, module);
        else if (ts.isShorthandPropertyAssignment(item)) result[item.name.text] = valueOf(item.name, scope, module);
        else return unknown;
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const object = valueOf(node.expression, scope, module);
      if (object === processObject && (property(node) ?? valueOf(node.argumentExpression, scope, module)) === 'env') return envObject;
      return object && typeof object === 'object' && property(node) !== null ? object[property(node)] : unknown;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = scope.has(node.expression.text) ? null : module.imports.get(node.expression.text);
      if (binding?.specifier === 'node:os' && binding.name === 'tmpdir') return temporaryBase;
      if (binding && ((binding.specifier === 'node:fs' && binding.name === 'mkdtempSync')
        || (binding.specifier === 'node:fs/promises' && binding.name === 'mkdtemp'))
        && valueOf(node.arguments[0], scope, module) === temporaryBase) return nonemptyPath;
      if (binding?.specifier === 'node:path' && ['join', 'resolve'].includes(binding.name)) {
        const values = node.arguments.map(arg => valueOf(arg, scope, module));
        if (values.some(isPackagedPath) || isPackagedPath(values.filter(value => typeof value === 'string').join('/'))) return packagedPath;
        if ([nonemptyPath, temporaryBase].includes(values[0]) && values.slice(1).every(value => typeof value === 'string'
          && !/^(?:[\\/]|[a-z]:)/iu.test(value) && !value.split(/[\\/]/u).includes('..'))) return values[0];
      }
    }
    return unknown;
  };

  const load = file => {
    if (!file || !existsSync(file)) return null;
    if (modules.has(file)) return modules.get(file);
    if (modules.size >= maxFiles) {truncated = true; return null;}
    let source;
    try {source = parseSource(file);} catch {return null;}
    const module = {file, source, imports:new Map(), functions:new Map(), reexports:new Map(), scope:new Map(), initialized:false};
    modules.set(file, module);
    if (DOTNET_MODULE_HINTS.some(hint => file.replaceAll('\\', '/').includes(hint))) dotnetHint = true;
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        if (statement.name) module.functions.set(statement.name.text, statement);
        if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) module.functions.set('default', statement);
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isFunction(declaration.initializer)) module.functions.set(declaration.name.text, declaration.initializer);
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const specifier = statement.moduleSpecifier?.text;
        const target = specifier?.startsWith('.') ? resolveImport(file, specifier) : specifier ? null : file;
        if (target) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) {
            if (!item.isTypeOnly) module.reexports.set(item.name.text, {file:target, name:item.propertyName?.text ?? item.name.text});
          }
          else module.reexports.set('*', [...(module.reexports.get('*') ?? []), {file:target}]);
          if (target !== file) tasks.push({file:target});
        }
      }
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) module.reexports.set('default', {file, name:statement.expression.text});
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      const target = specifier.startsWith('.') ? resolveImport(file, specifier) : null;
      if (DOTNET_MODULE_HINTS.some(hint => specifier.includes(hint))) dotnetHint = true;
      const bind = (local, name) => module.imports.set(local, {specifier, target, name});
      if (statement.importClause?.name) bind(statement.importClause.name.text, 'default');
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if (!item.isTypeOnly) bind(item.name.text, item.propertyName?.text ?? item.name.text);
      }
      if (bindings && ts.isNamespaceImport(bindings)) bind(bindings.name.text, '*');
      if (target) tasks.push({file:target});
    }
    return module;
  };
  const callTarget = (expression, module) => {
    if (ts.isIdentifier(expression)) {
      if (module.functions.has(expression.text)) return {file:module.file, name:expression.text};
      return module.imports.get(expression.text);
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const binding = module.imports.get(expression.expression.text);
      if (binding?.name === '*') return {...binding, name:expression.name.text};
    }
    return null;
  };
  const enqueueCall = (target, args) => {
    const file = target?.target ?? target?.file;
    if (file) tasks.push({file, name:target.name, args});
  };
  const invalidateInput = (node, scope, module) => {
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
    if (!ts.isIdentifier(node)) return;
    const value = valueOf(node, scope, module);
    if (value && typeof value === 'object') taintedInputs.add(value);
    scope.set(node.text, unknown);
  };
  const visit = (node, scope, module) => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (ts.isFunctionDeclaration(node) && node.parent === module.source) return;
    // Constructors and methods are conservatively traversed too; their
    // parameters must shadow imported allocators just like function parameters.
    if (ts.isParameter(node)) {bindParameter(node, unknown, scope, module); return;}
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) {
        if (!isFunction(node.initializer) || !module.functions.has(node.name.text)) visit(node.initializer, scope, module);
      }
      if (ts.isIdentifier(node.name)) {
        const value = valueOf(node.initializer, scope, module);
        // Discard ownership proofs for mutable objects without discarding an
        // environment object captured inside them. Such escapes stay uncertain.
        if (value && typeof value === 'object' && containsEnvironment(value)) {
          for (const possible of Object.keys(ENV_REQUIREMENT)) envVars.add(possible);
        }
        // Mutable objects do not prove input ownership. Direct argument
        // literals are analyzed separately; every local object alias is unknown.
        scope.set(node.name.text, value === envObject ? envObject : (node.parent.flags & ts.NodeFlags.Const)
          && !(value && typeof value === 'object') ? value : unknown);
      }
      if (ts.isObjectBindingPattern(node.name) && valueOf(node.initializer, scope, module) === envObject) {
        for (const item of node.name.elements) envVars.add(item.propertyName?.text ?? item.name.text);
      }
      if (ts.isObjectBindingPattern(node.name) && valueOf(node.initializer, scope, module) === processObject) {
        for (const item of node.name.elements) if ((item.propertyName?.text ?? item.name.text) === 'env'
          && ts.isIdentifier(item.name)) scope.set(item.name.text, envObject);
      }
      return;
    }
    if (isFunction(node)) {
      const local = new Map(scope);
      for (const parameter of node.parameters) bindParameter(parameter, unknown, local, module);
      if (node.body) visit(node.body, local, module);
      return;
    }
    if (ts.isBlock(node)) {
      const local = new Map(scope);
      // Shadowed imported allocators must never prove a test-owned root.
      for (const statement of node.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) local.set(statement.name.text, unknown);
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) local.set(declaration.name.text, unknown);
        }
      }
      for (const statement of node.statements) visit(statement, local, module);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      visit(node.left, scope, module);
      const value = valueOf(node.left, scope, module);
      const operator = node.operatorToken.kind;
      if ((operator === ts.SyntaxKind.BarBarToken && safeFallback(value))
        || (operator === ts.SyntaxKind.QuestionQuestionToken && known(value) && value != null && safeFallback(value))
        || (operator === ts.SyntaxKind.AmpersandAmpersandToken && known(value) && !truthy(value))) return;
      visit(node.right, scope, module);
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) invalidateInput(node.left, scope, module);
      return;
    }
    if (ts.isDeleteExpression(node)) {
      visit(node.expression, scope, module);
      invalidateInput(node.expression, scope, module);
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      visit(node.operand, scope, module);
      invalidateInput(node.operand, scope, module);
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (valueOf(node.expression, scope, module) === envObject) {
        const name = property(node) ?? valueOf(node.argumentExpression, scope, module);
        if (typeof name === 'string' && /^(?:SOULFORGE_|SF_REAL_)/u.test(name)) envVars.add(name);
        // A runtime-selected environment key may select a private input. Keep
        // every mapped prerequisite possible rather than dropping the read.
        if (name === unknown) for (const possible of Object.keys(ENV_REQUIREMENT)) envVars.add(possible);
      }
    }
    if (ts.isCallExpression(node)) {
      const target = callTarget(node.expression, module);
      enqueueCall(target, node.arguments.map(arg => valueOf(arg, scope, module)));
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) {
        const specifier = node.arguments[0].text;
        if (specifier.startsWith('.')) tasks.push({file:resolveImport(module.file, specifier), name:'*'});
      }
      if (/^(?:readFileSync|readFile|statSync|stat|existsSync)$/u.test(property(node.expression) ?? node.expression.text ?? '')
        && node.arguments.some(arg => isPackagedPath(valueOf(arg, scope, module)) || isPackagedPath(arg.getText(module.source)))) packagedAppInput = true;
      // Passing an export as a callback retains unknown/default inputs;
      // a direct call supplies only values actually proven at that call site.
      for (const arg of node.arguments) visit(arg, scope, module);
      if (!target) visit(node.expression, scope, module);
      // Opaque calls can mutate an object supplied by a variable or alias.
      // Its previous fields cannot prove that a later fallback is unreachable.
      for (const arg of node.arguments) {
        const value = valueOf(arg, scope, module);
        if ((ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg) || ts.isElementAccessExpression(arg))
          && value && typeof value === 'object') invalidateInput(arg, scope, module);
      }
      return;
    }
    if (ts.isIdentifier(node)) enqueueCall(callTarget(node, module), undefined);
    ts.forEachChild(node, child => visit(child, scope, module));
  };
  const bindParameter = (parameter, input, scope, module) => {
    let value = input;
    if (parameter.initializer && (input === undefined || input === unknown)) {
      visit(parameter.initializer, scope, module);
      if (input === undefined) value = valueOf(parameter.initializer, scope, module);
    }
    const bind = (name, selected) => {
      if (ts.isIdentifier(name)) {scope.set(name.text, selected); return;}
      if (ts.isObjectBindingPattern(name)) for (const element of name.elements) {
        const key = element.propertyName?.text ?? element.name.text;
        if (selected === envObject && /^(?:SOULFORGE_|SF_REAL_)/u.test(key)) envVars.add(key);
        let member = selected && typeof selected === 'object' ? selected[key] : selected === unknown ? unknown : undefined;
        if (element.initializer && (member === undefined || member === unknown)) {
          visit(element.initializer, scope, module);
          if (member === undefined) member = valueOf(element.initializer, scope, module);
        }
        bind(element.name, member);
      }
      else ts.forEachChild(name, child => visit(child, scope, module));
    };
    bind(parameter.name, value);
  };
  tasks.push({file:entryFile, name:'*'});
  while (tasks.length && visited.size < maxFiles * 100) {
    const task = tasks.shift();
    const module = load(task.file);
    if (!module) continue;
    if (!module.initialized) {
      module.initialized = true;
      for (const statement of module.source.statements) visit(statement, module.scope, module);
    }
    if (task.name === '*') {
      const key = `${module.file}:*`;
      if (!visited.has(key)) {
        visited.add(key);
        for (const [name, target] of module.reexports) {
          if (name === '*') for (const edge of target) enqueueCall({...edge, name:'*'}, undefined);
          else enqueueCall(target, undefined);
        }
      }
    }
    const names = task.name === '*' ? [...module.functions.keys()] : task.name ? [task.name] : [];
    for (const name of names) {
      const key = `${module.file}:${name}:${JSON.stringify(task.args?.map(keyValue))}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const fn = module.functions.get(name);
      if (!fn) {
        const forwarded = module.reexports.get(name);
        if (forwarded) enqueueCall(forwarded, task.args);
        else for (const edge of module.reexports.get('*') ?? []) enqueueCall({...edge, name}, task.args);
        continue;
      }
      const scope = new Map(module.scope);
      fn.parameters.forEach((parameter, index) => bindParameter(parameter, task.args ? task.args[index] : unknown, scope, module));
      if (fn.body) visit(fn.body, scope, module);
    }
  }
  truncated ||= tasks.length > 0;
  if (truncated) {
    const error = new Error(`CHECK_CLASSIFICATION_INCOMPLETE: dependency analysis exceeded its bound (${modules.size}/${maxFiles} source files).`);
    error.code = 'CHECK_CLASSIFICATION_INCOMPLETE';
    error.diagnostics = [{code:error.code, entryFile, analyzedFiles:modules.size, maxFiles, remainingTasks:tasks.length}];
    throw error;
  }
  const requirements = new Set();
  for (const envVar of envVars) {
    const requirement = ENV_REQUIREMENT[envVar];
    if (requirement) requirements.add(requirement);
  }
  if (dotnetHint) requirements.add('dotnet');
  if (packagedAppInput) requirements.add('packaged-app');
  return {
    analyzedFiles: modules.size,
    envVars: [...envVars].sort(),
    requirements: [...requirements].sort(),
    truncated
  };
}
