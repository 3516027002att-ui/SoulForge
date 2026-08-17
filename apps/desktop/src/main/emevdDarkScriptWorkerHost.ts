/**
 * 在 worker_threads 里跑 DarkScript 反汇编，避免 7 万行拼装堵住 Electron 主线程。
 * 取消 = terminate worker，半成品不回 UI。worker 找不到时退回 core 异步入口。
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderEmevdDarkScriptAsync as renderEmevdDarkScriptAsyncInProcess,
  type EmedfRegistry,
  type RenderEmevdDarkScriptAsyncResult
} from '@soulforge/core';
import type { EmevdEditorDocument } from '@soulforge/shared';

export type DarkScriptAsyncFn = (
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  options?: { signal?: AbortSignal }
) => Promise<RenderEmevdDarkScriptAsyncResult>;

function cancelledRender(): RenderEmevdDarkScriptAsyncResult {
  return { text: '', truncated: false, totalLines: 0, shownLines: 0, cancelled: true };
}

function workerFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'emevdDarkScriptWorker.js');
}

export const renderEmevdDarkScriptAsync: DarkScriptAsyncFn = async (
  document,
  registry,
  options
) => {
  const signal = options?.signal;
  if (signal?.aborted) return cancelledRender();

  const script = workerFilePath();
  if (!existsSync(script)) {
    return renderEmevdDarkScriptAsyncInProcess(document, registry, signal ? { signal } : {});
  }

  return new Promise<RenderEmevdDarkScriptAsyncResult>((resolve) => {
    let settled = false;
    const worker = new Worker(script, {
      workerData: { document, registry }
    });

    const finish = (result: RenderEmevdDarkScriptAsyncResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      resolve(result);
    };

    const onAbort = (): void => {
      finish(cancelledRender());
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message: {
      ok?: boolean;
      text?: string;
      truncated?: boolean;
      totalLines?: number;
      message?: string;
    }) => {
      if (signal?.aborted) {
        finish(cancelledRender());
        return;
      }
      if (!message?.ok || typeof message.text !== 'string') {
        void renderEmevdDarkScriptAsyncInProcess(document, registry, signal ? { signal } : {})
          .then(finish)
          .catch(() => finish(cancelledRender()));
        return;
      }
      const totalLines = message.totalLines ?? (message.text.split('\n').length);
      finish({
        text: message.text,
        truncated: message.truncated === true,
        totalLines,
        shownLines: totalLines,
        cancelled: false
      });
    });

    worker.once('error', () => {
      if (signal?.aborted) {
        finish(cancelledRender());
        return;
      }
      void renderEmevdDarkScriptAsyncInProcess(document, registry, signal ? { signal } : {})
        .then(finish)
        .catch(() => finish(cancelledRender()));
    });
  });
};
