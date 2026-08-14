/**
 * 编辑器选择器单测（ROUTE-06：唯一 WorkbenchRoute）。
 *
 * 核心判据是「同一份输入只产出一个编辑器/route」—— 那正是此前缺失的约束：
 * 主视图区曾有 15 个互不排斥的条件块，打开 parambnd 会同时命中三四个，
 * 实测表现为 param 工作台与 BND4 容器工作台两张条目表叠在一起。
 * 那种缺陷在 JSX 里无法断言（条件散在 900 行），所以把选择逻辑提成纯函数。
 *
 * ROUTE-06 之后路由顺序是 §5.1：
 *   0. artifact-role prefilter（backup/previous/recovery → history；
 *      projection/cache/audit/temporary → hidden 无 route）
 *   1. explicit Open With（仅 primary/base）
 *   2. Bridge-confirmed leaf → read capability → candidate → Files
 *
 * 旧的「按资源目录分派」「.bak 仍是 param」正向断言已删除，替换为反向测试：
 * .bak → History-only、GParam 非 Param、TPF 非 Text、candidate 非 ready、
 * hidden 无 route。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  selectEditor,
  selectWorkbenchRoute,
  type EditorId,
  type SelectEditorInput
} from './selectEditor.js';
import type { LogicalDocumentRef, WorkbenchRoute } from '@soulforge/shared';

type SemanticFile = NonNullable<SelectEditorInput['selectedFile']>;

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

function documentRef(overrides: Partial<LogicalDocumentRef> = {}): LogicalDocumentRef {
  return {
    resourceId: 'res-doc',
    domain: 'param',
    libraryId: 'game-parameters',
    bankId: null,
    documentId: 'doc-1',
    sourceVariant: 'overlay',
    ...overrides
  };
}

/** 语义投影文件：存在任一语义字段即走 §5.1 严格路由。 */
function semanticFile(overrides: Partial<SemanticFile> = {}): SemanticFile {
  return {
    relativePath: 'param/gameparam/GameParam.parambnd.dcx',
    resourceKind: 'param',
    formatKind: 'param',
    compoundExtension: '.parambnd.dcx',
    artifactRole: 'primary' as const,
    recognizedLeafFormatId: 'bnd4' as const,
    containerRole: 'gameparam-binder' as const,
    semanticSubtype: 'gameparam-primary',
    readReady: true,
    document: documentRef(),
    ...overrides
  };
}

/**
 * 去掉全部格式确认语义字段（保留 artifactRole），得到「suffix-only candidate」。
 *
 * exactOptionalPropertyTypes 下不能写 `{ key: undefined }` 覆盖可选键，
 * 这里用解构剔除，返回不含这些键的语义文件。
 */
function candidateFile(base: SemanticFile = semanticFile()): SemanticFile {
  const { recognizedLeafFormatId, containerRole, semanticSubtype, readReady, ...rest } = base;
  return rest;
}

describe('selectEditor', () => {
  it('未选择资源时是空态，不落进任何编辑器', () => {
    assert.equal(selectEditor(input()), 'empty');
    assert.equal(selectWorkbenchRoute(input()).kind, 'unsupported');
  });

  /*
   * 非资源视图必须短路。
   *
   * 第一版把 centerView 的类型写成 resource|operations，漏了 settings ——
   * typecheck 当场指出。若当时在调用处强转类型，settings 视图会落进 'empty'
   * 分支，于是设置页面里出现「在左侧选择一个资源开始编辑」。
   */
  it('任务与历史 / 设置视图优先于资源判定', () => {
    const paramFile = semanticFile({ relativePath: 'param/gameparam/GameParam.parambnd.dcx' });
    assert.equal(
      selectEditor(input({ centerView: 'operations', selectedFile: paramFile })),
      'operations'
    );
    assert.equal(
      selectEditor(input({ centerView: 'settings', selectedFile: paramFile })),
      'settings'
    );
  });

  // ── §5.1 第 0 级：artifact-role prefilter ──

  it('.bak 备份 → History-only，绝不得到 Param 编辑器（反向：旧「.bak 仍是 param」）', () => {
    const backup = semanticFile({
      relativePath: 'param/gameparam/GameParam.parambnd.dcx.bak',
      artifactRole: 'backup',
      recoveryOfResourceId: 'res-gameparam'
    });
    const route = selectWorkbenchRoute(input({ selectedFile: backup }));
    assert.deepEqual(route, { kind: 'history', recoveryOfResourceId: 'res-gameparam' });
    assert.equal(selectEditor(input({ selectedFile: backup })), 'empty');
    assert.notEqual(selectEditor(input({ selectedFile: backup })), 'param-container');

    // legacy 输入（未接 catalog）：formatKind 'backup' 也不进 Param。
    const legacyBackup = file('param/gameparam/GameParam.parambnd.dcx.bak', 'param', 'backup');
    assert.equal(selectEditor(input({ selectedFile: legacyBackup })), 'binary');
  });

  it('previous / recovery 同样 History-only', () => {
    for (const role of ['previous', 'recovery'] as const) {
      const route = selectWorkbenchRoute(input({
        selectedFile: semanticFile({ artifactRole: role, recoveryOfResourceId: 'res-x' })
      }));
      assert.equal(route.kind, 'history');
    }
  });

  it('cache / audit / temporary → hidden，无 route', () => {
    for (const role of ['cache', 'audit', 'temporary'] as const) {
      const route = selectWorkbenchRoute(input({
        selectedFile: semanticFile({ artifactRole: role })
      }));
      assert.equal(route.kind, 'unsupported', `${role} 应无 route`);
      if (route.kind === 'unsupported') assert.equal(route.reasonCode, 'hidden-artifact');
      assert.equal(selectEditor(input({ selectedFile: semanticFile({ artifactRole: role }) })), 'empty');
    }
  });

  it('projection 是隐藏的生成物，无普通编辑器 route', () => {
    const route = selectWorkbenchRoute(input({
      selectedFile: semanticFile({ artifactRole: 'projection' })
    }));
    assert.equal(route.kind, 'unsupported');
    assert.equal(selectEditor(input({ selectedFile: semanticFile({ artifactRole: 'projection' }) })), 'empty');
  });

  // ── §5.1 第 1 级：explicit Open With（仅 primary/base）──

  it('命令面板强制以 BND4 打开：primary 允许，backup 被 prefilter 拦下', () => {
    const primary = semanticFile();
    assert.deepEqual(
      selectWorkbenchRoute(input({ selectedFile: primary, bnd4Forced: true })),
      { kind: 'ready', editorId: 'container', document: primary.document, readOnly: false }
    );
    assert.equal(selectEditor(input({ selectedFile: primary, bnd4Forced: true })), 'container');

    const backup = semanticFile({ artifactRole: 'backup', recoveryOfResourceId: 'res-gameparam' });
    assert.equal(
      selectWorkbenchRoute(input({ selectedFile: backup, bnd4Forced: true })).kind,
      'history',
      'backup 即使强制 Open With 也只得 history'
    );

    // legacy 输入：命令面板强制仍以容器打开（App.tsx 现状）。
    assert.equal(
      selectEditor(input({
        selectedFile: file('param/gameparam/GameParam.parambnd.dcx', 'param', 'param'),
        bnd4Forced: true
      })),
      'container'
    );
  });

  // ── §5.1 第 2 级：Bridge-confirmed leaf ──

  it('confirmed leaf → 对应编辑器 ready（parambnd → param-container）', () => {
    const primary = semanticFile();
    const route = selectWorkbenchRoute(input({ selectedFile: primary }));
    assert.equal(route.kind, 'ready');
    if (route.kind === 'ready') {
      assert.equal(route.editorId, 'param-container');
      assert.deepEqual(route.document, primary.document);
    }
    assert.equal(selectEditor(input({ selectedFile: primary })), 'param-container');
  });

  it('confirmed 裸 param / gparam / fmg / emevd / msb / bnd4 各归其位', () => {
    const cases: Array<[Partial<SemanticFile>, string]> = [
      [{ relativePath: 'param/drawparam/x.param', recognizedLeafFormatId: 'param', containerRole: 'none', semanticSubtype: 'loose-table', document: documentRef({ resourceId: 'res-param' }) }, 'param-rows'],
      [{ relativePath: 'param/drawparam/m00_00.gparam.dcx', recognizedLeafFormatId: 'gparam', containerRole: 'none', semanticSubtype: 'map-bank', document: documentRef({ resourceId: 'res-gparam' }) }, 'gparam'],
      // 无 semanticSubtype 的 confirmed leaf：规则不要求 subtype 时宽容匹配。
      [{ relativePath: 'msg/other.msgbnd.dcx', recognizedLeafFormatId: 'bnd4', containerRole: 'msg-binder', document: documentRef({ resourceId: 'res-msg' }) }, 'text'],
      [{ relativePath: 'msg/x.fmg', recognizedLeafFormatId: 'fmg', containerRole: 'none', semanticSubtype: 'loose-table', document: documentRef({ resourceId: 'res-fmg' }) }, 'text'],
      [{ relativePath: 'event/common.emevd.dcx', recognizedLeafFormatId: 'emevd', containerRole: 'none', document: documentRef({ resourceId: 'res-evt' }) }, 'event'],
      [{ relativePath: 'map/m10.msb.dcx', recognizedLeafFormatId: 'msb', containerRole: 'none', document: documentRef({ resourceId: 'res-msb' }) }, 'map'],
      [{ relativePath: 'sfx/x.sfxbnd.dcx', recognizedLeafFormatId: 'bnd4', containerRole: 'generic-binder', document: documentRef({ resourceId: 'res-bnd' }) }, 'container']
    ];
    for (const [overrides, expected] of cases) {
      const semantic = semanticFile(overrides);
      const route = selectWorkbenchRoute(input({ selectedFile: semantic }));
      assert.equal(route.kind, 'ready', `${overrides.relativePath} 应 ready`);
      if (route.kind === 'ready') assert.equal(route.editorId, expected);
      assert.equal(selectEditor(input({ selectedFile: semantic })), expected);
    }
  });

  // ── §5.1 第 4 级：read capability ──

  it('read capability 未 ready → runtime-blocked，不是 ready', () => {
    const blocked = semanticFile({ readReady: false });
    const route = selectWorkbenchRoute(input({ selectedFile: blocked }));
    assert.equal(route.kind, 'runtime-blocked');
    if (route.kind === 'runtime-blocked') {
      assert.equal(route.editorId, 'param-container');
      assert.equal(route.reasonCode, 'read-capability-blocked');
    }
    assert.equal(selectEditor(input({ selectedFile: blocked })), 'binary');
  });

  // ── §5.1 第 5/6 级：candidate ──

  it('suffix-only candidate 不产生 ready（反向：GParam 非 Param、TPF 非 Text）', () => {
    // 语义输入：resourceKind='param' 但无 Bridge 确认 → files-candidate，不是 ready。
    const unconfirmed = candidateFile();
    assert.equal(selectWorkbenchRoute(input({ selectedFile: unconfirmed })).kind, 'files-candidate');
    assert.equal(selectEditor(input({ selectedFile: unconfirmed })), 'binary');

    // legacy 输入：gparam 后缀不落 Param；tpf 后缀不落 Text。
    const gparam = file('param/drawparam/m00_00.gparam.dcx', 'param', 'unknown', '.gparam.dcx');
    assert.equal(selectEditor(input({ selectedFile: gparam })), 'gparam');
    assert.notEqual(selectEditor(input({ selectedFile: gparam })), 'param-rows');
    assert.notEqual(selectEditor(input({ selectedFile: gparam })), 'param-container');

    // formatKind 'gparam'（COMPOUND_PATTERNS 新增条目后的真实索引形态）同样
    // 只落 GPARAM 工作台，不进通用容器视图 —— 它有自己的语义编辑器。
    const gparamIndexed = file('param/drawparam/m00_00.gparam.dcx', 'param', 'gparam', '.gparam.dcx');
    assert.equal(selectEditor(input({ selectedFile: gparamIndexed })), 'gparam');
    assert.notEqual(selectEditor(input({ selectedFile: gparamIndexed })), 'container');

    const tpf = file('menu/hi/1000.tpf.dcx', 'menu', 'unknown', '.tpf.dcx');
    assert.equal(selectEditor(input({ selectedFile: tpf })), 'tpf');
    assert.notEqual(selectEditor(input({ selectedFile: tpf })), 'text');
  });

  it('resourceKind 不能单独产生 Param route（反向：不再按资源目录分派）', () => {
    // 目录名 param 但格式未确认（formatKind unknown + 无后缀匹配）→ 非 param 编辑器。
    const weirdParam = file('param/whatever.bin', 'param', 'unknown', '.bin');
    assert.notEqual(selectEditor(input({ selectedFile: weirdParam })), 'param-rows');
    assert.notEqual(selectEditor(input({ selectedFile: weirdParam })), 'param-container');

    // msgbnd 的 text 来自 formatKind 'fmg'（COMPOUND_PATTERNS 证据），不是目录名。
    const msgbnd = file('msg/test.msgbnd.dcx', 'msg', 'fmg');
    assert.equal(selectEditor(input({ selectedFile: msgbnd })), 'text');
  });

  // ── legacy 路径的既有行为（App.tsx 未接 catalog 前保持可用）──

  it('parambnd 容器只给 param 容器编辑器，不同时给通用容器视图', () => {
    const editor = selectEditor(input({
      resourceMode: 'param',
      selectedFile: file('param/gameparam/GameParam.parambnd.dcx', 'param', 'param')
    }));
    assert.equal(editor, 'param-container');
    assert.notEqual(editor, 'container', '不得同时落进通用 BND4 容器视图');
  });

  it('裸 param 文件走行表编辑器而不是容器编辑器', () => {
    assert.equal(
      selectEditor(input({
        resourceMode: 'param',
        selectedFile: file('param/gameparam/AtkParam_Npc.param', 'param', 'unknown', '.param')
      })),
      'param-rows'
    );
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
        selectEditor(input({ selectedFile: file(path, 'chr', 'unknown', path.slice(path.lastIndexOf('.'))) })),
        expected,
        `${path} 应落进 ${expected}`
      );
    }
  });

  it('T3：anibnd/tae 走 TAE 工作台，anibnd 不落 BND4 通用容器页', () => {
    // anibnd 的 formatKind 是 'bnd'，正是此前落进 'container' 的那条路径。
    // T3 必须在 formatKind switch 之前拦截为 'tae'（grok T3）。
    assert.equal(
      selectEditor(input({
        resourceMode: 'behavior',
        selectedFile: file('chr/c5030/c5030.anibnd.dcx', 'chr', 'bnd', '.anibnd.dcx')
      })),
      'tae',
      'c5030.anibnd.dcx 应走 TAE 工作台而不是 BND4 容器'
    );
    assert.equal(
      selectEditor(input({
        resourceMode: 'behavior',
        selectedFile: file('action/c5030.tae', 'action', 'unknown', '.tae')
      })),
      'tae',
      'loose .tae 仍走 TAE 工作台'
    );
    // chrbnd 不进动作：仍落 BND4 容器页（「chrbnd 仍走模型/容器」）。
    assert.equal(
      selectEditor(input({
        resourceMode: 'files',
        selectedFile: file('chr/c5030/c5030.chrbnd.dcx', 'chr', 'bnd', '.chrbnd.dcx')
      })),
      'container',
      'chrbnd 不得被当成动作打开'
    );
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
    const binaryFile = file('other/unknown.bin', 'other', 'unknown', '.bin');
    for (const previewKind of ['failed', 'empty', 'hex', undefined]) {
      assert.equal(
        selectEditor(input({ selectedFile: binaryFile, previewKind })),
        'binary',
        `previewKind=${String(previewKind)} 应落进 binary`
      );
    }
  });

  /**
   * 全序性：穷举一批输入，断言每次都拿到**恰好一个**已知结果。
   *
   * 这条是本文件的核心。它不检查具体映射（上面各条已覆盖），而是检查
   * 「不会漏、不会重」——漏了会返回 undefined，重了在纯函数里不可能发生，
   * 而正是「重」在旧 JSX 装配里天天发生。把选择收敛成函数即消除该类缺陷，
   * 本条钉住这个性质不被回退（例如有人把返回类型改成数组）。
   *
   * ROUTE-06 后同时穷举语义投影维度：artifact-role prefilter 的每个分支、
   * confirmed/candidate 组合都必须恰好产出一个 route。
   */
  it('任何输入都恰好产出一个编辑器 id 与一个 route', () => {
    const legacyFiles = [
      null,
      file('param/gameparam/GameParam.parambnd.dcx', 'param', 'param'),
      file('param/gameparam/GameParam.parambnd.dcx.bak', 'param', 'backup'),
      file('param/gameparam/AtkParam_Npc.param', 'param', 'unknown', '.param'),
      file('msg/test.msgbnd.dcx', 'msg', 'fmg'),
      file('map/m10.msb.dcx', 'map', 'msb'),
      file('event/common.emevd.dcx', 'event', 'emevd'),
      file('script/luabnd.dcx', 'script', 'lua'),
      file('sfx/f0000.sfxbnd.dcx', 'sfx'),
      file('chr/c1000.tae', 'chr', 'unknown', '.tae'),
      file('chr/c5030/c5030.anibnd.dcx', 'chr', 'bnd', '.anibnd.dcx'),
      file('chr/c5030/c5030.chrbnd.dcx', 'chr', 'bnd', '.chrbnd.dcx'),
      file('other/x.bin', 'other', 'unknown', '.bin')
    ];
    const semanticFiles = [
      semanticFile(),                                                             // primary confirmed
      semanticFile({ artifactRole: 'backup', recoveryOfResourceId: 'res-x' }),    // history
      semanticFile({ artifactRole: 'previous', recoveryOfResourceId: 'res-x' }),  // history
      semanticFile({ artifactRole: 'recovery', recoveryOfResourceId: 'res-x' }),  // history
      semanticFile({ artifactRole: 'cache' }),                                    // hidden
      semanticFile({ artifactRole: 'audit' }),                                    // hidden
      semanticFile({ artifactRole: 'temporary' }),                                // hidden
      semanticFile({ artifactRole: 'projection' }),                               // hidden
      semanticFile({ readReady: false }),                                         // runtime-blocked
      candidateFile(),                                                            // suffix-only candidate
      semanticFile({ recognizedLeafFormatId: 'gparam', containerRole: 'none', semanticSubtype: 'map-bank', document: documentRef({ resourceId: 'res-g' }) }),
      semanticFile({ recognizedLeafFormatId: 'tpf', containerRole: 'none', document: documentRef({ resourceId: 'res-t' }) })
    ];
    const knownEditorIds = new Set<EditorId>([
      'param-container', 'param-rows', 'gparam', 'text', 'map', 'event', 'script', 'container',
      'tae', 'esd', 'flver', 'tpf', 'plain-text', 'binary', 'project', 'operations', 'settings', 'empty'
    ]);
    const knownRouteKinds = new Set<WorkbenchRoute['kind']>([
      'ready', 'history', 'files-candidate', 'runtime-blocked', 'unsupported'
    ]);
    const previews = [undefined, 'text', 'hex', 'empty', 'failed'];
    const views = ['resource', 'operations', 'settings'] as const;

    let checked = 0;
    for (const selectedFile of [...legacyFiles, ...semanticFiles]) {
      for (const previewKind of previews) {
        for (const textEditable of [true, false]) {
          for (const bnd4Forced of [true, false]) {
            // 三种 centerView 全覆盖：漏掉 settings 正是第一版的缺陷。
            for (const centerView of views) {
              const editor = selectEditor(input({ centerView, selectedFile, previewKind, textEditable, bnd4Forced }));
              assert.ok(
                typeof editor === 'string' && knownEditorIds.has(editor),
                `未产出已知编辑器 id：${String(editor)}（${JSON.stringify({ selectedFile, previewKind, textEditable, bnd4Forced, centerView })}）`
              );
              checked += 1;
              if (centerView === 'resource') {
                const route = selectWorkbenchRoute(input({ centerView, selectedFile, previewKind, textEditable, bnd4Forced }));
                assert.ok(
                  knownRouteKinds.has(route.kind),
                  `未产出已知 route kind：${route.kind}`
                );
                checked += 1;
              }
            }
          }
        }
      }
    }
    // 空集合必须失败关闭：若循环因某次重构变成零次，上面的断言全部恒真。
    assert.ok(checked > 1800, `穷举样本过少（${checked}），判据可能已失效`);
  });
});
