/**
 * SHELL-09：领域导航只消费 DomainSummary[] 的单元测试。
 *
 * 三条主线：
 * 1. buildDomainSummaries 的纯逻辑：领域集合固定（shared EDITOR_DOMAIN_IDS
 *    顺序）、project/files 恒存在且 read-ready、capability 按「read contract
 *    已注册 × 运行条件满足」判定、defaultTarget 恒 null（未伪造逻辑库句柄）。
 * 2. Negative source tests：domainNavigation.ts / DomainNavigationBar.tsx /
 *    App.tsx 的源码不得再出现 domainForFile、filterFilesForDomain、以及把
 *    visibleFiles.length 当领域计数——§4.1 明确禁止的三种形态。这条是源码
 *    对账而不是行为测试：行为测试只能证明「现在不用」，对账证明「不能回来」。
 * 3. 物理浏览归属：语义领域不得渲染全局 resource browser；只有 files 领域
 *    使用物理 taxonomy（resourceFamilies / filterFilesForMode）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EDITOR_DOMAIN_IDS, type EditorDomainId } from '@soulforge/shared';
import { buildDomainSummaries, domainLabel } from './domainNavigation.js';

/**
 * 源码对账路径。注意：本测试经 esbuild bundle 后在
 * node_modules/.cache/soulforge-renderer-unit/ 下运行，import.meta.url 指向
 * bundle 产物而非源码；源码路径一律用 process.cwd()（仓库根）推导。
 */
const repoRoot = process.cwd();
const navigationDir = join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'navigation');
const appSourceFile = join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');

function domainSet(ids: readonly EditorDomainId[]): ReadonlySet<EditorDomainId> {
  return new Set(ids);
}

describe('buildDomainSummaries', () => {
  it('领域集合与顺序来自 shared EDITOR_DOMAIN_IDS（§3.2 固定顺序）', () => {
    const summaries = buildDomainSummaries({ readContract: new Set(), runtimeReady: true });
    assert.deepEqual(summaries.map((entry) => entry.domain), [...EDITOR_DOMAIN_IDS]);
    // §3.2 固定顺序快照：开始 | PARAM | GPARAM | 文本 | 事件 | 地图 | 脚本 | 动作
    // | 动画 | 模型 | 纹理 | 材质 | VFX | 容器 | 文件
    // T3（2026-08-15）：behavior 标签为「动作」；animation 枚举保留（不删 shared
    // EDITOR_DOMAIN_IDS），顶栏经 visibility 隐藏。
    assert.deepEqual(summaries.map((entry) => entry.label), [
      '开始', 'PARAM', 'GPARAM', '文本', '事件', '地图', '脚本',
      '动作', '动画', '模型', '纹理', '材质', 'VFX', '容器', '文件'
    ]);
  });

  it('project 始终存在且 read-ready 可见；files 存在且 read-ready 但 visibility hidden（问题 14）', () => {
    const empty = buildDomainSummaries({ readContract: new Set(), runtimeReady: false });
    const project = empty.find((item) => item.domain === 'project');
    assert.ok(project, 'project 必须存在');
    assert.equal(project.visibility, 'visible');
    assert.equal(project.capability, 'read-ready');
    // 14：files 枚举仍在、仍 read-ready（物理浏览/Ctrl+K 路由不拆），只是顶栏隐藏。
    const files = empty.find((item) => item.domain === 'files');
    assert.ok(files, 'files 必须存在');
    assert.equal(files.capability, 'read-ready');
    assert.equal(files.visibility, 'hidden');
  });

  it('read contract 已注册且运行条件满足 → read-ready', () => {
    const summaries = buildDomainSummaries({
      readContract: domainSet(['param', 'text']),
      runtimeReady: true
    });
    assert.equal(summaries.find((entry) => entry.domain === 'param')?.capability, 'read-ready');
    assert.equal(summaries.find((entry) => entry.domain === 'text')?.capability, 'read-ready');
    // 未注册的领域不能借已注册邻居变可操作（§3.2 候选格式不能制造可操作领域）。
    assert.equal(summaries.find((entry) => entry.domain === 'gparam')?.capability, 'deferred');
  });

  it('已注册但运行条件不满足 → runtime-blocked（browser-preview 等表面）', () => {
    const summaries = buildDomainSummaries({
      readContract: domainSet(['param']),
      runtimeReady: false
    });
    assert.equal(summaries.find((entry) => entry.domain === 'param')?.capability, 'runtime-blocked');
  });

  it('defaultTarget 恒为 null：在拿到真实 EditorCatalogSummary 之前不伪造逻辑库句柄', () => {
    const summaries = buildDomainSummaries({
      readContract: domainSet(['param', 'text', 'event', 'map', 'script', 'container']),
      runtimeReady: true
    });
    for (const entry of summaries) assert.equal(entry.defaultTarget, null);
  });

  it('R1 + T3 + 14 裁定：GPARAM / 动画 / 文件从领域顶栏隐藏，其余 visible（含开始）', () => {
    const summaries = buildDomainSummaries({ readContract: new Set(), runtimeReady: true });
    for (const entry of summaries) {
      if (entry.domain === 'gparam' || entry.domain === 'animation' || entry.domain === 'files') {
        assert.equal(entry.visibility, 'hidden', `${entry.domain} 必须按 R1/T3/14 裁定从顶栏隐藏`);
      } else {
        assert.equal(entry.visibility, 'visible');
      }
    }
  });

  it('project 不按工作区挂载隐藏：开始是顶栏资源栏开关', () => {
    const navSource = readFileSync(join(navigationDir, 'domainNavigation.ts'), 'utf8');
    assert.doesNotMatch(navSource, /domain === 'project' && input\.hasWorkspace/);
    assert.equal(
      buildDomainSummaries({ readContract: new Set(), runtimeReady: true })
        .find((item) => item.domain === 'project')?.visibility,
      'visible'
    );
  });

  it('T3 裁定：behavior 的中文标签是「动作」（行为 + 动画合并）', () => {
    const summaries = buildDomainSummaries({ readContract: new Set(), runtimeReady: true });
    const behavior = summaries.find((entry) => entry.domain === 'behavior');
    const animation = summaries.find((entry) => entry.domain === 'animation');
    assert.equal(behavior?.label, '动作');
    assert.equal(behavior?.visibility, 'visible', '动作（behavior）必须在顶栏可见');
    assert.equal(animation?.visibility, 'hidden', '动画（animation）必须从顶栏隐藏');
  });

  it('domainLabel 覆盖全部领域，不返回 undefined', () => {
    for (const domain of EDITOR_DOMAIN_IDS) {
      assert.equal(typeof domainLabel(domain), 'string');
      assert.ok(domainLabel(domain).length > 0);
    }
  });
});

describe('SHELL-09 negative source tests（§18.13）', () => {
  const sources = [
    { name: 'domainNavigation.ts', text: stripComments(readFileSync(join(navigationDir, 'domainNavigation.ts'), 'utf8')) },
    { name: 'DomainNavigationBar.tsx', text: stripComments(readFileSync(join(navigationDir, 'DomainNavigationBar.tsx'), 'utf8')) },
    { name: 'App.tsx', text: stripComments(readFileSync(appSourceFile, 'utf8')) }
  ];

  it('源码不再有 domainForFile（§16：若仍存在则任务失败）', () => {
    for (const { name, text } of sources) {
      assert.ok(!text.includes('domainForFile'), `${name} 仍包含 domainForFile`);
    }
  });

  it('源码不再有 filterFilesForDomain（§4.1 禁止列表）', () => {
    for (const { name, text } of sources) {
      assert.ok(!text.includes('filterFilesForDomain'), `${name} 仍包含 filterFilesForDomain`);
    }
  });

  it('visibleFiles.length 不得再被用作领域计数（§4.1 禁止列表）', () => {
    for (const { name, text } of sources) {
      const matches = text.match(/visibleFiles\s*\.\s*length/g) ?? [];
      assert.equal(matches.length, 0, `${name} 仍把 visibleFiles.length 当计数使用`);
    }
  });
});

describe('物理浏览归属（§18.13 Steps：语义领域不渲染全局 resource browser）', () => {
  it('domainNavigation 不再依赖 ResourceMode/物理 taxonomy', () => {
    const text = stripComments(readFileSync(join(navigationDir, 'domainNavigation.ts'), 'utf8'));
    assert.ok(!text.includes('resourceFamilies'), 'domainNavigation 不得引用 resourceFamilies');
    assert.ok(!text.includes('ResourceMode'), 'domainNavigation 不得引用 ResourceMode');
    assert.ok(!text.includes('RendererIndexedFile'), 'domainNavigation 不得引用物理文件类型');
  });

  it('DomainNavigationBar 只接收 DomainSummary[]，props 中无 files；开始选中态走 resourceSidebarOpen', () => {
    const text = stripComments(readFileSync(join(navigationDir, 'DomainNavigationBar.tsx'), 'utf8'));
    assert.ok(!text.includes('RendererIndexedFile'), 'DomainNavigationBar 不得引用物理文件类型');
    assert.ok(text.includes('domains: readonly DomainSummary[]'), 'DomainNavigationBar 必须声明 domains: readonly DomainSummary[]');
    assert.ok(text.includes('resourceSidebarOpen'), '开始的选中态必须跟资源栏开闭走');
  });
});

/**
 * 对账前剥离注释：§4.1 禁止的是代码引用这些符号，注释里的历史叙述（如引用
 * §16 原文「若仍存在 domainForFile 则任务失败」）不算代码引用。剥不干净会
 * 让对账对注释敏感——提一次标识符就红一次，把对账变成措辞洁癖。
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
