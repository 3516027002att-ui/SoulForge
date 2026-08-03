/* ═══════════════════════════════════════════════════════════
   SoulForge Renderer — 交互层
   零依赖原生 ES2020，兼容 Electron (contextIsolation) 与现代浏览器。
   原型阶段使用内置 mock 数据；接入时替换 DATA 适配层为 window.soulforge IPC。
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ═══════════ Mock 数据层（对接时替换为 IPC DTO） ═══════════ */
const RESOURCE_TREE = [
  {
    group: 'FMG / 文本', kind: 'fmg', items: [
      { name: 'item.msgbnd.dcx', ext: 'FMG', desc: '道具文本 · 342 条' },
      { name: 'menu.msgbnd.dcx', ext: 'FMG', desc: '菜单文本 · 518 条' },
      { name: 'npc.msgbnd.dcx', ext: 'FMG', desc: 'NPC 对话 · 264 条' }
    ]
  },
  {
    group: 'PARAM / 参数', kind: 'param', items: [
      { name: 'gameparam.parambnd.dcx', ext: 'PARAM', desc: 'gameparam · 76 表' },
      { name: 'actionbutton.parambnd.dcx', ext: 'PARAM', desc: '按键参数 · 只读', lock: '只读' }
    ]
  },
  {
    group: 'EMEVD / 事件', kind: 'emevd', items: [
      { name: 'common.emevd.dcx', ext: 'EMEVD', desc: '公共事件 · 四视图' },
      { name: 'm10_00_00_00.emevd.dcx', ext: 'EMEVD', desc: '苇名城 城邑' },
      { name: 'm11_00_00_00.emevd.dcx', ext: 'EMEVD', desc: '苇名城 主城' }
    ]
  },
  {
    group: 'BND4 / 容器', kind: 'bnd', items: [
      { name: 'chrc11.anibnd.dcx', ext: 'BND4', desc: '角色动画容器' }
    ]
  },
  {
    group: 'script / 脚本', kind: 'script', items: [
      { name: 'common.luabnd.dcx', ext: 'HKS', desc: '编译字节码 · 整文件替换', lock: '字节码' }
    ]
  },
  {
    group: '延期预览（V0.6）', kind: 'ro', items: [
      { name: 'm10_00_00_00.msb.dcx', ext: 'MSB', desc: '场景 · 标记只读', lock: 'V0.6' },
      { name: 'c0110.flver', ext: 'FLVER', desc: '模型 · 标记只读', lock: 'V0.6' }
    ]
  }
];

const FMG_ROWS = [
  { id: 10000, kind: '道具名', text: '伤药葫芦', original: '伤药葫芦' },
  { id: 10001, kind: '道具名', text: '纸人', original: '纸人' },
  { id: 10002, kind: '道具名', text: '手里剑', original: '手里剑' },
  { id: 10010, kind: '道具说明', text: '装着伤药的葫芦，使用后恢复 HP。\n忍义手的道具，源自永真的调配。', original: '装着伤药的葫芦，使用后恢复 HP。\n忍义手的道具，源自永真的调配。' },
  { id: 10011, kind: '道具说明', text: '化为纸片的白色人偶。\n使用忍具时消耗。', original: '化为纸片的白色人偶。\n使用忍具时消耗。' },
  { id: 10100, kind: '道具名', text: '葫芦种子', original: '葫芦种子' },
  { id: 10101, kind: '道具名', text: '佛珠', original: '佛珠' },
  { id: 10200, kind: '道具说明', text: '四颗佛珠串起，可提升体力上限。\n那是曾经忍者留下的修行之证。', original: '四颗佛珠串起，可提升体力上限。\n那是曾经忍者留下的修行之证。' },
  { id: 11000, kind: '道具名', text: '月隐糖', original: '月隐糖' },
  { id: 11001, kind: '道具名', text: '阿攻糖', original: '阿攻糖' }
];

const PARAM_ROWS = [
  { id: 1000, name: '伤药葫芦', maxNum: 10, refId: 10000, iconId: 8001, weight: 0.5 },
  { id: 1001, name: '纸人', maxNum: 99, refId: 10001, iconId: 8002, weight: 0.1 },
  { id: 1002, name: '手里剑', maxNum: 99, refId: 10002, iconId: 8003, weight: 0.1 },
  { id: 1010, name: '葫芦种子', maxNum: 10, refId: 10100, iconId: 8010, weight: 1.0 },
  { id: 1011, name: '佛珠', maxNum: 40, refId: 10101, iconId: 8011, weight: 0.8 },
  { id: 1100, name: '月隐糖', maxNum: 5, refId: 11000, iconId: 8100, weight: 0.2 },
  { id: 1101, name: '阿攻糖', maxNum: 5, refId: 11001, iconId: 8101, weight: 0.2 }
];
const PARAM_COLS = [
  { key: 'id', label: 'ID', num: true, readonly: true },
  { key: 'name', label: '名称' },
  { key: 'maxNum', label: '持有上限', num: true },
  { key: 'refId', label: '文本引用', num: true },
  { key: 'iconId', label: '图标', num: true },
  { key: 'weight', label: '重量', num: true }
];

const EMEVD_SOURCE = `# EMEVD DSL · m10_00_00_00 — 苇名城 城邑
# renderer-safe 投影 · source revision r127
event 20005100 "鬼形部 — 入场演出" {
  args { boss_id: 5100, flag: 10005100 }

  IfEventFlag(OFF, 10005100);
  IfCharacterOutsideRegion(AND, PLAYER, 1002500);
  SkipIfConditionGroupStateUncompiled(1, OFF, 10005100);

  WaitFixedTimeSeconds(0.5);
  PlaySE(1002900, SoundType.Environmental, 900200);
  IssueBossRoomEntryNotification(5100);

  IfEventFlag(ON, 10005100);
  EndUnconditionally(EventEndType.Restart);
}`;

const HEX_ROWS = [
  ['00000000', '1b 4c 75 61 51 00 01 04  08 04 08 00 00 00 00 00', '.LuaQ...........'],
  ['00000010', '00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00', '................'],
  ['00000020', '63 6f 6d 6d 6f 6e 2e 6c  75 61 00 00 00 00 00 00', 'common.lua......'],
  ['00000030', '1e 00 80 00 06 00 00 00  04 00 00 00 5e 00 00 01', '............^...'],
  ['00000040', '41 00 00 00 40 00 01 01  1e 00 80 00 00 00 00 00', 'A...@...........']
];

const STAGING_ITEMS = [
  { op: 'update', target: 'item.msgbnd.dcx#10000', desc: '文本：伤药葫芦 → 伤药葫芦·改' },
  { op: 'update', target: 'gameparam#EquipParamGoods[1000]', desc: 'maxNum：10 → 12' },
  { op: 'insert', target: 'm10_00_00_00.emevd#20005101', desc: '事件：新增 20005101（鬼形部二阶段触发）' }
];

const AUDIT_ENTRIES = [
  { type: 'commit', title: 'Patch #124 已提交', meta: '2026-08-03 13:41 · 3 mutations · hash 4f3a…c9e1', rollback: true },
  { type: 'commit', title: 'Patch #123 已提交', meta: '2026-08-03 11:02 · 1 mutation · hash 88b2…d107', rollback: true },
  { type: 'rollback', title: 'Patch #122 已回滚', meta: '2026-08-02 22:15 · overlay 层恢复 · 验证通过', rollback: false },
  { type: 'commit', title: 'Patch #122 已提交', meta: '2026-08-02 21:58 · 2 mutations · hash 1ac7…93f0', rollback: true }
];

const SEARCH_INDEX = [
  { path: 'item.msgbnd.dcx', line: '10000: 伤药葫芦', key: '葫芦' },
  { path: 'item.msgbnd.dcx', line: '10100: 葫芦种子', key: '葫芦' },
  { path: 'item.msgbnd.dcx', line: '10010: 装着伤药的葫芦…', key: '葫芦' },
  { path: 'gameparam.parambnd.dcx', line: 'EquipParamGoods[1000] name="伤药葫芦"', key: '葫芦' },
  { path: 'm10_00_00_00.emevd.dcx', line: 'event 20005100 "鬼形部 — 入场演出"', key: '鬼形部' },
  { path: 'm10_00_00_00.emevd.dcx', line: 'IssueBossRoomEntryNotification(5100)', key: '鬼形部' }
];

const CMDS = [
  { icon: '⌘', label: '打开资源：item.msgbnd.dcx', hint: 'FMG', run: () => openTab('item.msgbnd.dcx') },
  { icon: '⌘', label: '打开资源：gameparam.parambnd.dcx', hint: 'PARAM', run: () => openTab('gameparam.parambnd.dcx') },
  { icon: '⌘', label: '打开资源：m10_00_00_00.emevd.dcx', hint: 'EMEVD', run: () => openTab('m10_00_00_00.emevd.dcx') },
  { icon: '⌘', label: '打开资源：common.luabnd.dcx（Hex 证据）', hint: 'HEX', run: () => openTab('common.luabnd.dcx') },
  { icon: '◧', label: '切换侧栏面板', hint: 'Ctrl B', run: toggleSidebar },
  { icon: '✦', label: '切换 AI Agent 面板', hint: 'Ctrl J', run: toggleAgent },
  { icon: '☾', label: '切换暗色 / 亮色主题', hint: '', run: toggleTheme },
  { icon: '⎘', label: '写入暂存区中的变更', hint: '写入前备份', run: commitStaging }
];

/* ═══════════ 工具 ═══════════ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ANIM = reducedMotion ? 0 : 1;

function toast(msg, type = 'ok') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  const icon = type === 'ok'
    ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 8v5M12 16.5v.5M12 3l9.5 17h-19Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.innerHTML = `<span class="toast__icon">${icon}</span><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 200); }, 3200);
}

/* ═══════════ 资源树 ═══════════ */
function renderTree() {
  const host = $('#resourceTree');
  host.innerHTML = RESOURCE_TREE.map((g, gi) => `
    <div class="tree-group ${gi < 3 ? 'is-open' : ''}" data-group="${gi}">
      <button class="tree-group__label" aria-expanded="${gi < 3}">
        <svg class="tree-caret" viewBox="0 0 24 24" width="10" height="10"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        ${esc(g.group)}<span class="tree-count" aria-hidden="true">${g.items.length}</span>
      </button>
      <div class="tree-group__children"><div class="tree-group__inner">
        ${g.items.map((it) => `
          <button class="tree-item" data-file="${esc(it.name)}" title="${esc(it.desc)}">
            <span class="kind-dot kind-${g.kind}"></span>
            <span class="tree-item__name">${esc(it.name)}</span>
            ${it.lock ? `<span class="tree-item__lock">${esc(it.lock)}</span>` : ''}
            <span class="tree-item__ext">${esc(it.ext)}</span>
          </button>`).join('')}
      </div></div>
    </div>`).join('');

  $$('.tree-group__label', host).forEach((btn) =>
    btn.addEventListener('click', () => {
      const open = btn.closest('.tree-group').classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open);
    }));
  $$('.tree-item', host).forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('.tree-item').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      openTab(btn.dataset.file);
    }));
}

/* ═══════════ 标签页 + 编辑器 ═══════════ */
const openTabs = [];
let activeTab = null;

const FILE_META = {
  'item.msgbnd.dcx': { type: 'fmg', crumb: 'msg / <b>item.msgbnd.dcx</b>', editable: true },
  'menu.msgbnd.dcx': { type: 'fmg', crumb: 'msg / <b>menu.msgbnd.dcx</b>', editable: true },
  'npc.msgbnd.dcx': { type: 'fmg', crumb: 'msg / <b>npc.msgbnd.dcx</b>', editable: true },
  'gameparam.parambnd.dcx': { type: 'param', crumb: 'param / <b>gameparam.parambnd.dcx</b> / EquipParamGoods', editable: true },
  'actionbutton.parambnd.dcx': { type: 'param', crumb: 'param / <b>actionbutton.parambnd.dcx</b>', editable: false },
  'common.emevd.dcx': { type: 'emevd', crumb: 'event / <b>common.emevd.dcx</b> · DSL 视图', editable: true },
  'm10_00_00_00.emevd.dcx': { type: 'emevd', crumb: 'event / <b>m10_00_00_00.emevd.dcx</b> · DSL 视图', editable: true },
  'm11_00_00_00.emevd.dcx': { type: 'emevd', crumb: 'event / <b>m11_00_00_00.emevd.dcx</b> · DSL 视图', editable: true },
  'chrc11.anibnd.dcx': { type: 'hex', crumb: 'chr / <b>chrc11.anibnd.dcx</b> · 只读证据', editable: false },
  'common.luabnd.dcx': { type: 'hex', crumb: 'script / <b>common.luabnd.dcx</b> · Hex 证据视图', editable: false },
  'm10_00_00_00.msb.dcx': { type: 'hex', crumb: 'map / <b>m10_00_00_00.msb.dcx</b> · V0.6 只读预览', editable: false },
  'c0110.flver': { type: 'hex', crumb: 'chr / <b>c0110.flver</b> · V0.6 只读预览', editable: false }
};

/* 标签页采用 APG tab 模式：div[role=tab] + 真实关闭按钮（button 内嵌 button 非法） */
const safeId = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
const tabId = (name) => `tab-${safeId(name)}`;
const paneId = (name) => `pane-${safeId(name)}`;

function renderTabbar() {
  const bar = $('#tabbar');
  bar.innerHTML = openTabs.map((name) => `
    <div class="tab ${name === activeTab ? 'is-active' : ''}" data-tab="${esc(name)}" role="tab"
      id="${tabId(name)}" aria-controls="${paneId(name)}"
      aria-selected="${name === activeTab}" tabindex="${name === activeTab ? '0' : '-1'}">
      <span class="tab__name">${esc(name)}</span>
      ${FILE_META[name] && !FILE_META[name].editable ? '<span class="tab__lock" role="img" aria-label="只读" title="只读"><svg viewBox="0 0 24 24" width="10" height="10"><rect x="5" y="10" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg></span>' : ''}
      ${dirtyTabs.has(name) ? '<span class="tab__dirty" role="img" aria-label="未暂存的修改" title="未暂存的修改"></span>' : ''}
      <button class="tab__close" data-close="${esc(name)}" aria-label="关闭 ${esc(name)}" title="关闭">✕</button>
    </div>`).join('');

  $$('.tab', bar).forEach((tab) => tab.addEventListener('click', (e) => {
    if (e.target.closest('.tab__close')) return;
    activateTab(tab.dataset.tab);
  }));
  $$('.tab__close', bar).forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(btn.dataset.close);
  }));
}

/* 方向键在标签间移动并激活；Delete 关闭；Enter/Space 激活 */
function initTabbarKeys() {
  $('#tabbar').addEventListener('keydown', (e) => {
    const tabs = $$('.tab', $('#tabbar'));
    const i = tabs.indexOf(document.activeElement);
    if (i === -1) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(tabs[i].dataset.tab); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); closeTab(tabs[i].dataset.tab); return; }
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j !== null) { e.preventDefault(); tabs[j].focus(); activateTab(tabs[j].dataset.tab); }
  });
}

function openTab(name) {
  if (!FILE_META[name]) return;
  if (!openTabs.includes(name)) openTabs.push(name);
  pushRecent(name);
  activateTab(name);
}

function activateTab(name) {
  activeTab = name;
  renderTabbar();
  $$('.editor-pane').forEach((p) => p.classList.remove('is-active'));
  const pane = $(`.editor-pane[data-pane="${CSS.escape(name)}"]`) || buildPane(name);
  pane.classList.add('is-active');
  $('#editorWelcome').classList.add('is-hidden');
  const meta = FILE_META[name];
  $('#stCurrent').textContent = `当前：${name}${meta.editable ? '' : '（只读）'}`;
  $('#composerContext').innerHTML = `
    <span class="ctx-chip" title="Agent 上下文：当前资源">${esc(name)}</span>
    <button class="ctx-clear" title="清除上下文" aria-label="清除上下文">×</button>`;
}

function closeTab(name) {
  const i = openTabs.indexOf(name);
  if (i === -1) return;
  openTabs.splice(i, 1);
  $(`.editor-pane[data-pane="${CSS.escape(name)}"]`)?.remove();
  if (activeTab === name) {
    if (openTabs.length) activateTab(openTabs[Math.max(0, i - 1)]);
    else {
      activeTab = null;
      $('#editorWelcome').classList.remove('is-hidden');
      $('#stCurrent').textContent = '当前：无';
      $('#composerContext').innerHTML = '';
      renderTabbar();
    }
  } else renderTabbar();
}

function buildPane(name) {
  const meta = FILE_META[name];
  const pane = document.createElement('div');
  pane.className = 'editor-pane';
  pane.dataset.pane = name;
  pane.id = paneId(name);
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-label', name);

  const lockNote = meta.editable ? '' : '<span class="pill pill--danger">只读 · 写路径已关闭</span>';
  pane.innerHTML = `
    <div class="pane-toolbar">
      <span class="crumb">${meta.crumb}</span>${lockNote}
      <span class="toolbar-spacer"></span>
      ${meta.type !== 'hex' ? `<span class="toolbar-filter"><input type="text" placeholder="过滤行…" data-filter aria-label="过滤行" /></span>` : ''}
    </div>
    <div class="pane-content"></div>`;
  $('#editorViewport').appendChild(pane);

  /* 内容区先呈骨架（skeleton 优于 spinner），模拟异步资源装载 */
  const content = $('.pane-content', pane);
  const renderContent = () => {
    content.innerHTML = '';
    if (name === 'actionbutton.parambnd.dcx') {
      content.appendChild(buildErrorView(name, () => {
        content.innerHTML = '';
        content.appendChild(buildSkeleton(meta));
        setTimeout(() => { content.innerHTML = ''; content.appendChild(buildGrid(name, PARAM_ROWS, 'param')); }, 420 * ANIM + 60);
      }));
      return;
    }
    if (meta.type === 'fmg') content.appendChild(buildGrid(name, FMG_ROWS, 'fmg'));
    else if (meta.type === 'param') content.appendChild(buildGrid(name, PARAM_ROWS, 'param'));
    else if (meta.type === 'emevd') content.appendChild(buildCodeView(EMEVD_SOURCE));
    else content.appendChild(buildHexView());
  };
  content.appendChild(buildSkeleton(meta));
  setTimeout(renderContent, 480 * ANIM + 60);

  /* 行过滤：含「无匹配行」空态（排除空态行自身） */
  const filter = $('[data-filter]', pane);
  if (filter) filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    let visible = 0;
    $$('tbody tr:not(.grid-empty)', pane).forEach((tr) => {
      const show = !q || tr.textContent.toLowerCase().includes(q);
      tr.style.display = show ? '' : 'none';
      if (show) visible += 1;
    });
    const emptyRow = $('.grid-empty', pane);
    if (emptyRow) emptyRow.style.display = visible === 0 ? '' : 'none';
  });
  return pane;
}

/* ── 加载骨架 ── */
function buildSkeleton(meta) {
  const sk = document.createElement('div');
  sk.className = 'pane-skeleton';
  sk.setAttribute('aria-busy', 'true');
  sk.setAttribute('aria-label', '正在加载资源');
  const widths = meta.type === 'fmg' || meta.type === 'param'
    ? [38, 96, 82, 91, 70, 88, 77, 93, 64]
    : [52, 78, 66, 84, 58, 71, 88, 61, 76, 69, 82, 55];
  sk.innerHTML = `<div class="sk-line sk-line--head"></div>` +
    widths.map((w) => `<div class="sk-line" style="--w:${w}%"></div>`).join('');
  return sk;
}

/* ── 错误态：明确原因 + 恢复路径 ── */
function buildErrorView(name, onRetry) {
  const el = document.createElement('div');
  el.className = 'pane-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <svg class="pane-error__icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M12 8v5M12 16.5v.5M12 3l9.5 17h-19Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <h3>资源解析失败</h3>
    <p>Bridge 对 <span class="mono">${esc(name)}</span> 的原生解析返回诊断码
    <span class="mono">PARAM_DEF_MISMATCH</span>：ParamDef 版本与资源头部不一致。资源本体未受影响。</p>
    <button class="btn btn--ghost btn--sm" data-retry>重试加载</button>`;
  $('[data-retry]', el).addEventListener('click', onRetry);
  return el;
}

/* ── 表格编辑器 ── */
const dirtyTabs = new Set();

function buildGrid(fileName, rows, mode) {
  const wrap = document.createElement('div');
  wrap.className = 'grid-wrap';
  const cols = mode === 'fmg'
    ? [{ key: 'id', label: 'ID', num: true, readonly: true }, { key: 'kind', label: '类别', readonly: true }, { key: 'text', label: '文本' }]
    : PARAM_COLS;

  wrap.innerHTML = `<table class="grid">
    <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.id}">
      ${cols.map((c) => `<td class="${c.num ? 'cell-num' : ''} ${c.key === 'id' ? 'cell-id' : ''}"
        ${!c.readonly ? 'contenteditable="true" spellcheck="false"' : ''}
        data-key="${c.key}">${esc(r[c.key] ?? '')}</td>`).join('')}
    </tr>`).join('')}
    <tr class="grid-empty" style="display:none"><td colspan="${cols.length}">无匹配行。</td></tr></tbody></table>`;

  wrap.addEventListener('input', (e) => {
    const td = e.target.closest('td[contenteditable]');
    if (!td) return;
    const tr = td.closest('tr');
    const row = rows.find((r) => String(r.id) === tr.dataset.id);
    const original = row?.original ?? row?.[td.dataset.key];
    const edited = td.textContent.trim() !== String(original).trim();
    tr.classList.toggle('is-edited', edited);
    /* 不以颜色为唯一状态指示：已修改行附带文字标记 */
    const idCell = tr.querySelector('.cell-id');
    if (idCell) {
      idCell.querySelector('.row-edited-mark')?.remove();
      if (edited) idCell.insertAdjacentHTML('beforeend', '<span class="row-edited-mark">改</span>');
    }
    if (!$$('.is-edited', wrap).length) dirtyTabs.delete(fileName); else dirtyTabs.add(fileName);
    renderTabbar();
  });
  return wrap;
}

/* ── 代码视图（轻量语法高亮） ── */
function highlightDsl(src) {
  return esc(src)
    .replace(/(&quot;.*?&quot;)/g, '<span class="tok-str">$1</span>')
    .replace(/(#.*$)/gm, '<span class="tok-cmt">$1</span>')
    .replace(/\b(event|args|EndUnconditionally)\b/g, '<span class="tok-kw">$1</span>')
    .replace(/\b(IfEventFlag|IfCharacterOutsideRegion|SkipIfConditionGroupStateUncompiled|WaitFixedTimeSeconds|PlaySE|IssueBossRoomEntryNotification)\b/g, '<span class="tok-fn">$1</span>')
    .replace(/\b(\d{2,}|OFF|ON|PLAYER)\b/g, '<span class="tok-num">$1</span>');
}

function buildCodeView(src) {
  const frag = document.createElement('div');
  frag.className = 'pane-view';
  const lines = src.split('\n');
  const diagLines = new Set([8]);
  frag.innerHTML = `
    <div class="code-wrap">
      <div class="code-gutter" aria-hidden="true">${lines.map((_, i) =>
        `<div class="g-line ${diagLines.has(i + 1) ? 'has-diag' : ''}">${i + 1}</div>`).join('')}</div>
      <pre class="code-body">${lines.map((l, i) =>
        `<div class="${diagLines.has(i + 1) ? 'code-line-diag' : ''}">${highlightDsl(l) || ' '}</div>`).join('')}</pre>
    </div>
    <div class="code-diag-bar">
      <svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 8v5M12 16.5v.5M12 3l9.5 17h-19Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      第 8 行：SkipIfConditionGroupStateUncompiled 建议在提交前完成编译校验（1 项警告）
    </div>`;
  return frag;
}

/* ── Hex 证据视图 ── */
function buildHexView() {
  const frag = document.createElement('div');
  frag.className = 'pane-view';
  frag.innerHTML = `
    <div class="code-wrap">
      <pre class="code-body hex-body">${HEX_ROWS.map(([addr, bytes, ascii], ri) => {
        const b = esc(bytes).split(/(\s{2})/g).map((part) =>
          part.trim() === '' ? part : part.split(' ').map((x, i) =>
            `<span class="hex-byte ${ri === 0 && i < 5 ? 'hex-byte--hi' : ''}">${x}</span>`).join(' ')
        ).join('');
        return `<span class="hex-addr">${addr}</span>  ${b}  <span class="hex-ascii">${esc(ascii)}</span>`;
      }).join('\n')}</pre>
    </div>
    <div class="code-diag-bar code-evidence-bar">
      只读证据视图 · 高亮为容器 magic（\\x1bLuaQ）· renderer 不暴露字节级写路径
    </div>`;
  return frag;
}

/* ═══════════ 活动栏 / 侧栏面板 ═══════════ */
function switchPanel(id) {
  $$('.ab-item[data-panel]').forEach((b) => {
    if (b.dataset.panel === 'agent-toggle') return;
    const on = b.dataset.panel === id;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panelId === id));
  const sidebar = $('#sidebar');
  if (sidebar.classList.contains('is-collapsed')) toggleSidebar();
}

function toggleSidebar() {
  $('#sidebar').classList.toggle('is-collapsed');
}

function toggleAgent() {
  $('#agentPanel').classList.toggle('is-collapsed');
}

function initActivitybar() {
  $$('.ab-item[data-panel]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.panel;
    if (id === 'agent-toggle') toggleAgent();
    else switchPanel(id);
  }));
  $('#agentClose').addEventListener('click', toggleAgent);
}

/* 侧栏拖拽调宽 */
function initResizer() {
  const resizer = $('#sidebarResizer');
  const sidebar = $('#sidebar');
  let startX = 0, startW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    startX = e.clientX; startW = sidebar.offsetWidth;
    resizer.classList.add('is-dragging');
    resizer.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.min(480, Math.max(180, startW + ev.clientX - startX));
      /* 写 CSS 变量而非 inline width：折叠动画的负边距同样由该变量驱动 */
      sidebar.style.setProperty('--sidebar-w', `${w}px`);
    };
    const up = () => {
      resizer.classList.remove('is-dragging');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
}

/* ═══════════ 暂存区 ═══════════ */
let staging = [...STAGING_ITEMS];

function renderStaging() {
  const list = $('#stagingList');
  list.innerHTML = staging.length ? staging.map((it, i) => `
    <div class="staging-item" data-i="${i}">
      <div class="staging-item__head">
        <span class="staging-item__op op-${it.op}">${it.op.toUpperCase()}</span>
        <span class="staging-item__target" title="${esc(it.target)}">${esc(it.target)}</span>
        <button class="staging-item__remove" data-remove="${i}" title="移除">✕</button>
      </div>
      <div class="staging-item__desc">${esc(it.desc)}</div>
    </div>`).join('') : '<p class="empty-hint">暂存区为空。变更经批准后进入暂存，验证后写入。</p>';

  $('#stagingBadge').textContent = staging.length;
  $('#stagingBadge').style.display = staging.length ? '' : 'none';
  $('.ab-item[data-panel="staging"]').setAttribute('aria-label', `暂存区（${staging.length} 项待提交）`);
  $('#stagingPill').textContent = staging.length ? `${staging.length} 项待提交` : '暂存为空';
  $('#commitBtn').disabled = !staging.length;
  $('#discardBtn').textContent = staging.length ? `放弃全部（${staging.length} 项）` : '放弃全部';

  $$('[data-remove]', list).forEach((btn) => btn.addEventListener('click', () => {
    const item = btn.closest('.staging-item');
    item.classList.add('is-leaving');
    setTimeout(() => { staging.splice(Number(btn.dataset.remove), 1); renderStaging(); }, 180 * ANIM);
  }));
}

function commitStaging() {
  if (!staging.length) return;
  const n = staging.length;
  staging = [];
  renderStaging();
  AUDIT_ENTRIES.unshift({
    type: 'commit',
    title: `Patch #125 已写入`,
    meta: `刚刚 · ${n} 项变更 · 原文件已备份 · hash ${Math.random().toString(16).slice(2, 6)}…${Math.random().toString(16).slice(2, 6)}`,
    rollback: true
  });
  renderAudit();
  renderWelcome();
  toast(`写入成功：${n} 项变更已写入，原文件已备份，可回滚`);
}

function initStaging() {
  renderStaging();
  $('#commitBtn').addEventListener('click', commitStaging);
  $('#discardBtn').addEventListener('click', () => {
    if (!staging.length) return;
    staging = [];
    renderStaging();
    toast('已放弃全部暂存修改', 'warn');
  });
}

/* ═══════════ 审计时间线 ═══════════ */
function renderAudit() {
  const host = $('#auditTimeline');
  host.innerHTML = AUDIT_ENTRIES.map((e) => `
    <div class="audit-entry audit-entry--${e.type}">
      <div class="audit-entry__title">${esc(e.title)}</div>
      <div class="audit-entry__meta">${esc(e.meta)}</div>
      ${e.rollback ? `<div class="audit-entry__actions"><button class="btn btn--ghost btn--sm" data-rollback="${esc(e.title)}">回滚到此版本</button></div>` : ''}
    </div>`).join('');
  $$('[data-rollback]', host).forEach((btn) => btn.addEventListener('click', () =>
    toast(`已发起回滚：${btn.dataset.rollback}（overlay 层恢复）`, 'warn')));
}

/* ═══════════ 欢迎页（真实工作区摘要） ═══════════ */
const RECENT_KEY = 'soulforge-recent';
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
function pushRecent(name) {
  const next = [name, ...loadRecent().filter((x) => x !== name)].slice(0, 6);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* sandbox */ }
}

function renderWelcome() {
  const byName = new Map();
  let locked = 0, total = 0;
  RESOURCE_TREE.forEach((g) => g.items.forEach((it) => { byName.set(it.name, { ...it, kind: g.kind }); total++; if (it.lock) locked++; }));
  $('#welcomeStats').textContent = `已索引 ${total} 个资源 · ${total - locked} 个可编辑 · ${locked} 个只读（含 V0.6 延期预览）`;

  const review = $('#welcomeReview');
  if (staging.length) {
    review.innerHTML = staging.map((it) => `
      <div class="review-row">
        <span class="staging-item__op op-${it.op}">${it.op.toUpperCase()}</span>
        <span class="review-row__target" title="${esc(it.target)}">${esc(it.target)}</span>
        <span class="review-row__delta">${esc(it.desc)}</span>
        <button class="btn btn--ghost btn--sm" data-goto-staging>审查</button>
      </div>`).join('');
    $$('[data-goto-staging]', review).forEach((b) => b.addEventListener('click', () => switchPanel('staging')));
  } else {
    review.innerHTML = '<p class="empty-hint welcome-empty">没有待审查的变更。</p>';
  }

  const recent = loadRecent().filter((n) => byName.has(n));
  $('#welcomeRecentEmpty').hidden = recent.length > 0;
  const quick = $('#welcomeQuick');
  quick.innerHTML = recent.map((n) => {
    const it = byName.get(n);
    return `<button class="quick-item" data-open="${esc(n)}">
      <span class="kind-dot kind-${it.kind}"></span>
      <span class="quick-item__body">
        <span class="quick-item__name">${esc(n)}</span>
        <span class="quick-item__desc">${esc(it.desc)}</span>
      </span>
      <span class="quick-item__ext">${esc(it.ext)}</span>
    </button>`;
  }).join('');
  $$('.quick-item', quick).forEach((b) => b.addEventListener('click', () => openTab(b.dataset.open)));

  const last = AUDIT_ENTRIES[0];
  $('#welcomeAudit').innerHTML = last
    ? `最近写入 <span class="mono">${esc(last.title)} · ${esc(last.meta)}</span>`
    : '本工作区尚无写入记录';
}

/* ═══════════ 搜索 ═══════════ */
function initSearch() {
  const input = $('#searchInput');
  const results = $('#searchResults');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) { results.innerHTML = '<p class="empty-hint">输入关键字，跨 FMG / PARAM / EMEVD 资源检索。</p>'; return; }
    const hits = SEARCH_INDEX.filter((h) => h.line.includes(q));
    results.innerHTML = hits.length ? hits.map((h) => `
      <button class="search-hit">
        <div class="search-hit__path">${esc(h.path)}</div>
        <div class="search-hit__line">${esc(h.line).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `<mark>${esc(q)}</mark>`)}</div>
      </button>`).join('') : '<p class="empty-hint">无匹配结果。</p>';
    $$('.search-hit', results).forEach((hit, i) =>
      hit.addEventListener('click', () => openTab(hits[i].path)));
  });
}

/* ═══════════ Agent 会话 ═══════════ */
const stream = $('#agentStream');
let agentBusy = false;

const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const scrollStream = () => stream.scrollTo({ top: stream.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
function setAgentState(text, busy) {
  $('#agentState').textContent = text;
  $('#agentDot').classList.toggle('is-busy', !!busy);
}
function clearAgentEmpty() { $('#agentEmpty')?.remove(); }
function addGoal(text) {
  clearAgentEmpty();
  const el = document.createElement('div');
  el.className = 'task-goal';
  el.innerHTML = `<span class="task-goal__label">目标</span>${esc(text)}`;
  stream.appendChild(el);
  scrollStream();
}
function addBlock(label, innerHtml) {
  const el = document.createElement('div');
  el.className = 'agent-block';
  el.innerHTML = `<div class="agent-block__label">${esc(label)}</div>${innerHtml}`;
  stream.appendChild(el);
  scrollStream();
  return el;
}
function addLog(text, cls = '') {
  let log = $('.agent-log:last-of-type', stream);
  if (!log || log.dataset.closed) log = addBlock('日志', '<div class="agent-log"></div>').querySelector('.agent-log');
  const row = document.createElement('div');
  row.className = `agent-log__row ${cls}`;
  row.innerHTML = `<span class="t">${now()}</span><span>${esc(text)}</span>`;
  log.appendChild(row);
  scrollStream();
  return log;
}

/* 变更审查卡：对象/字段/原值/新值/证据/范围/可逆性，内部名仅在详情行 */
function mutationCard({ title, file, record, field, oldVal, newVal, evidence, diffs, onResolve }) {
  const card = document.createElement('div');
  card.className = 'mutation-card';
  card.innerHTML = `
    <div class="mutation-card__head">
      <span>变更：${esc(title)}</span>
      <span class="pill pill--warn">待审查</span>
    </div>
    <div class="mutation-card__meta">
      <div><span>目标</span><b class="mono">${esc(file)} · ${esc(record)}</b></div>
      <div><span>字段</span><b class="mono">${esc(field)}</b>（${esc(fieldLabel(field))}）</div>
      <div><span>原值 → 新值</span><b><s class="old">${esc(oldVal)}</s> → <span class="new">${esc(newVal)}</span></b></div>
      <div><span>证据</span><b class="mono">${esc(evidence)}</b></div>
      <div><span>影响范围</span><b>1 条记录 · 1 个字段</b></div>
      <div><span>可逆性</span><b>写入前自动备份，写入后可回滚</b></div>
      <div class="mutation-card__internal"><span>内部</span><b class="mono">typed mutation → PatchIR</b></div>
    </div>
    <div class="mutation-card__body">${diffs.map((d) => `
      <div class="diff-line diff-line--${d.t}">
        <span class="diff-line__sign">${d.t === 'add' ? '+' : d.t === 'del' ? '−' : ' '}</span>
        <span class="diff-line__code">${esc(d.code)}</span>
      </div>`).join('')}</div>
    <div class="mutation-card__foot">
      <button class="btn btn--primary btn--sm" data-act="approve">批准并入暂存</button>
      <button class="btn btn--ghost btn--sm" data-act="reject">拒绝</button>
    </div>`;
  stream.appendChild(card);
  scrollStream();
  $('[data-act="approve"]', card).addEventListener('click', () => {
    card.querySelector('.mutation-card__foot').innerHTML = '<span class="pill pill--ok">已入暂存区，等待写入</span>';
    card.querySelector('.mutation-card__head .pill').outerHTML = '<span class="pill pill--ok">已批准</span>';
    staging.push({ op: 'update', target: `${file}#${record}`, desc: `${field}: ${oldVal} → ${newVal}` });
    renderStaging();
    renderWelcome();
    addLog('变更已入暂存区，等待写入', 'is-ok');
    setAgentState('空闲', false);
    onResolve?.(true);
  });
  $('[data-act="reject"]', card).addEventListener('click', () => {
    card.querySelector('.mutation-card__foot').innerHTML = '<span class="pill pill--danger">已拒绝，未产生任何写入</span>';
    card.querySelector('.mutation-card__head .pill').outerHTML = '<span class="pill pill--danger">已拒绝</span>';
    addLog('变更被拒绝', 'is-danger');
    setAgentState('空闲', false);
    onResolve?.(false);
  });
  return card;
}
const fieldLabel = (f) => ({ maxNum: '持有上限', refId: '文本引用', iconId: '图标', weight: '重量' }[f] ?? f);

async function simulateAgentRun(userText) {
  if (agentBusy) return;
  agentBusy = true;
  setAgentState('执行中', true);
  addGoal(userText);
  await sleep(500 * ANIM + 200);

  addBlock('证据', `<div class="agent-evidence">
    <div class="agent-evidence__row"><span class="mono">item.msgbnd.dcx</span>道具文本<span class="meta">342 条 · r127</span></div>
    <div class="agent-evidence__row"><span class="mono">gameparam.parambnd.dcx</span>EquipParamGoods<span class="meta">76 表 · r127</span></div>
  </div>`);
  addLog('索引检索完成，定位 2 个相关资源');
  await sleep(520 * ANIM + 80);
  addLog('读取证据完成（source revision r127）');
  await sleep(520 * ANIM + 80);
  addLog('生成 1 项变更，暂存校验通过');
  await sleep(300 * ANIM + 80);

  setAgentState('待审批', false);
  mutationCard({
    title: '伤药葫芦持有上限 10 → 12',
    file: 'gameparam.parambnd.dcx',
    record: 'EquipParamGoods[1000]',
    field: 'maxNum',
    oldVal: '10',
    newVal: '12',
    evidence: 'item.msgbnd.dcx#10000 · revision r127',
    diffs: [
      { t: 'ctx', code: 'EquipParamGoods[1000] // 伤药葫芦' },
      { t: 'del', code: '  maxNum: 10' },
      { t: 'add', code: '  maxNum: 12' },
      { t: 'ctx', code: '  refId: 10000 // "伤药葫芦"' }
    ]
  });
  agentBusy = false;
}

function initAgent() {
  stream.innerHTML = '<div class="agent-empty" id="agentEmpty">没有进行中的任务。在下方描述目标，Agent 会定位资源、读取证据并生成变更；变更经你批准后才会进入暂存区。</div>';

  const input = $('#agentInput');
  const send = () => {
    const text = input.value.trim();
    if (!text || agentBusy) return;
    input.value = '';
    simulateAgentRun(text);
  };
  $('#agentSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#composerContext').addEventListener('click', (e) => {
    if (e.target.closest('.ctx-clear')) $('#composerContext').innerHTML = '';
  });
}

/* ═══════════ 命令面板 ═══════════ */
let cmdkIndex = 0;

let cmdkReturnFocus = null;

function openCmdk() {
  cmdkReturnFocus = document.activeElement;
  $('#cmdkOverlay').classList.add('is-open');
  $('#cmdkInput').value = '';
  renderCmdk('');
  setTimeout(() => $('#cmdkInput').focus(), 30);
}
function closeCmdk() {
  const wasOpen = $('#cmdkOverlay').classList.contains('is-open');
  $('#cmdkOverlay').classList.remove('is-open');
  /* 焦点归还：对话框关闭后回到召唤它的元素 */
  if (wasOpen && cmdkReturnFocus && document.contains(cmdkReturnFocus)) cmdkReturnFocus.focus();
  cmdkReturnFocus = null;
}

function renderCmdk(q) {
  const list = $('#cmdkList');
  const filtered = CMDS.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  cmdkIndex = Math.min(cmdkIndex, Math.max(0, filtered.length - 1));
  list.innerHTML = filtered.length ? filtered.map((c, i) => `
    <button class="cmdk-item ${i === cmdkIndex ? 'is-selected' : ''}" data-cmd="${CMDS.indexOf(c)}">
      <span class="cmdk-item__icon">${c.icon}</span>
      <span class="cmdk-item__label">${esc(c.label)}</span>
      ${c.hint ? `<span class="cmdk-item__hint">${esc(c.hint)}</span>` : ''}
    </button>`).join('') : '<p class="empty-hint">无匹配命令。</p>';
  $$('.cmdk-item', list).forEach((btn) => btn.addEventListener('click', () => {
    closeCmdk();
    CMDS[Number(btn.dataset.cmd)].run();
  }));
}

function initCmdk() {
  $('#cmdkTrigger').addEventListener('click', openCmdk);
  $('#cmdkOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeCmdk(); });
  /* 焦点陷阱：Tab 循环保持在对话框内 */
  $('#cmdkOverlay').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = $$('#cmdkOverlay input, #cmdkOverlay button').filter((el) => el.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('#cmdkInput').addEventListener('input', (e) => { cmdkIndex = 0; renderCmdk(e.target.value); });
  $('#cmdkInput').addEventListener('keydown', (e) => {
    const items = $$('.cmdk-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIndex = (cmdkIndex + 1) % items.length; renderCmdk(e.target.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIndex = (cmdkIndex - 1 + items.length) % items.length; renderCmdk(e.target.value); }
    else if (e.key === 'Enter') { e.preventDefault(); items[cmdkIndex]?.click(); }
  });
}

/* ═══════════ 主题 / 时钟 / 快捷键 ═══════════ */
function toggleTheme() {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('soulforge-theme', html.dataset.theme); } catch { /* sandbox */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('soulforge-theme'); } catch { /* sandbox */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#themeToggle2').addEventListener('click', toggleTheme);
}

function initClock() {
  const el = $('#clock');
  const tick = () => {
    const d = new Date();
    el.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 15000);
}

function initHotkeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#cmdkOverlay').classList.contains('is-open') ? closeCmdk() : openCmdk(); }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleAgent(); }
    else if (e.key === 'Escape') closeCmdk();
  });
}

/* ═══════════ 启动 ═══════════ */
function boot() {
  initTheme();
  /* 窄屏默认折叠 Agent，保证中央工作区主视觉 */
  if (window.matchMedia('(max-width: 1100px)').matches) $('#agentPanel').classList.add('is-collapsed');
  renderTree();
  initActivitybar();
  initResizer();
  initStaging();
  renderAudit();
  renderWelcome();
  initSearch();
  initAgent();
  initCmdk();
  initClock();
  initHotkeys();
  initTabbarKeys();
  renderTabbar();
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
