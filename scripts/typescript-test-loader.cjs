// Test-only bounded CommonJS execution of desktop TypeScript. Electron remains a
// stubbed process adapter; the loaded utility/client/protocol source is unchanged.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
module.exports = function createLoader(overrides = {}) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded = new Module(filename); loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, loaded);
    loaded.require = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith('.')) {
        const candidate = path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'));
        if (fs.existsSync(candidate)) return load(candidate);
      }
      return Module.createRequire(filename)(name);
    };
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    });
    loaded._compile(result.outputText, filename);
    return loaded.exports;
  }
  return load;
};
