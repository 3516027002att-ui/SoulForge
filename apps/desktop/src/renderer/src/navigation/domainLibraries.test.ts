import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filesForDomain,
  isParamContainerPath,
  libraryDisplayName,
  paramLibraryGroups,
  pickPreferredParamContainer
} from './domainLibraries.js';

describe('domainLibraries', () => {
  it('PARAM 容器不含 GPARAM', () => {
    assert.equal(isParamContainerPath('param/gameparam/gameparam.parambnd.dcx'), true);
    assert.equal(isParamContainerPath('param/drawparam/a.gparam.dcx'), false);
  });

  it('按领域过滤逻辑库，且不把物理全表交给 PARAM', () => {
    const files = [
      { relativePath: 'param/gameparam/gameparam.parambnd.dcx' },
      { relativePath: 'param/drawparam/light.gparam.dcx' },
      { relativePath: 'event/common.emevd' },
      { relativePath: 'msg/zhocn/test.msgbnd.dcx' },
      { relativePath: 'msg/japanese/menu.msgbnd.dcx' },
      { relativePath: 'sfx/f0000.sfxbnd.dcx' }
    ];
    // R1：PARAM 与 GPARAM 都进左侧「参数」逻辑库。
    assert.deepEqual(
      filesForDomain('param', files).map((file) => file.relativePath),
      ['param/gameparam/gameparam.parambnd.dcx', 'param/drawparam/light.gparam.dcx']
    );
    assert.deepEqual(
      filesForDomain('event', files).map((file) => file.relativePath),
      ['event/common.emevd']
    );
    // R2：文本域只列简中（zhocn），japanese 不得出现。
    assert.deepEqual(
      filesForDomain('text', files).map((file) => file.relativePath),
      ['msg/zhocn/test.msgbnd.dcx']
    );
    assert.deepEqual(filesForDomain('files', files), []);
    assert.deepEqual(filesForDomain('project', files), []);
  });

  it('优先选择 GameParam 容器', () => {
    const files = [
      { relativePath: 'param/other.parambnd.dcx' },
      { relativePath: 'param/gameparam/gameparam.parambnd.dcx' }
    ];
    assert.equal(
      pickPreferredParamContainer(files)?.relativePath,
      'param/gameparam/gameparam.parambnd.dcx'
    );
  });

  it('显示名去掉复合扩展', () => {
    assert.equal(libraryDisplayName('param/gameparam/gameparam.parambnd.dcx'), 'gameparam');
    assert.equal(libraryDisplayName('event/common.emevd'), 'common');
    assert.equal(libraryDisplayName('chr/c5030/c5030.anibnd.dcx'), 'c5030');
    assert.equal(libraryDisplayName('action/c5030.tae'), 'c5030');
  });

  it('T3：动作域（behavior）侧栏列 anibnd|tae，esd/behbnd/chrbnd 不进动作', () => {
    const files = [
      { relativePath: 'chr/c5030/c5030.anibnd.dcx' },
      { relativePath: 'action/c5030.tae' },
      { relativePath: 'chr/c5030/c5030.chrbnd.dcx' },
      { relativePath: 'ai/m10.esd' },
      { relativePath: 'chr/c5030/c5030.behbnd.dcx' },
      { relativePath: 'event/common.emevd' },
      { relativePath: 'other/generic.bnd.dcx' }
    ];
    assert.deepEqual(
      filesForDomain('behavior', files).map((file) => file.relativePath),
      ['chr/c5030/c5030.anibnd.dcx', 'action/c5030.tae'],
      '动作侧栏只列 anibnd 与 tae'
    );
    assert.deepEqual(
      filesForDomain('animation', files).map((file) => file.relativePath),
      ['chr/c5030/c5030.anibnd.dcx', 'action/c5030.tae'],
      '隐藏的 animation 域保留同口径（可路由）'
    );
    // anibnd/chrbnd 都是复合后缀（\.chrbnd/\.anibnd 不匹配字面 \.bnd），
    // 不进通用容器域侧栏；字面 .bnd 仍进容器域。
    assert.deepEqual(
      filesForDomain('container', files).map((file) => file.relativePath),
      ['other/generic.bnd.dcx'],
      'anibnd 不进容器域（T3 走动作）；chrbnd 也不进（保持现状）'
    );
  });

  it('参数域分组：PARAM 与 GPARAM 两个常驻组，GPARAM 默认折叠且带 bank 数', () => {
    const files = [
      { relativePath: 'param/gameparam/gameparam.parambnd.dcx' },
      { relativePath: 'param/drawparam/m10_00_0001.gparam.dcx' },
      { relativePath: 'param/drawparam/m10_00_0002.gparam.dcx' },
      { relativePath: 'event/common.emevd' }
    ];
    const groups = paramLibraryGroups(files);
    assert.equal(groups.length, 2, '参数域必须是 PARAM / GPARAM 两个组');
    assert.equal(groups[0]!.id, 'param');
    assert.deepEqual(
      groups[0]!.files.map((file) => file.relativePath),
      ['param/gameparam/gameparam.parambnd.dcx'],
      'PARAM 组只收 parambnd 容器'
    );
    assert.equal(groups[1]!.id, 'gparam');
    assert.equal(groups[1]!.defaultCollapsed, true, 'GPARAM 组必须默认折叠（点开才出现 bank 子选项）');
    assert.equal(groups[1]!.hint, '2 banks');
    assert.deepEqual(
      groups[1]!.files.map((file) => file.relativePath),
      ['param/drawparam/m10_00_0001.gparam.dcx', 'param/drawparam/m10_00_0002.gparam.dcx']
    );
  });

  it('参数域分组：无 gparam 时 GPARAM 组仍常驻但为空', () => {
    const groups = paramLibraryGroups([
      { relativePath: 'param/gameparam/gameparam.parambnd.dcx' }
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[1]!.files.length, 0);
    assert.equal(groups[1]!.hint, undefined);
  });
});
