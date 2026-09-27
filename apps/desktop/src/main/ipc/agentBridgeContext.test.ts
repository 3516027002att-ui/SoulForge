import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreToolSession, WorkspaceIndex } from '@soulforge/core';
import type { WorkspaceSession } from '@soulforge/core';
// @ts-ignore Focused runner uses Node's experimental TypeScript stripping.
import { createAgentBridgeBaseContext } from './agentBridgeContext.ts';

test('long-lived Agent bridge base context contains policy only', () => {
  assert.deepEqual(createAgentBridgeBaseContext('normal'), {
    workspaceIndex: null,
    mode: 'normal',
    modeCeiling: 'normal',
    allowMemoryWrite: false
  });
});

test('post-commit callback rebinds CoreToolSession before returning to the Agent loop', async () => {
  // @ts-ignore Focused runner uses experimental TypeScript stripping.
  const { wrapAgentToolContextRefreshCallbacks } = await import('./agentBridgeContext.ts');
  assert.equal(typeof wrapAgentToolContextRefreshCallbacks, 'function');
  const sessionRef = {} as WorkspaceSession;
  const session = new CoreToolSession({
    principal: 'agent:refresh-rebind-test',
    workspaceId: 'refresh-rebind-test',
    workspaceSession: sessionRef
  });
  const refreshedIndex = new WorkspaceIndex('refresh-rebind-test');
  const context = {
    workspaceIndex: session.workspaceIndex,
    mode: 'normal' as const,
    onNativeWriteCommitted: async () => undefined
  };
  const wrapped = wrapAgentToolContextRefreshCallbacks(context, () => {
    session.updateWorkspaceIndex(refreshedIndex, sessionRef);
  });

  await wrapped.onNativeWriteCommitted?.(['file://param/gameparam/gameparam.parambnd.dcx']);

  assert.strictEqual(session.workspaceIndex, refreshedIndex);
  session.close();
});
