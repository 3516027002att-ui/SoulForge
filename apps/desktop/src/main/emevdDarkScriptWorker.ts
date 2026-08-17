/**
 * DarkScript 反汇编 worker。只消费已经在 main 的 typed document + EMEDF
 * registry，不碰磁盘、不碰 Bridge。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { renderEmevdDarkScript } from '@soulforge/core';
import type { EmevdEditorDocument } from '@soulforge/shared';
import type { EmedfRegistry } from '@soulforge/core';

interface WorkerInput {
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
}

try {
  const input = workerData as WorkerInput;
  const text = renderEmevdDarkScript(input.document, input.registry);
  parentPort?.postMessage({
    ok: true,
    text,
    truncated: false,
    totalLines: text.length === 0 ? 0 : text.split('\n').length
  });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error)
  });
}
