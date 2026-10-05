/** Bind workspace packages to this checkout's compiled output, never symlinked package output. */
import { registerHooks } from 'node:module';
const owned = new URL('../packages/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@soulforge\/(shared|core)(?:\/dist\/(.*))?$/u.exec(specifier);
    if (match) return { url: new URL(`${match[1]}/dist/${match[2] ?? 'index.js'}`, owned).href, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
