#!/usr/bin/env node
/**
 * preload 暴露面裁定门禁。
 *
 * 守的问题：preload 暴露给渲染进程的每个方法，要么 renderer 真的在用，要么必须
 * **显式登记为「已裁定但尚未接线」并写明依据**。
 *
 * 实测背景：57 个暴露方法里有 15 个 renderer 零引用。它们不是待办 TODO —— 都已
 * 过 CI、已封存证据、main 侧 handler 齐全，但 UI 上没有入口。这污染两个判断：
 *
 *  1. 能力盘点失真。治理按 handler 注册与 IPC 证据判进度，而 runAiAgent /
 *     launchMe3 在界面上无入口，于是「已实现」与「用户可用」出现系统性偏差。
 *  2. 安全面积。preload 每多暴露一个未使用方法，就多一个不受 renderer 守卫保护
 *     的表面，且它的失败分支从未被人手触发过。
 *
 * 为什么做成门禁而不是写进文档：文档里的清单会和代码分叉，而分叉无人发现。这里
 * 把「暴露面 = 已用 ∪ 已裁定」变成机器可校验的等式：
 *   - 新增暴露但既没接线也没登记 → 红（防「顺手暴露一个」）
 *   - 登记项已经接线了 → 红（防登记表过期，逼它随接线进度收缩）
 *   - 登记项从 preload 撤下了 → 红（防登记表残留幽灵条目）
 *
 * 不需要构建产物：读源码即可（判据是「暴露面与 renderer 引用」的静态关系，
 * 不是运行期行为）。运行期表面由 desktop-ipc-contract 与
 * desktop-security-runtime 负责。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererIdentifiers } from './contract/rendererSourceAnalysis.mjs';

const LABEL = 'preload-surface-ruling';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = join(root, 'apps', 'desktop', 'src', 'preload', 'index.ts');

/**
 * 已裁定但尚未接线的暴露方法。
 *
 * 每条必须写：为什么保留（而不是撤下）、依据哪条治理裁定、接线的前置条件是什么。
 * 没有依据的条目等于「先放着」，那正是本门禁要消除的状态。
 */
/**
 * 按能力族划分的裁定表。
 *
 * 2026-08-14 更新：盘点发现 15 条新增暴露面无 renderer 引用（08-10 封存的通过态是
 * 60/60 全被引用，见 EV-WORKBENCH-PARAM-TRUST-20260810）。它们不是待办 TODO——
 * 每条都对应已封存的写/读能力切片（writer/IPC/native 层），只是各 write 切片
 * Allowed 明确不含 preload/renderer，UI 入口属于未来切片。族划分与
 * RULED_NOT_YET_WIRED 严格互为覆盖（判据 5）。
 *
 * 历史（2026-08-08 清零前，按接线顺序）：
 *   raw-bytes 2 条            readRawRange → HexEditorPanel 按偏移翻页；
 *                             readRawMetadata → 同面板的整资源哈希（不读内容即可拿）
 *   ai-agent 6 条             AgentTaskPanel + App.tsx 的订阅与调用
 *   container-diagnostics 3 条 Bnd4WorkbenchPanel 的「逐项容器诊断」按需展开块
 *   me3-runtime 4 条          runtime/Me3RuntimePanel 挂在设置面板
 *                             （用户裁定「四条全接、启动默认禁用」）
 *
 * 族键在接线后**整个删掉**而不是留空数组：留空会让 ruledFamilies 报出
 * "某族": 0，而「有这个族但为零」与「这个族已清空」在盘点上不是一回事。
 *
 * 若将来 preload 新增暴露方法而 renderer 尚未引用，本表就是它的登记处。
 * 每条必须写：为什么保留（而不是撤下）、依据哪条治理裁定、接线的前置条件是什么。
 * 没有依据的条目等于「先放着」，那正是本门禁要消除的状态。
 */
const RULED_FAMILY = Object.freeze({
  'editor-document-facade': [
    'openEditorDocument', 'getEditorDocument', 'pageEditorDocument',
    'readEditorDocumentContent', 'applyEditorMutation', 'closeEditorDocument',
  ],
  'format-read-primitive': [
    'readFmgPage', 'readFlverTextureSlots',
  ],
  'compat-read-primitive': [
    'readRawMetadata', 'scriptContainerEvidence', 'readScriptEntryPlaintext',
    'readMapPartMesh', 'resolveChrbndPreview', 'readParamPage',
  ],
  'compat-semantic-write': ['applyEmevdMutation', 'applyMsbMutation'],
  'first-party-metadata-compat': ['getParamMetadataTrustState', 'setParamMetadataTrust'],
  'agent-backend-primitive': ['buildAiSidebarDraft', 'getMutterStatus', 'embedWorkspaceRag', 'searchWorkspaceEvidence'],
  'pose-sampling-unverified': ['sampleTaeAnimationPose'],
});

/**
 * 已裁定但尚未接线的暴露方法。**2026-08-14 接线 6 项后剩 8 条。**
 *
 * 历史：2026-08-08 曾清零（57/57 全引用，EV-T14-WIRING-COMPLETE）；08-10 前端施工
 * 期间 write 能力切片把 IPC 入口暴露进 preload，但各 write 切片 Allowed 不含
 * renderer，UI 写入入口未接线——这正是本门禁要守的「已实现但用户不可用」差距，
 * 显式登记，不假装可用。
 *
 * 2026-08-14：format-write-ui 5 条 + agent-resource-reference 1 条**已全部接线**
 * （Material 属性编辑 / ESD transition / TAE event / FXR field / TPF texture
 * replace / Agent 资源引用，各工作台经 getRendererBridge 直连 bridge.commit*），
 * 从本表与族划分一并删除——接线即收缩，不留永久豁免。剩余 8 条属
 * editor-document-facade 与 format-read-primitive 两族，均需未来切片收敛。
 *
 * 判据 5 要求本表与 RULED_FAMILY 双向一致：一条方法在其中之一出现而另一处没有，
 * 会报 PRELOAD_RULING_FAMILY_ORPHAN / PRELOAD_RULING_FAMILY_MISSING。
 */
const RULED_NOT_YET_WIRED = Object.freeze({
  // These retained APIs have no current renderer call. The owner has ruled
  // their compatibility/backend scope; this records the gap without claiming
  // that the alternate workflow verifies each primitive or finishes its UI.
  readRawMetadata:
    'editors/HexEditorPanel.tsx defines optional onLoadMetadata but callers do not wire it; '
    + 'TpfWorkbenchPanel.tsx uses readRawRange for bytes. Full raw metadata/hash UI remains unwired; '
    + 'a future metadata action must connect the bounded reader and display deferred hash diagnostics.',
  scriptContainerEvidence:
    'editors/ScriptContainerPanel.tsx uses listScriptContainerEntriesPage for its current catalog; '
    + 'the lower-level evidence probe remains a compatibility surface. A dedicated evidence action must '
    + 'display its diagnostics before this method can be called renderer-wired.',
  readScriptEntryPlaintext:
    'editors/ScriptContainerPanel.tsx calls readScriptSource, whose result carries encoding/revision identity; '
    + 'the older plaintext primitive is retained for compatibility and requires its own explicit read-only caller.',
  applyEmevdMutation:
    'app/useEventDocumentController.ts submits submitEmevdDslPlan through the typed DSL/native/PatchIR path; '
    + 'the low-level mutation API is retained, with no current direct UI. Any new caller must preserve that typed validation and transaction boundary.',
  applyMsbMutation:
    'editors/MsbScenePanel.tsx calls executeMapTransaction for semantic scene edits; '
    + 'the older mutation API is retained for compatibility. A direct caller would require the same source revision and transaction checks.',
  sampleTaeAnimationPose:
    'editors/TaeWorkbenchPanel.tsx reads readTaeAnimationClip and samples through its renderer clip sampler; '
    + 'main/services/actionService.ts also exposes the unused pose primitive. Real HKX pose acceptance remains unverified; '
    + 'a dedicated native pose caller and real-corpus fidelity verification are still required.',
  readMapPartMesh:
    'editors/MsbScenePanel.tsx marks readMapPartMesh deprecated and calls readMapStaticGeometry with bounded cursor/session/request state; '
    + 'the old mesh primitive is retained for compatibility. It needs an explicit bounded caller if reused.',
  resolveChrbndPreview:
    'editors/TaeWorkbenchPanel.tsx currently calls readTaeChrbndPreview; main/services/characterPreviewService.ts '
    + 'retains resolveChrbndPreview as a lower-level resolver. A separate resolver UI must expose diagnostics and stable logical resource identity before wiring.',
  getParamMetadataTrustState:
    'main/services/paramService.ts resolves immutable first-party metadata and projects fieldDefsTrusted; '
    + 'editors/ParamDefPanel.tsx gates on first-party origin. The old trust-state query has no current caller; '
    + 'a metadata inspection action must preserve the first-party matching authority.',
  setParamMetadataTrust:
    'main/services/paramService.ts rejects external schema/trust overrides for production PARAM; '
    + 'the setter is retained as a compatibility boundary, with no trust-override UI. A future caller cannot bypass immutable first-party validation.',
  readParamPage:
    'app/useParamDocumentController.ts calls openParamSession/readParamIndexPage/readParamRows; '
    + 'main/services/paramService.ts retains readParamPage for compatibility. A dedicated caller must maintain bounded paging and row/source identity checks.',
  buildAiSidebarDraft:
    'agent/AgentSessionControls.tsx distinguishes the old plan-draft controls from the real agent; '
    + 'app/useAgentUiController.ts calls runAiAgent with configured service identity. No draft-generation action is currently wired; '
    + 'reconnecting it requires an explicit non-agent draft workflow and accurate service labeling.',
  getMutterStatus:
    'agent/MutterBanner.tsx calls getMutterNext for the existing banner. The standalone status query has no current caller; '
    + 'a diagnostic status action must distinguish actual status from delivered banner text.',
  embedWorkspaceRag:
    'main/services/semanticRefreshService.ts schedules internal RAG embedding; app/useRuntimeSettingsController.ts '
    + 'only queries getRagLocalModelStatus. Manual embedding remains unwired and would require asynchronous progress/cancellation plus workspace revision checks.',
  searchWorkspaceEvidence:
    'main/services/agentEvidenceService.ts owns the evidence search; app/useAgentUiController.ts requests runAiAgent with useRagSearch. '
    + 'There is no standalone renderer search action. A new action must preserve source references, scope filtering and bounded evidence reads.',
  // ── editor-document-facade（DOCSTORE-04 typed facade，§14.4）──
  openEditorDocument:
    'DOCSTORE-04 typed DocumentStore facade 已封存，main handler 在 ipc.ts:1479。'
    + 'renderer 现走各格式专用 read 方法（readEmevdDocument/readParamDocument 等），'
    + '未采用通用 facade。接线前置：未来切片把格式编辑器统一收敛到 DocumentStore 通道。',
  getEditorDocument:
    '同 DOCSTORE-04 家族；facade 的按 handle 读取。前置同 openEditorDocument。',
  pageEditorDocument:
    '同 DOCSTORE-04 家族；facade 的分页读取（硬约束 17 的有界页面契约）。前置同 openEditorDocument。',
  readEditorDocumentContent:
    '同 DOCSTORE-04 家族；facade 的内容读取。前置同 openEditorDocument。',
  applyEditorMutation:
    '同 DOCSTORE-04 家族；facade 的 mutation 提交。前置同 openEditorDocument。',
  closeEditorDocument:
    '同 DOCSTORE-04 家族；facade 的关闭。前置同 openEditorDocument。',

  // ── format-read-primitive（低层读取原语，当前工作台用更高层 API）──
  readFmgPage:
    '硬约束 17 的有界页面访问器之一（main 注释 resource.readFmgPage/readParamPage/'
    + 'listContainerChildrenPage），main handler 在 ipc.ts:2483，e2e 直连通道验证。'
    + 'Text 工作台用表级 readFmgTablePage。接线前置：未来切片的 FMG 工作台合并或撤下。',
  readFlverTextureSlots:
    'FLVER 纹理槽读取原语，main handler 存在，Model 工作台未消费。'
    + '接线前置：未来 Model 工作台的纹理槽检查器。',
});

const WIRING_PRIORITY = Object.freeze([
  // runAiAgent 曾是本表第一优先项，已于 2026-08-08 接线。条目**保留**：输出处按
  // 「是否仍在 RULED_NOT_YET_WIRED」过滤，已接线项自动消失，不需要有人记得来删；
  // 而删掉它反而会让「这条优先级是否曾被处理过」不可追溯。
  {
    method: 'runAiAgent',
    why: 'REL-G 已 passed，仅缺 renderer 任务面板入口——本表里唯一「后端已 passed、只差 UI」的一族'
  },
  {
    method: 'readRawMetadata',
    why: '不读内容即可拿哈希/尺寸，是大文件校验的前置查询；readRawRange 已接线并自带 fileSize，故本条只剩这一项独立价值'
  },
  {
    method: 'probeContainerCapabilities',
    why: '决定容器工作台开放哪些操作；当前只有 inspectContainerTree 的聚合结论，逐项诊断不可查'
  },
  {
    method: 'detectMe3',
    why: 'SCOPE-RUNTIME 已 user-approved，但 REL-H 仍 open——接线需真实 Sekiro 启动证据（§9.6 BLOCK-3/4），且 scope 明禁「能力探测缺失或含糊时启动」'
  }
  // 2026-08-14 曾新增 6 条 write/agent 接线优先项（createAgentResourceReference /
  // commitMtdPropertySet / saveTpfTextureReplace / commitEsdTransition /
  // commitTaeEvent / commitFxrFieldSet），本轮已全部接线并从登记表删除——
  // nextWiring 按登记表过滤，无需再列；保留注释以追溯「已处理过」。
]);

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(PRELOAD)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'PRELOAD_SOURCE_MISSING',
    message: `preload 源码缺失：${PRELOAD}`
  }, 1);
}

const preloadSource = readFileSync(PRELOAD, 'utf8');
/** contextBridge 暴露面：顶层两空格缩进的 `name:` 属性。 */
const exposed = [...preloadSource.matchAll(/^\s{2}(\w+):\s*(?:\(|<)/gm)].map((match) => match[1]);
if (exposed.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'PRELOAD_SURFACE_UNEXTRACTABLE',
    message: '未能从 preload 源码提取任何暴露方法；提取失败必须失败关闭，'
      + '否则「暴露面为空」会让本门禁的所有判据变成必然通过。'
  }, 1);
}

let rendererSources;
try {
  const files = execSync('git ls-files apps/desktop/src/renderer', { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter((line) => /\.(?:ts|tsx|js|jsx)$/.test(line) && !/\.(?:test|fixture)\./.test(line));
  if (files.length === 0) throw new Error('renderer 文件列表为空');
  // 每个文件独立剥离，避免一个文件内的引号/模板字面量状态跨文件吞掉后续
  // renderer。源码文本仍用于同一套词法剥离规则，边界只负责防止误入状态泄漏。
  rendererSources = files.map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }));
} catch (error) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'RENDERER_SOURCE_UNREADABLE',
    message: `无法读取 renderer 源码：${error instanceof Error ? error.message : String(error)}`
  }, 1);
}

/**
 * 注释与字符串字面量必须先剥掉，再判引用。
 *
 * 裸词匹配（`\bname\b` 直接打全文）会把三种非引用形态判成「已接线」：
 * `// TODO: wire launchMe3`、`'launchMe3 not wired'`、以及被注释掉的旧调用
 * `// await bridge.launchMe3(...)`。实测四种形态全部误判为已接线。
 *
 * 后果不是漏报而是**反向**的：一个方法只要在 renderer 的注释里被提到，就会被算作
 * 已接线，于是判据 2（PRELOAD_RULING_STALE）会逼人把它从登记表里删掉，而它其实
 * 从未接线——登记表因此丢掉真实待接线项，本门禁的核心等式失去意义。
 * 这与本仓库已记录的「grep 式 must-not 判据改名即报绿」同源：判据必须看代码结构，
 * 不能看文本出现。
 *
 * 剥离是保守的：只处理 //、/* *\/ 和三种引号，不做完整词法分析。剥过头会造成
 * 漏判引用（判成未接线 → 要求登记），那是安全方向；剥不足会造成误判已接线，
 * 所以宁可多剥。
 */
const rendererNames = new Set(rendererSources.flatMap(({ file, source }) => [...rendererIdentifiers(source, file)]));
const referenced = new Set(exposed.filter((name) => rendererNames.has(name)));
const orphaned = exposed.filter((name) => !referenced.has(name));

const findings = [];

// 1. 未接线且未登记 → 红。防「顺手暴露一个方法」。
for (const name of orphaned) {
  if (!(name in RULED_NOT_YET_WIRED)) {
    findings.push({
      code: 'PRELOAD_METHOD_UNRULED',
      method: name,
      message: `preload 暴露了 ${name}，但 renderer 零引用且未登记裁定依据。`
        + ' 每个暴露方法都是不受 renderer 守卫保护的表面，且其失败分支从未被人手'
        + '触发过。请接线，或从 preload 撤下，或在 RULED_NOT_YET_WIRED 登记并写明'
        + '治理依据与接线前置条件。'
    });
  }
}

// 2. 已登记但其实已接线 → 红。逼登记表随接线进度收缩，否则它会变成永久豁免清单。
for (const name of Object.keys(RULED_NOT_YET_WIRED)) {
  if (referenced.has(name)) {
    findings.push({
      code: 'PRELOAD_RULING_STALE',
      method: name,
      message: `${name} 已在 renderer 接线，但仍留在 RULED_NOT_YET_WIRED 里。`
        + ' 登记表必须随接线收缩——留着它等于给一个已完成项永久豁免。'
    });
  }
}

// 3. 已登记但已从 preload 撤下 → 红。防幽灵条目。
for (const name of Object.keys(RULED_NOT_YET_WIRED)) {
  if (!exposed.includes(name)) {
    findings.push({
      code: 'PRELOAD_RULING_GHOST',
      method: name,
      message: `${name} 已不在 preload 暴露面，但仍登记在 RULED_NOT_YET_WIRED 里。`
    });
  }
}

// 4. 每条裁定必须写理由。空理由等于没有裁定。
for (const [name, reason] of Object.entries(RULED_NOT_YET_WIRED)) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    findings.push({
      code: 'PRELOAD_RULING_REASON_MISSING',
      method: name,
      message: `${name} 的裁定没有写理由；没有依据的条目等于「先放着」。`
    });
  }
}

// 5. 族划分必须与登记表严格互为覆盖。
//
// 通过输出里的族计数原先是硬编码的 4/6/3/2，与登记表脱钩：登记表增删一条时计数
// 不会跟着变，于是门禁「通过」的同时报出一个错误的盘点数字。而这份计数正是
// 接手者用来判断「还剩多少能力没接线」的依据，说谎的代价不比判据失效小。
// 现在计数从 RULED_FAMILY 推导，并在此断言两者双向一致——漏登记一个族成员，
// 或给族里写一个已不在登记表的名字，都必须红。
{
  const familyMembers = Object.values(RULED_FAMILY).flat();
  const duplicates = familyMembers.filter((name, index) => familyMembers.indexOf(name) !== index);
  for (const name of new Set(duplicates)) {
    findings.push({
      code: 'PRELOAD_RULING_FAMILY_DUPLICATE',
      method: name,
      message: `${name} 同时属于多个族；族划分必须是登记表的一个划分（partition）。`
    });
  }
  const familySet = new Set(familyMembers);
  for (const name of Object.keys(RULED_NOT_YET_WIRED)) {
    if (!familySet.has(name)) {
      findings.push({
        code: 'PRELOAD_RULING_FAMILY_MISSING',
        method: name,
        message: `${name} 已登记裁定但未归入任何族；族计数会因此少算，盘点数字失真。`
      });
    }
  }
  for (const name of familySet) {
    if (!(name in RULED_NOT_YET_WIRED)) {
      findings.push({
        code: 'PRELOAD_RULING_FAMILY_ORPHAN',
        method: name,
        message: `${name} 出现在族划分里但不在登记表中；族计数会因此多算。`
      });
    }
  }
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'PRELOAD_SURFACE_RULING_VIOLATION',
    message: 'preload 暴露面与裁定登记表不一致：暴露面必须等于「renderer 已用」∪「已裁定待接线」。',
    exposedCount: exposed.length,
    referencedCount: referenced.size,
    orphanedCount: orphaned.length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: 'preload 暴露面完全等于「renderer 已用」∪「已裁定待接线」。',
  exposedCount: exposed.length,
  referencedCount: referenced.size,
  ruledNotYetWired: orphaned.length,
  ruledFamilies: Object.fromEntries(
    Object.entries(RULED_FAMILY).map(([family, members]) => [family, members.length])
  ),
  // 从登记表**推导**而非硬编码：原先是两条字面量，readRawRange 接线后它仍在
  // 建议「接 readRawRange」——一条会随施工过期的建议，和它要治的「登记表不随
  // 接线收缩」是同一个病。只列仍在 RULED_NOT_YET_WIRED 里的项，收缩自动跟随。
  nextWiring: WIRING_PRIORITY
    .filter((hint) => hint.method in RULED_NOT_YET_WIRED)
    .map((hint) => `${hint.method}：${hint.why}`),
  nonClaim: '本门禁只校验「暴露面 = 已用 ∪ 已裁定」这条静态等式，不验证任何 IPC 的'
    + '运行期行为（那由 desktop-ipc-contract 与 desktop-security-runtime 负责），'
    + '也不声明已裁定待接线的能力对用户可用。'
}, 0);
