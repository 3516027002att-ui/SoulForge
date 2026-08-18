/**
 * TEXTURE-52B：TpfWorkbenchPanel 的渲染结构 + 负向清单；
 * TEXTURE-52C：replace 写入口的接线契约。
 *
 * 三条主线：
 * 1. SSR 结构断言：真渲染 TpfWorkbenchPanel（react-dom/server），钉住工作台
 *    骨架 —— 工具条面包屑、Containers/Textures/Viewer/Properties 四栏、各栏
 *    空态引导。SSR 不跑 effect，所以这里看到的是「挂载即有的结构」，异步读取
 *    由 e2e 负责。
 * 2. 纯逻辑断言：containerDisplayName 去扩展（物理路径只在 title）；
 *    TEXTURE-52C 的 filterTpfDdsSources 投影工作区 DDS 源、
 *    submitTpfTextureReplace 透传 saveTpfTextureReplace 参数并投影结果分支。
 * 3. Negative/source tests：读取失败保留列表；写入口唯一且只经
 *    saveTpfTextureReplace（无字节直写 fallback）；replace 成功后触发重读、
 *    失败保留纹理列表并显示 diagnostics、提交期间防重复。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TpfWorkbenchPanel,
  filterTpfDdsSources,
  submitTpfTextureReplace,
  type TpfContainerView
} from './TpfWorkbenchPanel.js';

// node 环境没有 window，而 getRendererBridge 会读 window.soulforge —— 不设
// 会在渲染时 ReferenceError。设为空对象 → browser-preview 表面 → bridge 为
// null → 组件里的桥接 effect 全部短路，SSR 输出纯初始结构。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const containers: TpfContainerView[] = [
  { sourceUri: 'fixture://menu/start.tpf.dcx', relativePath: 'menu/start.tpf.dcx' },
  { sourceUri: 'fixture://menu/broken.tpf.dcx', relativePath: 'menu/broken.tpf.dcx' }
];

function render(initialUri?: string): string {
  return renderToStaticMarkup(
    <TpfWorkbenchPanel containers={containers} {...(initialUri ? { initialUri } : {})} />
  );
}

describe('TpfWorkbenchPanel 初始结构（挂载即有的骨架）', () => {
  it('工作台有可访问名', () => {
    const html = render();
    assert.match(html, /aria-label="Texture 工作台"/);
  });

  it('四栏 Containers/Textures/Viewer/Properties 同时存在（TEXTURE-52B）', () => {
    const html = render();
    assert.match(html, /aria-label="Containers"/);
    assert.match(html, /aria-label="Textures"/);
    assert.match(html, /aria-label="Viewer"/);
    assert.match(html, /aria-label="Properties"/);
  });

  it('Containers 栏列出全部容器，显示名去扩展，物理路径只在 title', () => {
    const html = render();
    assert.match(html, /start/);
    assert.match(html, /broken/);
    // 显示名去 .tpf.dcx；title 保留完整相对路径（metadata details）。
    assert.doesNotMatch(html, />start\.tpf\.dcx</);
    assert.match(html, /title="menu\/start\.tpf\.dcx"/);
  });

  it('11-C：可见文本不含「Texture · N containers」crumb', () => {
    const html = render();
    assert.doesNotMatch(html, /Texture · \d+ containers/);
  });

  it('未选容器时各栏给出引导空态', () => {
    const html = render();
    assert.match(html, /先在最左栏选择一个容器/);
    assert.match(html, /在中间选择一张纹理查看预览/);
    assert.match(html, /选择一张纹理查看元数据/);
  });

  it('初始渲染无任何 type=button（无假 replace / 无多余控件）', () => {
    const html = render();
    assert.doesNotMatch(html, /type="button"/);
  });

  it('无 3D viewport：不渲染 canvas 或视图容器（§2.5 TEXTURE 无 3D viewport）', () => {
    const html = render();
    assert.doesNotMatch(html, /<canvas/i);
  });
});

describe('TpfWorkbenchPanel 纯逻辑（显示名）', () => {
  it('container 显示名去 .tpf.dcx 与 .tpf', () => {
    assert.match(render(), /<span class="wb-row__name"[^>]*>start<\/span>/);
    assert.doesNotMatch(render(), />start\.tpf\.dcx</);
  });
});

describe('Negative source tests（TEXTURE-52B）', () => {
  const repoRoot = process.cwd();
  const workbenchSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'TpfWorkbenchPanel.tsx'),
    'utf8'
  );

  it('桥接调用只有 read 通道 + saveTpfTextureReplace 一个写出口（52C 接线）', () => {
    const bridgeCalls = [...workbenchSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.length > 0, '工作台没有任何 bridge 调用（read 通道缺失）');
    // 只读通道：readTpfDocument / readTpfTexturePreview（52B）+
    // searchResources / readRawRange（52C 选 DDS 源并读字节，都不写文件）。
    // 唯一写出口：saveTpfTextureReplace（replace 源字节经它进 Patch/reopen/rollback）。
    const allowed = new Set([
      'readTpfDocument',
      'readTpfTexturePreview',
      'searchResources',
      'readRawRange',
      'saveTpfTextureReplace'
    ]);
    assert.ok(
      bridgeCalls.every((name) => allowed.has(name)),
      `发现未知桥接调用：${bridgeCalls.filter((n) => !allowed.has(n)).join(', ')}`
    );
    assert.ok(bridgeCalls.includes('saveTpfTextureReplace'), 'saveTpfTextureReplace 写出口缺失');
  });

  it('无字节直写（不能有 contentBase64 / dataBase64 fallback）', () => {
    assert.doesNotMatch(workbenchSource, /contentBase64|dataBase64/);
  });

  it('writer 就绪后显示 replace 入口：无「尚未接通」占位，有源选择与替换控件', () => {
    assert.doesNotMatch(workbenchSource, /纹理写回链尚未接通/);
    assert.doesNotMatch(workbenchSource, /没有 replace 入口/);
    // replace 入口真实存在：按钮文案 + 源选择下拉 + saveTpfTextureReplace 接线。
    assert.match(workbenchSource, /替换选中纹理/);
    assert.match(workbenchSource, /tpf-replace-source/);
    assert.match(workbenchSource, /saveTpfTextureReplace/);
  });

  it('无 3D viewport：不引用 three / canvas / FlverViewer', () => {
    assert.doesNotMatch(workbenchSource, /three|FlverViewer|<canvas/i);
  });

  it('预览失败保留列表：失败诊断渲染在 Viewer 栏，选择链不清空', () => {
    // preview failure isolation 的形态：纹理列表不因预览失败而清空，Viewer
    // 栏独立渲染失败诊断（tpf-preview-failure）。
    assert.match(workbenchSource, /previewFailure/);
    assert.match(workbenchSource, /data-testid="tpf-preview-failure"/);
    // 选中纹理的读取与预览失败互不影响：纹理列表渲染不依赖 preview 状态。
    assert.doesNotMatch(workbenchSource, /previewFailure && \(\s*<div className="wb-list"/);
  });

  it('截断说明走 formatListTruncation 且保留 tpf-truncation testId（listTruncation 契约）', () => {
    assert.match(workbenchSource, /formatListTruncation/);
    assert.match(workbenchSource, /data-testid="tpf-truncation"/);
  });
});

describe('TpfWorkbenchPanel replace 纯逻辑（TEXTURE-52C）', () => {
  it('filterTpfDdsSources 只保留 .dds、投影并排序（源来自工作区索引）', () => {
    const sources = filterTpfDdsSources([
      { sourceUri: 'file://parts/tex/b.dds', relativePath: 'parts/tex/b.dds', size: 2048 },
      { sourceUri: 'file://parts/tex/a.dds', relativePath: 'parts/tex/a.dds', size: 1024 },
      { sourceUri: 'file://parts/tex/map.png', relativePath: 'parts/tex/map.png', size: 512 },
      { sourceUri: 'file://menu/start.tpf.dcx', relativePath: 'menu/start.tpf.dcx', size: 999 },
      { sourceUri: 'file://parts/tex/BIG.DDS', relativePath: 'parts/tex/BIG.DDS', size: 4096 }
    ]);
    assert.deepEqual(sources, [
      { sourceUri: 'file://parts/tex/a.dds', relativePath: 'parts/tex/a.dds', size: 1024 },
      { sourceUri: 'file://parts/tex/b.dds', relativePath: 'parts/tex/b.dds', size: 2048 },
      { sourceUri: 'file://parts/tex/BIG.DDS', relativePath: 'parts/tex/BIG.DDS', size: 4096 }
    ]);
  });

  it('filterTpfDdsSources 缺 size 时兜底为 0', () => {
    const sources = filterTpfDdsSources([
      { sourceUri: 'file://parts/tex/x.dds', relativePath: 'parts/tex/x.dds' }
    ]);
    assert.deepEqual(sources, [
      { sourceUri: 'file://parts/tex/x.dds', relativePath: 'parts/tex/x.dds', size: 0 }
    ]);
  });

  it('submitTpfTextureReplace 透传 (sourceUri, sourceHash, textureIndex, base64) 给 save', async () => {
    const calls: Array<[string, string, number, string]> = [];
    const outcome = await submitTpfTextureReplace({
      save: async (sourceUri, expectedHash, textureIndex, newTextureBase64) => {
        calls.push([sourceUri, expectedHash, textureIndex, newTextureBase64]);
        return { ok: true, changedFiles: [], diagnostics: [] };
      },
      sourceUri: 'fixture://menu/start.tpf.dcx',
      expectedHash: 'fixture-hash-52c',
      textureIndex: 3,
      newTextureBase64: 'REFTUyA='
    });
    assert.deepEqual(calls, [
      ['fixture://menu/start.tpf.dcx', 'fixture-hash-52c', 3, 'REFTUyA=']
    ]);
    assert.equal(outcome.ok, true);
  });

  it('ok=true 返回成功消息（组件据此触发重读）', async () => {
    const outcome = await submitTpfTextureReplace({
      save: async () => ({ ok: true, changedFiles: [], diagnostics: [] }),
      sourceUri: 'u', expectedHash: 'h', textureIndex: 0, newTextureBase64: 'b'
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /已替换/);
  });

  it('ok=false 投影首条 diagnostics 消息（validate 失败原因）', async () => {
    const outcome = await submitTpfTextureReplace({
      save: async () => ({
        ok: false,
        changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TPF_STAGING_WRITE_FAILED', message: '尺寸不匹配：源 128×128，目标 256×256。' }]
      }),
      sourceUri: 'u', expectedHash: 'h', textureIndex: 1, newTextureBase64: 'b'
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /尺寸不匹配/);
  });

  it('ok=false 且无 diagnostics 时给兜底失败文案', async () => {
    const outcome = await submitTpfTextureReplace({
      save: async () => ({ ok: false, changedFiles: [], diagnostics: [] }),
      sourceUri: 'u', expectedHash: 'h', textureIndex: 1, newTextureBase64: 'b'
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, '纹理替换失败。');
  });
});

describe('TpfWorkbenchPanel replace source contract（TEXTURE-52C）', () => {
  const repoRoot = process.cwd();
  const workbenchSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'TpfWorkbenchPanel.tsx'),
    'utf8'
  );

  it('replace 源字节来自工作区 DDS：searchResources 列源 + readRawRange 读字节，无文件对话框/新增 IPC', () => {
    assert.match(workbenchSource, /searchResources\(/);
    assert.match(workbenchSource, /readRawRange\(/);
    // 源字节是已读的 base64，不是 contentBase64/dataBase64 直写 fallback。
    assert.doesNotMatch(workbenchSource, /contentBase64|dataBase64/);
  });

  it('ok=true 触发重读：document 读取 effect 依赖 refreshToken，成功分支递增', () => {
    assert.match(workbenchSource, /\[bridge, selectedContainerUri, refreshToken\]/);
    assert.match(workbenchSource, /setRefreshToken\(\(token\) => token \+ 1\)/);
  });

  it('ok=false 显示 diagnostics：失败分支写 replaceResult，渲染 tpf-replace-failure', () => {
    assert.match(workbenchSource, /setReplaceResult\(\{ ok: false, message: outcome\.message \}\)/);
    assert.match(workbenchSource, /tpf-replace-failure/);
    assert.match(workbenchSource, /写入已中止并回滚，纹理列表保留/);
  });

  it('提交期间防重复：提交中直接忽略新触发，按钮 disabled 含 replaceSubmitting', () => {
    assert.match(workbenchSource, /if \(replaceSubmitting\) return;/);
    assert.match(workbenchSource, /disabled=\{!canReplace\}/);
    // canReplace 必须含 !replaceSubmitting，否则按钮在提交期间仍可点。
    assert.match(workbenchSource, /&& !replaceSubmitting;/);
  });
});
