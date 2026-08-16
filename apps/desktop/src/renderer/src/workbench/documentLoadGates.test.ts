import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyWorkspaceOpen } from '@soulforge/shared';
import {
  planResourceOpen,
  shouldLoadEmevd,
  shouldLoadEsd,
  shouldLoadFmg,
  shouldLoadFxr,
  shouldLoadMsb,
  shouldLoadParam,
  shouldLoadTae,
  shouldLoadTpf
} from './documentLoadGates.js';

function file(relativePath: string, resourceKind = 'other', formatKind = 'unknown', compoundExtension = '') {
  return {
    relativePath,
    resourceKind,
    formatKind,
    compoundExtension: compoundExtension || relativePath.slice(relativePath.indexOf('.'))
  };
}

describe('documentLoadGates', () => {
  it('FMG 按后缀加载，不看目录名', () => {
    const inMsg = file('msg/zhocn/item.msgbnd.dcx', 'other', 'fmg', '.msgbnd.dcx');
    const inOther = file('other/item.msgbnd.dcx', 'other', 'fmg', '.msgbnd.dcx');
    assert.equal(shouldLoadFmg(inMsg), true);
    assert.equal(shouldLoadFmg(inOther), true);
    assert.equal(planResourceOpen(inOther).editorId, 'text');
    assert.ok(planResourceOpen(inOther).ipcMethods.includes('readFmgDocument'));
  });

  it('EMEVD / MSB 按后缀加载', () => {
    assert.equal(shouldLoadEmevd(file('event/common.emevd.dcx', 'chr', 'emevd', '.emevd.dcx')), true);
    assert.equal(shouldLoadMsb(file('map/mapstudio/m10.msb.dcx', 'other', 'msb', '.msb.dcx')), true);
    assert.equal(shouldLoadParam(file('param/gameparam/gameparam.parambnd.dcx', 'param', 'param', '.parambnd.dcx')), false);
  });

  it('talkesdbnd 走 ESD 读链，texbnd 走 TPF，ffxbnd 走 FXR', () => {
    const talk = file('script/talk/m11_02_00_00.talkesdbnd.dcx', 'script', 'lua', '.talkesdbnd.dcx');
    const tex = file('chr/c4510.texbnd.dcx', 'chr', 'tpf', '.texbnd.dcx');
    const fx = file('sfx/sfxbnd_commoneffects.ffxbnd.dcx', 'sfx', 'bnd', '.ffxbnd.dcx');
    assert.equal(shouldLoadEsd(talk), true);
    assert.equal(planResourceOpen(talk).editorId, 'esd');
    assert.equal(shouldLoadTpf(tex), true);
    assert.equal(planResourceOpen(tex).editorId, 'tpf');
    assert.equal(shouldLoadFxr(fx), true);
    assert.equal(planResourceOpen(fx).editorId, 'vfx');
    assert.equal(shouldLoadTae(file('chr/c0000.anibnd.dcx', 'chr', 'bnd', '.anibnd.dcx')), true);
  });

  it('gfx / behbnd / bak 不是语义打开', () => {
    assert.equal(classifyWorkspaceOpen('menu/05_000_title.gfx').openKind, 'blocked-no-parser');
    assert.equal(classifyWorkspaceOpen('chr/c4510.behbnd.dcx').openKind, 'blocked-scope');
    assert.equal(classifyWorkspaceOpen('event/common.emevd.dcx.bak').openKind, 'history');
    assert.equal(planResourceOpen(file('menu/05_000_title.gfx', 'menu', 'gfx', '.gfx')).editorId, 'binary');
  });
});
