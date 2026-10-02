import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Read the renderer's standard local CSS imports in their cascade order. */
export function readOrderedStyleSource(stylesheetPath: string): string {
  return readFileSync(stylesheetPath, 'utf8').replace(
    /^@import "([^"]+)";\r?\n/gm,
    (_statement, importedPath: string) => readOrderedStyleSource(resolve(dirname(stylesheetPath), importedPath))
  );
}
