import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { CoreToolSession } from './coreToolSession.js';

describe('CoreToolSession workspace index rebinding', () => {
  it('releases an older index when the same workspace publishes a refreshed snapshot', () => {
    const session = new CoreToolSession({ principal: 'agent:test', workspaceId: 'workspace-refresh' });
    const previous = session.workspaceIndex;
    const refreshed = new WorkspaceIndex('workspace-refresh');
    const update = (session as CoreToolSession & {
      updateWorkspaceIndex?: (index: WorkspaceIndex) => boolean;
    }).updateWorkspaceIndex;

    assert.equal(update?.call(session, refreshed), true, 'same-workspace refreshes can rebind the long-lived tool session');
    assert.strictEqual(session.workspaceIndex, refreshed, 'the session no longer keeps the superseded index');
    assert.notStrictEqual(session.workspaceIndex, previous);
    session.close();
  });

  it('rejects a replacement index from another workspace', () => {
    const session = new CoreToolSession({ principal: 'agent:test', workspaceId: 'workspace-bound' });
    const previous = session.workspaceIndex;
    const update = (session as CoreToolSession & {
      updateWorkspaceIndex?: (index: WorkspaceIndex) => boolean;
    }).updateWorkspaceIndex;

    assert.equal(update?.call(session, new WorkspaceIndex('workspace-other')), false);
    assert.strictEqual(session.workspaceIndex, previous, 'cross-workspace state must not enter this tool session');
    session.close();
  });
});
