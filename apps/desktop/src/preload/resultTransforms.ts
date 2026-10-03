import { maskPathFragments } from '@soulforge/shared';

/** Path-bearing fields that must never cross the context bridge to the renderer. */
const RENDERER_FORBIDDEN_PATH_KEYS = new Set([
  'containerPath',
  'rootPath',
  'absolutePath',
  'sourcePath',
  'targetPath',
  'backupPath'
]);

/** Mask absolute filesystem paths that may appear inside diagnostic strings.
 *  S13：与 main 共用 shared 的同一规则 —— 只打码路径片段，保留上下文。 */
function maskAbsolutePathString(value: string): string {
  return maskPathFragments(value);
}

export function stripPathFields<T>(value: T): T {
  if (typeof value === 'string') {
    return maskAbsolutePathString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPathFields(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (RENDERER_FORBIDDEN_PATH_KEYS.has(key)) continue;
      output[key] = stripPathFields(child);
    }
    return output as unknown as T;
  }
  return value;
}
