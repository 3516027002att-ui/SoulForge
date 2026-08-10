/**
 * 编辑器选择器单测。
 *
 * 核心判据是「同一份输入只产出一个编辑器」—— 那正是此前缺失的约束：
 * 主视图区曾有 15 个互不排斥的条件块，打开 parambnd 会同时命中三四个，
 * 实测表现为 param 工作台与 BND4 容器工作台两张条目表叠在一起。
 * 那种缺陷在 JSX 里无法断言（条件散在 900 行），所以把选择逻辑提成纯函数。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectEditor, type EditorId, type SelectEditorInput } from './selectEditor.js';

/** 造一份最小输入。 */
function input(overrides: Partial<SelectEditorInput> = {}): SelectEditorInput {
  return {
    centerView: 'resource',
    resourceMode: 'all',
    selectedFile: null,
    ...overrides
  };
}

function file(
  relativePath: string,
  resourceKind: string,
  formatKind = 'dcx',
  compoundExtension = ''
): NonNullable<SelectEditorInput['selectedFile']> {
  return {
    relativePath,
    resourceKind,
    formatKind,
    compoundExtension: compoundExtension || relativePath.slice(relativePath.indexOf('.'))
  };
}

describe('selectEditor', () => {
  it('未选择资源时是空态，不落进任何编辑器', () => {
    assert.equal(selectEditor(input()), 'empty');
  });

  /*
   * 非资源视图必须短路。
   *
   * 第一版把 centerView 的类型写成 resource|operations，漏了 settings ——
   * typecheck 当场指出。若当时在调用处强转类型，settings 视图会落进 'empty'
   * 分支，于是设置页面里出现「在左侧选择一个资源开始编辑」。
   */
  it('任务与历史 / 设置视图优先于资源判定', () => {
    const paramFile = file('param/gameparam/gameparam.parambnd.dcx', 'param');
    assert.equal(
      selectEditor(input({ centerView: 'operations', selectedFile: paramFile })),
      'operations'
    );
    assert.equal(
      selectEditor(input({ centerView: 'settings', selectedFile: paramFile })),
      'settings'
    );
  });

  /*
   * 用户实测截图里的确切资源：parambnd 容器同时渲染出 param 工作台与
   * BND4 容器工作台。这条钉住「只给 param-container」。
   */
  it('parambnd 容器只给 param 容器编辑器，不同时给通用容器视图', () => {
    const editor = selectEditor(input({
      resourceMode: 'param',
      selectedFile: file('param/gameparam/gameparam.parambnd.dcx', 'param')
    }));
    assert.equal(editor, 'param-container');
    assert.notEqual(editor, 'container', '不得同时落进通用 BND4 容器视图');
  });

  it('.bak 备份的 parambnd 仍是 param 容器（formatLabel 是 Backup File 但它是容器）', () => {
    assert.equal(
      selectEditor(input({
        resourceMode: 'param',
        selectedFile: file('param/gameparam/gameparam.parambnd.dcx.bak', 'param', 'backup')
      })),
      'param-container'
    );
  });

  it('裸 param 文件走行表编辑器而不是容器编辑器', () => {
    assert.equal(
      selectEditor(input({
        resourceMode: 'param',
        selectedFile: file('param/gameparam/AtkParam_Npc.param', 'param', 'param', '.param')
      })),
      'param-rows'
    );
  });

  it('命令面板强制以 BND4 打开时优先于格式推断（用户显式选择）', () => {
    assert.equal(
      selectEditor(input({
        resourceMode: 'param',
        selectedFile: file('param/gameparam/gameparam.parambnd.dcx', 'param'),
        bnd4Forced: true
      })),
      'container'
    );
  });

  it('按资源目录分派 text / map / event / script', () => {
    const cases: Array<[string, string, EditorId]> = [
      ['msg/test.msgbnd.dcx', 'msg', 'text'],
      ['menu/menu.msgbnd.dcx', 'menu', 'text'],
      ['map/m10_00_00_00.msb.dcx', 'map', 'map'],
      ['event/common.emevd.dcx', 'event', 'event'],
      ['script/luabnd.dcx', 'script', 'script']
    ];
    for (const [path, kind, expected] of cases) {
      assert.equal(
        selectEditor(input({ resourceMode: kind, selectedFile: file(path, kind) })),
        expected,
        `${path} 应落进 ${expected}`
      );
    }
  });

  it('按扩展名分派 tae / esd / flver / tpf', () => {
    const cases: Array<[string, EditorId]> = [
      ['chr/c1000.tae', 'tae'],
      ['script/talk/t100000.esd', 'esd'],
      ['chr/c1000.flver', 'flver'],
      ['chr/c1000.tpf', 'tpf']
    ];
    for (const [path, expected] of cases) {
      assert.equal(
        selectEditor(input({ selectedFile: file(path, 'chr', 'other', path.slice(path.lastIndexOf('.'))) })),
        expected,
        `${path} 应落进 ${expected}`
      );
    }
  });

  it('无专属编辑器的容器落进通用容器视图', () => {
    assert.equal(
      selectEditor(input({
        resourceMode: 'sfx',
        selectedFile: file('sfx/f0000.sfxbnd.dcx', 'sfx')
      })),
      'container'
    );
  });

  it('可编辑纯文本落进文本编辑器；不可编辑的文本落进原始字节', () => {
    const textFile = file('other/readme.txt', 'other', 'text', '.txt');
    assert.equal(
      selectEditor(input({ selectedFile: textFile, previewKind: 'text', textEditable: true })),
      'plain-text'
    );
    assert.equal(
      selectEditor(input({ selectedFile: textFile, previewKind: 'text', textEditable: false })),
      'binary',
      '不可编辑的文本没有语义编辑器，应落进原始字节而不是假装可编辑'
    );
  });

  /*
   * 读取失败不是一种编辑器。
   *
   * 此前主区对 failed/empty 各印一句「预览失败。」「空文件。」，那既不说明
   * 问题也不给出动作。失败原因归底部日志区，主区仍给原始字节视图 ——
   * 用户至少能看到字节，而不是一句空话。
   */
  it('previewKind 为 failed / empty / hex 时都落进原始字节，不各自占一个分支', () => {
    const binaryFile = file('other/unknown.bin', 'other', 'other', '.bin');
    for (const previewKind of ['failed', 'empty', 'hex', undefined]) {
      assert.equal(
        selectEditor(input({ selectedFile: binaryFile, previewKind })),
        'binary',
        `previewKind=${String(previewKind)} 应落进 binary`
      );
    }
  });

  /**
   * 全序性：穷举一批输入，断言每次都拿到**恰好一个**非空结果。
   *
   * 这条是本文件的核心。它不检查具体映射（上面各条已覆盖），而是检查
   * 「不会漏、不会重」——漏了会返回 undefined，重了在纯函数里不可能发生，
   * 而正是「重」在旧 JSX 装配里天天发生。把选择收敛成函数即消除该类缺陷，
   * 本条钉住这个性质不被回退（例如有人把返回类型改成数组）。
   */
  it('任何输入都恰好产出一个编辑器 id', () => {
    const files = [
      null,
      file('param/gameparam/gameparam.parambnd.dcx', 'param'),
      file('param/gameparam/gameparam.parambnd.dcx.bak', 'param', 'backup'),
      file('param/gameparam/AtkParam_Npc.param', 'param', 'param', '.param'),
      file('msg/test.msgbnd.dcx', 'msg'),
      file('map/m10.msb.dcx', 'map'),
      file('event/common.emevd.dcx', 'event'),
      file('script/luabnd.dcx', 'script'),
      file('sfx/f0000.sfxbnd.dcx', 'sfx'),
      file('chr/c1000.tae', 'chr', 'other', '.tae'),
      file('other/x.bin', 'other', 'other', '.bin')
    ];
    const previews = [undefined, 'text', 'hex', 'empty', 'failed'];
    const known = new Set<EditorId>([
      'param-container', 'param-rows', 'text', 'map', 'event', 'script', 'container',
      'tae', 'esd', 'flver', 'tpf', 'plain-text', 'binary', 'operations', 'settings', 'empty'
    ]);

    let checked = 0;
    for (const selectedFile of files) {
      for (const previewKind of previews) {
        for (const textEditable of [true, false]) {
          for (const bnd4Forced of [true, false]) {
            // 三种 centerView 全覆盖：漏掉 settings 正是第一版的缺陷。
            for (const centerView of ['resource', 'operations', 'settings'] as const) {
              const editor = selectEditor(input({
                centerView, selectedFile, previewKind, textEditable, bnd4Forced
              }));
              assert.ok(
                typeof editor === 'string' && known.has(editor),
                `未产出已知编辑器 id：${String(editor)}`
              );
              checked += 1;
            }
          }
        }
      }
    }
    // 空集合必须失败关闭：若循环因某次重构变成零次，上面的断言全部恒真。
    assert.ok(checked > 400, `穷举样本过少（${checked}），判据可能已失效`);
  });
});
