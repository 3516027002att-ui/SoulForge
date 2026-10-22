import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { RagLocalModelStatus, UpdateCommandResult, UpdatePublicState } from '@soulforge/shared';
import { useRuntimeSettingsController, type RuntimeSettingsController, type RuntimeSettingsOptions } from './useRuntimeSettingsController.js';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => { while (mounted.length) { const renderer = mounted.pop()!; await act(async () => renderer.unmount()); } });

const idle: UpdatePublicState = { status: 'idle', currentVersion: 'test', channel: 'prerelease' };
const ready: RagLocalModelStatus = { state: 'local-ready', modelId: 'owned', revision: 'r1', dimension: 4 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ports() {
  const update = deferred<UpdatePublicState>(), rag = deferred<RagLocalModelStatus>();
  let listener: ((state: UpdatePublicState) => void) | null = null;
  let unsubscribed = 0;
  const statuses: string[] = [], toasts: Array<[string, string]> = [], desktop: string[] = [];
  const command = async (): Promise<UpdateCommandResult> => ({ ok: true, state: idle });
  const options: RuntimeSettingsOptions = {
    bridge: { getUpdateState: () => update.promise, onUpdateState: callback => { listener = callback; return () => { unsubscribed++; }; },
      getRagLocalModelStatus: () => rag.promise, checkForUpdate: command, downloadUpdate: command,
      cancelUpdate: command, installUpdate: command, setUpdateChannel: command },
    setStatus: value => statuses.push(value), pushToast: (text, kind) => toasts.push([text, kind]),
    announceDesktopOnly: operation => desktop.push(operation)
  };
  return { options, update, rag, statuses, toasts, desktop, unsubscribed: () => unsubscribed,
    publish: (state: UpdatePublicState) => { assert(listener); listener(state); } };
}
async function mount(options: RuntimeSettingsOptions) {
  let current!: RuntimeSettingsController;
  function Host({ options }: { options: RuntimeSettingsOptions }) {
    current = useRuntimeSettingsController(options);
    return <span>{current.updateState.status}</span>;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Host options={options} />); });
  mounted.push(renderer);
  return { current: () => current,
    update: async (options: RuntimeSettingsOptions) => act(async () => renderer.update(<Host options={options} />)),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}

it('the mounted domain consumes update/RAG results and ignores both late results after a bridge switch', async () => {
  const first = ports(), second = ports(); const h = await mount(first.options);
  assert.equal(h.current().updateState.status, 'idle'); assert.equal(h.current().ragModelStatus, null);
  await h.update(second.options); assert.equal(first.unsubscribed(), 1);
  await act(async () => { first.update.resolve({ ...idle, status: 'checking' }); first.rag.resolve(ready); });
  assert.equal(h.current().updateState.status, 'idle'); assert.equal(h.current().ragModelStatus, null);
  await act(async () => { second.update.resolve({ ...idle, status: 'up-to-date' }); second.rag.resolve(ready); });
  assert.equal(h.current().updateState.status, 'up-to-date'); assert.deepEqual(h.current().ragModelStatus, ready);
  await h.unmount(); assert.equal(second.unsubscribed(), 1);
  await act(async () => second.publish({ ...idle, status: 'checking' }));
  assert.equal(h.current().updateState.status, 'up-to-date');
});

it('unmount and replaced-bridge read failures cannot publish stale update errors or RAG state', async () => {
  const first = ports(), second = ports(); const h = await mount(first.options);
  await h.update(second.options);
  await act(async () => { first.update.reject(new Error('old read')); first.rag.reject(new Error('old rag')); });
  assert.deepEqual(first.statuses, []);
  await h.unmount();
  await act(async () => { second.update.reject(new Error('disposed read')); second.rag.resolve(ready); });
  assert.deepEqual(second.statuses, []); assert.equal(h.current().ragModelStatus, null);
});

it('one in-flight update command blocks duplicates and releases its ref after completion', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<UpdateCommandResult>(); let calls = 0;
  const command = () => { calls++; return pending.promise; }; let saving!: Promise<void>;
  await act(async () => { saving = h.current().runUpdateCommand(command); await h.current().runUpdateCommand(command); });
  assert.equal(calls, 1); assert.equal(h.current().updateActionBusy, true);
  await act(async () => { pending.resolve({ ok: true, state: { ...idle, status: 'up-to-date' } }); await saving; });
  assert.equal(h.current().updateActionBusy, false); assert.equal(h.current().updateState.status, 'up-to-date');
  await act(async () => h.current().runUpdateCommand(async () => { calls++; return { ok: true, state: idle }; }));
  assert.equal(calls, 2);
});

it('command rejection preserves the existing warning and releases the in-flight guard', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().runUpdateCommand(async () => { throw new Error('owned failure'); }));
  assert.deepEqual(p.statuses, ['owned failure']); assert.deepEqual(p.toasts, [['owned failure','warn']]);
  assert.equal(h.current().updateActionBusy, false);
});

it('a replaced-bridge command cannot overwrite current state or feedback, and keeps the in-flight guard until settlement', async () => {
  const first = ports(), second = ports(), h = await mount(first.options);
  const pending = deferred<UpdateCommandResult>(); let calls = 0, saving!: Promise<void>;
  await act(async () => { saving = h.current().runUpdateCommand(() => { calls++; return pending.promise; }, 'old success'); });
  await h.update(second.options);
  await act(async () => { second.update.resolve({ ...idle, status: 'up-to-date' }); });
  await act(async () => h.current().runUpdateCommand(async () => { calls++; return { ok: true, state: idle }; }));
  assert.equal(calls, 1, 'Bridge replacement must not duplicate an in-flight update');
  await act(async () => { pending.resolve({ ok: true, state: { ...idle, status: 'checking' } }); await saving; });
  assert.equal(h.current().updateState.status, 'up-to-date');
  assert.equal(h.current().updateActionBusy, false);
  assert.deepEqual(first.statuses, []); assert.deepEqual(second.statuses, []);
  await act(async () => h.current().runUpdateCommand(async () => { calls++; return { ok: true, state: idle }; }));
  assert.equal(calls, 2);
});

it('returning to the same bridge does not revive an earlier command generation', async () => {
  const first = ports(), second = ports(), h = await mount(first.options);
  await act(async () => first.update.resolve({ ...idle, status: 'up-to-date' }));
  const pending = deferred<UpdateCommandResult>(); let saving!: Promise<void>;
  await act(async () => { saving = h.current().runUpdateCommand(() => pending.promise, 'old generation'); });
  await h.update(second.options); await h.update(first.options);
  await act(async () => { pending.resolve({ ok: true, state: { ...idle, status: 'checking' } }); await saving; });
  assert.equal(h.current().updateState.status, 'up-to-date');
  assert.deepEqual(first.statuses, []);
});

it('unmounted command rejection cannot publish a toast or status after disposal', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<UpdateCommandResult>(); let saving!: Promise<void>;
  await act(async () => { saving = h.current().runUpdateCommand(() => pending.promise); });
  await h.unmount();
  await act(async () => { pending.reject(new Error('late command failure')); await saving; });
  assert.deepEqual(p.statuses, []); assert.deepEqual(p.toasts, []);
});

it('channel changes submit exactly the selected existing channel and keep success feedback', async () => {
  const p = ports(); const channels: string[] = [];
  p.options.bridge!.setUpdateChannel = async request => { channels.push(request.channel); return { ok: true, state: { ...idle, channel: request.channel } }; };
  const h = await mount(p.options); await act(async () => h.current().changeUpdateChannel('stable'));
  assert.deepEqual(channels, ['stable']); assert.equal(h.current().updateState.channel, 'stable');
  assert.deepEqual(p.statuses, ['已切换到稳定频道']);
});

it('the browser surface never runs update commands and leaves local RAG unavailable', async () => {
  const p = ports(); p.options.bridge = null; const h = await mount(p.options); let calls = 0;
  await act(async () => h.current().runUpdateCommand(async () => { calls++; return { ok: true, state: idle }; }));
  h.current().changeUpdateChannel('stable');
  assert.equal(calls, 0); assert.deepEqual(p.desktop, ['检查 SoulForge 更新','切换更新频道']);
  assert.equal(h.current().ragModelStatus, null); assert.equal(h.current().currentUpdateAction.run, null);
});
