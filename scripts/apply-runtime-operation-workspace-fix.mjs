import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../apps/desktop/src/main/runtimeController.ts', import.meta.url);
let text = await readFile(path, 'utf8');
const from = `    return summarizeOperationRuntimeVerification(
      operationId,
      sessions,
      new Map(evidenceEntries)
    );`;
const to = `    return summarizeOperationRuntimeVerification(
      operation.workspaceId,
      operationId,
      sessions,
      new Map(evidenceEntries)
    );`;
const count = text.split(from).length - 1;
if (count !== 1) throw new Error(`expected one controller summary anchor, found ${count}`);
text = text.replace(from, to);
await writeFile(path, text, 'utf8');
