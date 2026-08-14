import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldShowEditorWelcome } from './editorWelcome.js';

describe('shouldShowEditorWelcome', () => {
  it('无工作区且无标签时显示', () => {
    assert.equal(shouldShowEditorWelcome({ hasWorkspace: false, openTabCount: 0 }), true);
  });

  it('工作区已打开时即使没有标签也不覆盖编辑区', () => {
    assert.equal(shouldShowEditorWelcome({ hasWorkspace: true, openTabCount: 0 }), false);
    assert.equal(shouldShowEditorWelcome({ hasWorkspace: true, openTabCount: 2 }), false);
  });
});
