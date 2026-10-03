import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { buildSync } from 'esbuild';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

/** Run real TypeScript modules; mock only the Electron transport boundary. */
export function loadSource(relativePath, electron = {}) {
  const modules = new Map();
  const load = (filename) => {
    if (modules.has(filename)) return modules.get(filename).exports;
    const source = readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const module = { exports: {} };
    modules.set(filename, module);
    const localRequire = (specifier) => {
      if (specifier === 'electron') return electron;
      if (specifier === '@soulforge/shared') {
        return Object.assign({}, ...[
          'auxiliary-ipc', 'editor-protocol', 'param-ipc-protocol', 'update-ipc', 'path-sanitizer'
        ].map((name) => load(resolve(repoRoot, `packages/shared/src/${name}.ts`))));
      }
      if (specifier.startsWith('.')) return load(resolve(dirname(filename), specifier.replace(/\.js$/, '.ts')));
      return require(specifier);
    };
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename })(localRequire, module, module.exports);
    return module.exports;
  };
  return load(resolve(repoRoot, relativePath));
}

export function observeFacade({ bundle = false } = {}) {
  const calls = [];
  const listeners = new Map();
  const removals = [];
  let response = { marker: 'result' };
  let api;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) {
      if (name !== 'soulforge' || api) throw new Error('Unexpected context bridge exposure');
      api = value;
    } },
    ipcRenderer: {
      async invoke(channel, ...args) { calls.push({ channel, args }); return response; },
      on(channel, listener) {
        const entries = listeners.get(channel) ?? new Set();
        entries.add(listener);
        listeners.set(channel, entries);
      },
      removeListener(channel, listener) {
        removals.push({ channel, listener });
        listeners.get(channel)?.delete(listener);
        return 'transport-removal-result';
      }
    }
  };
  let bundledInputs;
  if (bundle) {
    const result = buildSync({
      entryPoints: [resolve(repoRoot, 'apps/desktop/src/preload/index.ts')],
      absWorkingDir: repoRoot, bundle: true, write: false, platform: 'node', format: 'cjs',
      external: ['electron'], metafile: true, logLevel: 'silent'
    });
    const module = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports){${result.outputFiles[0].text}\n})`, { filename: 'public-preload.bundle.cjs' })(
      (specifier) => specifier === 'electron' ? electron : require(specifier), module, module.exports
    );
    bundledInputs = Object.keys(result.metafile.inputs);
  } else loadSource('apps/desktop/src/preload/index.ts', electron);
  if (!api) throw new Error('The actual preload did not expose a facade');
  return { api, calls, listeners, removals, bundledInputs, setResponse(value) { response = value; } };
}

export const encode = (value) => value === undefined ? { $undefined: true }
  : Array.isArray(value) ? value.map(encode)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
      : value;

export function facadeSignatures(sourceText) {
  const source = ts.createSourceFile('preload.ts', sourceText, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, source);
  const api = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText(source) === 'api')?.initializer;
  return Object.fromEntries(api.properties.map((property) => [property.name.getText(source), {
    parameters: property.initializer.parameters.map(print),
    result: print(property.initializer.type)
  }]));
}

/** Inspect actual registration calls, resolving the current shared channel constants. */
export function registeredChannels() {
  const channels = new Map();
  const shared = loadSource('packages/shared/src/auxiliary-ipc.ts');
  Object.assign(shared,
    loadSource('packages/shared/src/editor-protocol.ts'),
    loadSource('packages/shared/src/param-ipc-protocol.ts'),
    loadSource('packages/shared/src/update-ipc.ts'));
  const visitFile = (relativePath) => {
    const source = ts.createSourceFile(relativePath, readFileSync(resolve(repoRoot, relativePath), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && (
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'handle'
        || ts.isIdentifier(node.expression) && node.expression.text === 'handle'
      )) {
        const channelNode = node.arguments[0];
        let channel;
        if (channelNode && ts.isStringLiteral(channelNode)) channel = channelNode.text;
        else if (channelNode && ts.isPropertyAccessExpression(channelNode) && ts.isIdentifier(channelNode.expression)) {
          channel = shared[channelNode.expression.text]?.[channelNode.name.text];
        }
        if (typeof channel === 'string') channels.set(channel, [...(channels.get(channel) ?? []), relativePath]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  return { channels, visitFile };
}
