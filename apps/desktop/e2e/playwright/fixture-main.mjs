/**
 * Playwright fixture main：加载生产 preload 与构建产物，用合成 fixture
 * （微小、合法构造、明确标记）注册与生产同名的 IPC 通道，
 * 驱动 renderer 状态机的端到端测试。不触碰真实游戏资产。
 *
 * ── 覆盖边界（如实声明，不要读成「e2e 覆盖了 main」）──────────────────────
 *
 * 真实的部分：真 Electron 进程、真生产 preload（out/preload/index.cjs，CJS）、真
 * 构建后的 renderer、真 contextBridge 语义，以及**与生产同形态的发送方校验**
 * （handleTrusted 包装器 + assertTrustedSender，见下）。
 *
 * 不真实的部分：main 侧业务逻辑整体是 fixture。本文件自己注册 54 个 channel，
 * 生产 ipc.ts 有 56 个，且 registerIpcHandlers 从未被加载。因此以下**没有**被
 * e2e 覆盖，不得据本套件声称它们可用：
 *   - PARAM / EMEVD / 脚本容器 面板的读写与分页
 *     （readParamPage、readEmevdDocument、listScriptContainerEntriesPage 等）
 *   - TAE / ESD / FLVER / MTD 面板的**主进程侧**读写实现：read 通道已在 fixture
 *     里 stub（合成 DTO），但生产 registerIpcHandlers 从未被加载，写通道与
 *     main 侧解析实现不在本套件覆盖内
 *   - saveText 等文本写入链路的 main 侧实现
 *   - Bridge 子进程、SQLite、utilityProcess、凭据 vault 的真实行为
 * 这些由 core smoke、契约门禁与 native 层分别覆盖。要把 e2e 提升为真实 main
 * 覆盖，需让本文件加载生产 registerIpcHandlers 并只把最外层依赖（Bridge、
 * SQLite、文件系统根）替换为受控替身——那是独立工作项。
 *
 * 环境变量：
 * - SF_TEST_APPLY_FAIL=1：FMG 写入返回 ORIGINAL_CHANGED_DURING_STAGING 失败。
 * - SF_TEST_CANCEL_DIALOG=1：workspace.openDialog 返回 null（用户取消路径）。
 * - SF_TEST_BROWSER_PREVIEW=1：创建无 preload 窗口，模拟普通浏览器预览表面。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
// S10 引用框选：fixture 签发 citation 时复用 shared 构建产物的解码/合并/标签
// 函数，保证标签格式与生产 main 同源不漂移。
import { decodeCiteHits, mergeCiteHits, formatCitationLabel } from '../../../../packages/shared/dist/index.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(here, '../../out');
const APPLY_FAIL = process.env.SF_TEST_APPLY_FAIL === '1';
const CANCEL_DIALOG = process.env.SF_TEST_CANCEL_DIALOG === '1';
const BROWSER_PREVIEW = process.env.SF_TEST_BROWSER_PREVIEW === '1';
// S-FILE-ROLLBACK：种子两条 committed 操作历史，供审计面板文件级回滚用例。
const FIXTURE_OPERATIONS = process.env.SF_FIXTURE_OPERATIONS === '1';

/** Synthetic fixture corpus — tiny, constructed, explicitly labeled (AGENTS.md §15). */
function makeFile({ dir, name, kind, formatKind, formatLabel, extension, compoundExtension, size = 2048 }) {
  const relativePath = dir ? `${dir}/${name}` : name;
  return {
    sourceUri: `fixture://${relativePath}`,
    game: 'sekiro',
    resourceKind: kind,
    parseStatus: 'parsed',
    diagnostics: [],
    relativePath,
    extension,
    compoundExtension,
    formatKind,
    formatLabel,
    size,
    mtimeMs: 0
  };
}

const fixtureFiles = [
  makeFile({ dir: 'event', name: 'common.emevd', kind: 'event', formatKind: 'emevd', formatLabel: 'EMEVD', extension: '.emevd', compoundExtension: '.emevd' }),
  makeFile({ dir: 'event', name: 'menu.emevd', kind: 'event', formatKind: 'emevd', formatLabel: 'EMEVD', extension: '.emevd', compoundExtension: '.emevd' }),
  // S14/S15：KRAK 压缩失败样本（合成「未挂原版」的可行动失败态，明确标记）。
  makeFile({ dir: 'event', name: 'krak.emevd.dcx', kind: 'event', formatKind: 'emevd', formatLabel: 'EMEVD', extension: '.dcx', compoundExtension: '.emevd.dcx' }),
  makeFile({ dir: 'msg', name: 'test.msgbnd.dcx', kind: 'msg', formatKind: 'fmg', formatLabel: 'FMG', extension: '.dcx', compoundExtension: '.msgbnd.dcx' }),
  // 11-B：文本目录按容器分组 —— item / menu 两个容器都要在。menu.msgbnd.dcx 是
  // menu 容器的载体（左栏 menu 组下面的 menu.fmg 真空表）。
  makeFile({ dir: 'msg', name: 'menu.msgbnd.dcx', kind: 'msg', formatKind: 'fmg', formatLabel: 'FMG', extension: '.dcx', compoundExtension: '.msgbnd.dcx' }),
  makeFile({ dir: 'action', name: 'c0000.tae', kind: 'action', formatKind: 'unknown', formatLabel: 'TAE', extension: '.tae', compoundExtension: '.tae' }),
  // 问题4-D：长列表 fixture（213 个动画，超旧 ANIMATION_RENDER_LIMIT=200），
  // 驱动「动画列表全量渲染、栏内滚到最后一条」的 e2e 断言（硬规则 10 不许砍）。
  makeFile({ dir: 'action', name: 'c9999.tae', kind: 'action', formatKind: 'unknown', formatLabel: 'TAE', extension: '.tae', compoundExtension: '.tae' }),
  makeFile({ dir: 'ai', name: 'm10.aibnd.dcx', kind: 'ai', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.aibnd.dcx' }),
  makeFile({ dir: 'sfx', name: 'f0000.sfxbnd.dcx', kind: 'sfx', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.sfxbnd.dcx' }),
  makeFile({ dir: 'chr', name: 'sample.chrbnd.dcx', kind: 'chr', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.chrbnd.dcx' }),
  makeFile({ dir: 'other', name: 'notes.txt', kind: 'other', formatKind: 'text', formatLabel: 'TXT', extension: '.txt', compoundExtension: '.txt' }),
  // PARAM-10B fixture：legacy 路由 formatKind 'param' → param-container 工作台。
  // 目录形态对齐真实 gameparam（param/gameparam/gameparam.parambnd.dcx）。
  makeFile({ dir: 'param/gameparam', name: 'gameparam.parambnd.dcx', kind: 'param', formatKind: 'param', formatLabel: 'PARAM BND', extension: '.dcx', compoundExtension: '.parambnd.dcx' }),
  // GPARAM-11B fixture：三个 bank（两个可读 + 一个失败样本）。目录形态对齐
  // 真实 drawparam（param/drawparam/m10_00_0001.gparam.dcx）。
  makeFile({ dir: 'param/drawparam', name: 'm10_00.gparam.dcx', kind: 'param', formatKind: 'gparam', formatLabel: 'GPARAM', extension: '.dcx', compoundExtension: '.gparam.dcx' }),
  makeFile({ dir: 'param/drawparam', name: 'm11_00.gparam.dcx', kind: 'param', formatKind: 'gparam', formatLabel: 'GPARAM', extension: '.dcx', compoundExtension: '.gparam.dcx' }),
  makeFile({ dir: 'param/drawparam', name: 'broken.gparam.dcx', kind: 'param', formatKind: 'gparam', formatLabel: 'GPARAM', extension: '.dcx', compoundExtension: '.gparam.dcx' }),
  // unknown 不合并进 other：独立保留并在顶部栏显示警告计数。
  makeFile({ dir: '', name: 'regulation.bin', kind: 'unknown', formatKind: 'unknown', formatLabel: 'BIN', extension: '.bin', compoundExtension: '.bin' }),
  // SCRIPT-41 fixture：脚本容器。formatKind 用 'script'（不是 'bnd'），legacy
  // 推断才会命中 `.luabnd.dcx` → script 编辑器而不是 container。
  makeFile({ dir: 'script', name: 'm25_00_00_00.luabnd.dcx', kind: 'script', formatKind: 'script', formatLabel: 'SCRIPT BND', extension: '.dcx', compoundExtension: '.luabnd.dcx' }),
  // S16 独立脚本：单 Source、打开即反编译。
  makeFile({ dir: 'script', name: 'c0000_common.hks', kind: 'script', formatKind: 'script', formatLabel: 'HKS', extension: '.hks', compoundExtension: '.hks' }),
  // MAP-50B fixture：MSB 地图样本。基础 fixture 此前没有 map 文件，msb 工作台在
  // E2E 里进不去；这里补一个可被 readMsbDocument stub 命中的合成样本
  // （微小、合法构造、明确标记，AGENTS.md §15）。大工作区合成的 mXXXX 是 4 位补零，
  // m10.msb.dcx 不与它们重名，排序稳定。
  makeFile({ dir: 'map', name: 'm10.msb.dcx', kind: 'map', formatKind: 'msb', formatLabel: 'MSB', extension: '.dcx', compoundExtension: '.msb.dcx' }),
  // MODEL-51B fixture：FLVER 模型样本。此前没有 .flver 文件，flver 工作台在 E2E 里
  // 进不去；这里补一个可被 readFlverDocument stub 命中的合成样本（微小、合法构造、
  // 明确标记，AGENTS.md §15）。formatKind 'unknown' → selectEditor 走 legacy 路径按
  // .flver 后缀派发到 flver 编辑器（与 c0000.tae 同形态）。
  makeFile({ dir: 'chr', name: 'c1000.flver', kind: 'chr', formatKind: 'unknown', formatLabel: 'FLVER', extension: '.flver', compoundExtension: '.flver' }),
  // TEXTURE-52B fixture：TPF 纹理包样本。menu 目录形态对齐真实菜单纹理
  // （menu/start.tpf.dcx，52A 的「menu 下 .tpf.dcx 判 texture 而非 text」路由语义）。
  // formatKind 'tpf' → selectEditor legacy 路径命中 'tpf' 编辑器。broken 是读取失败
  // 样本（对照 Smithbox 的「失败即移除」，失败容器保留在列表并标记）。
  makeFile({ dir: 'menu', name: 'start.tpf.dcx', kind: 'menu', formatKind: 'tpf', formatLabel: 'TPF', extension: '.dcx', compoundExtension: '.tpf.dcx' }),
  makeFile({ dir: 'menu', name: 'broken.tpf.dcx', kind: 'menu', formatKind: 'tpf', formatLabel: 'TPF', extension: '.dcx', compoundExtension: '.tpf.dcx' }),
  // MATERIAL-53B fixture：MTD 材质样本。此前没有 .mtd 文件，material 工作台在 E2E
  // 里进不去；这里补一个可被 readMtdDocument stub 命中的合成样本（微小、合法构造、
  // 明确标记，AGENTS.md §15）。formatKind 'unknown' → selectEditor legacy 路径归到
  // binary，App 装配层的 .mtd 后缀补正把它接到 material 编辑器。
  makeFile({ dir: 'material', name: 'materials.mtd', kind: 'other', formatKind: 'unknown', formatLabel: 'MTD', extension: '.mtd', compoundExtension: '.mtd' }),
  // BEHAVIOR-55B fixture：ESD 状态机样本。此前没有 .esd 文件，esd 工作台在 E2E 里
  // 进不去；这里补一个可被 readEsdDocument stub 命中的合成样本（微小、合法构造、
  // 明确标记）。ai 目录形态对齐真实 ESD（ai/*.esd）。
  makeFile({ dir: 'ai', name: 'm10.esd', kind: 'ai', formatKind: 'unknown', formatLabel: 'ESD', extension: '.esd', compoundExtension: '.esd' }),
  // VFX-54B fixture：FXR3 特效样本。此前没有 .fxr 文件，vfx 工作台在 E2E 里
  // 进不去；这里补一个可被 readFxrDocument stub 命中的合成样本（微小、合法构造、
  // 明确标记）。formatKind 'unknown' → selectEditor legacy 路径归到 binary，
  // App 装配层的 .fxr 后缀补正把它接到 vfx 编辑器。
  makeFile({ dir: 'sfx', name: 'f0000.fxr', kind: 'sfx', formatKind: 'unknown', formatLabel: 'FXR', extension: '.fxr', compoundExtension: '.fxr' }),
  // T3 anibnd fixture：动作域侧栏（anibnd|tae）展示逻辑库，打开走 readTaeDocument
  // 提取通道（T3 规定 `*.anibnd.dcx` 走 TAE 读链，禁止落 BND4 通用容器页）。
  // formatKind 'bnd' 故意对齐真实 anibnd（DCX→BND4 容器）：selectEditor 的 T3 早返
  // 必须在 formatKind switch 之前拦截，否则 e2e 会观察到它误进容器页。
  makeFile({ dir: 'chr', name: 'c5030.anibnd.dcx', kind: 'action', formatKind: 'bnd', formatLabel: 'ANIBND', extension: '.dcx', compoundExtension: '.anibnd.dcx' })
];

/**
 * 合成 PARAM 容器样本（PARAM-10B）：微小、合法构造、明确标记（AGENTS.md §15）。
 *
 * 三张表共享同一行布局（u32 id @0 + 64 字节名字 @4 + u8 behavior @68），
 * 行宽 512 与 readParamDocument 的 fieldDefs 一致，字段解码才能命中。
 * BrokenParam 是局部失败样本：条目照常列出（对照 Smithbox 的「失败即移除」），
 * 但分页读取返回结构化失败，UI 必须保留条目并标记失败。
 */
const PARAM_ROW_SIZE = 512;
function makeParamRow(id, name, behaviorValue) {
  const buf = Buffer.alloc(PARAM_ROW_SIZE);
  buf.writeUInt32LE(id, 0);
  buf.write(name.slice(0, 63), 4, 'utf8');
  buf.writeUInt8(behaviorValue, 68);
  return { id, name, dataBase64: buf.toString('base64'), dataHash: `fixture-param-row-${id}` };
}

// 问题 5-E：生产 BehaviorParam 是 5275 行 / 221 字段，默认 fixture 最大 25 行 /
// 4 字段，用户报的「打开慢」「等待空白」在这个量级都不出现。这里提供
// SF_TEST_LARGE_PARAM=1 才启用的大表样本（合成、微小、明确标记，AGENTS.md §15）。
// id * 10 是故意的：筛选 id 子串才有非平凡命中。字段每 7 个挂一次 BEHAVIOR
// 枚举：全挂会把枚举成本放大成不真实的形态。
const LARGE_PARAM = process.env.SF_TEST_LARGE_PARAM === '1';
const LARGE_PARAM_ROW_COUNT = 5275;
const LARGE_PARAM_FIELD_COUNT = 221;
const LARGE_PARAM_FILLER_COUNT = 134;

function makeLargeParamRows() {
  return Array.from({ length: LARGE_PARAM_ROW_COUNT }, (_unused, index) =>
    makeParamRow(index * 10, `合成行-${index}`, index % 3)
  );
}

function makeLargeParamFieldDefs() {
  return Array.from({ length: LARGE_PARAM_FIELD_COUNT }, (_unused, index) => ({
    id: `lf_${index}`,
    name: `合成字段_${index}`,
    type: 'u8',
    offset: index,
    size: 1,
    description: `合成字段 ${index} 的说明文本（悬停可见）`,
    ...(index % 7 === 0 ? { enumRef: 'BEHAVIOR' } : {})
  }));
}
const paramTables = [
  {
    entryIndex: 0,
    name: 'ActionGuideParam',
    typeName: 'ACTION_GUIDE_PARAM_ST',
    rows: [
      makeParamRow(100, '引导-基础', 1),
      makeParamRow(101, '引导-交互', 2),
      makeParamRow(102, '引导-战斗', 0),
      makeParamRow(103, '引导-坠落', 1)
    ]
  },
  {
    entryIndex: 1,
    name: 'EquipParamWeapon',
    typeName: 'ACTION_GUIDE_PARAM_ST',
    rows: Array.from({ length: 25 }, (_, i) => makeParamRow(500 + i, `武器-${i + 1}`, i % 3))
  },
  { entryIndex: 2, name: 'BrokenParam', broken: true },
  // 问题 5-E 大表开关：默认关闭（默认套件左栏保持 3 项，现有 PARAM e2e 不
  // 变慢不变脆）。只在 param-perf.spec.mjs 自己的 env 里打开。
  ...(LARGE_PARAM
    ? [
        {
          entryIndex: 3,
          name: 'BehaviorParam',
          typeName: 'BEHAVIOR_PARAM_ST',
          rows: makeLargeParamRows(),
          fieldDefs: makeLargeParamFieldDefs()
        },
        ...Array.from({ length: LARGE_PARAM_FILLER_COUNT }, (_unused, index) => ({
          entryIndex: 4 + index,
          name: `FillerParam_${String(index).padStart(3, '0')}`,
          typeName: 'ACTION_GUIDE_PARAM_ST',
          rows: []
        }))
      ]
    : [])
];
const paramFieldDefsFixture = [
  { id: 'f_id', name: 'id', type: 'u32', offset: 0, size: 4 },
  { id: 'f_name', name: 'name', type: 's8', offset: 4, size: 64 },
  { id: 'f_behavior', name: 'behavior', type: 'u8', offset: 68, size: 1, enumRef: 'BEHAVIOR', description: '行为模式（引导/攻击/防御）' },
  // T5-5：Yapped overlay 覆盖出的中文字段名 + Description 悬停。offset 69 是
  // 512 字节行里未用区域（合成数据），不触碰真实布局。
  { id: 'f_atk', name: '攻击力', type: 'u8', offset: 69, size: 1, description: '基础攻击力（覆盖自 Yapped defs 的中文名）' }
];
const paramFieldEnumsFixture = [{
  id: 'BEHAVIOR',
  name: 'Behavior',
  values: [
    { value: 0, label: '无' },
    { value: 1, label: '攻击' },
    { value: 2, label: '防御' }
  ]
}];

/**
 * 大工作区 fixture（SF_TEST_LARGE_WORKSPACE=1 启用）。
 *
 * 为什么需要它：默认 fixture 只有 8 个文件，**低于分页页大小与搜索上限**，所以
 * 分页控件和截断说明在默认套件里根本不会出现——那等于这两条行为在 e2e 层零覆盖。
 * 这里构造 460 个合成条目（微小、显式构造、不含真实游戏资产，AGENTS.md §15），
 * 跨过 200/页 与搜索 60 条两个阈值，让「翻页真的换内容」「截断说明真的出现」
 * 可以被断言。
 */
const LARGE_WORKSPACE = process.env.SF_TEST_LARGE_WORKSPACE === '1';
const LARGE_FILE_COUNT = 460;

function makeLargeFixtureFiles() {
  return Array.from({ length: LARGE_FILE_COUNT }, (_unused, index) => makeFile({
    dir: 'map',
    // 序号补零：排序后页内顺序稳定，断言才能指名某一页的首项。
    name: `m${String(index).padStart(4, '0')}.msb.dcx`,
    kind: 'map',
    formatKind: 'msb',
    formatLabel: 'MSB',
    extension: '.dcx',
    compoundExtension: '.msb.dcx'
  }));
}

let crcTable = null;
/** PNG-32 CRC（Node 无内置；合成 fixture 预览需要真实 PNG 头才能被 img 解码）。 */
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 合成 RGBA 纯色 PNG 的 data URI（TEXTURE-52B 预览 stub 用，合法可被 <img> 解码）。 */
function makePngDataUri(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width * 4; x += 1) raw[rowStart + 1 + x] = 0x88;
  }
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const fixture = {
  workspaceUri: 'fixture://workspace/sekiro-test',
  fmg: {
    sourceHash: 'fixture-hash-0001',
    entries: [
      { id: 100, text: '伤药葫芦' },
      { id: 101, text: '返回骨片' }
    ],
    // 3-C：menu 容器里的一张长表（130 条 > 100，id 200–329）。含空槽
    //（i % 25 === 7 → text ''），供 e2e 验证「一次拿全 + 空槽 ID 在且文本 —」。
    // 只读样本，写链不需要路由它。
    longEntries: Array.from({ length: 130 }, (_, i) => ({
      id: 200 + i,
      text: i % 25 === 7 ? '' : `长文本 ${200 + i}`
    }))
  }
};

/** IPC 调用计数：测试经 app.evaluate(() => global.__fixtureIpcCalls) 读取。 */
global.__fixtureIpcCalls = Object.create(null);
function track(channel) {
  global.__fixtureIpcCalls[channel] = (global.__fixtureIpcCalls[channel] ?? 0) + 1;
}

/**
 * 受信任的 renderer 主文档地址：window.webContents.id -> 归一化后的 document URL。
 *
 * 与生产 main 的 trustedRendererDocuments 同语义。fixture 必须自己也走这道校验，
 * 否则 e2e 跑的是一个**没有安全层的** main —— 生产侧 assertTrustedSender
 * （ipc.ts 的 handle 包装器里，56 个 channel 的必经之路）在 e2e 中零覆盖，
 * 而它正是「渲染进程被导航到外部页面后不得继续调 IPC」这条边界的唯一执行点。
 */
const trustedRendererDocuments = new Map();

function normalizeRendererDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 与生产 ipc.ts:assertTrustedSender 逐条件对齐。
 *
 * 刻意不留「关闭校验」的环境变量开关：那种开关会成为绕过安全断言的后门，而
 * 后门存在本身就让「e2e 覆盖了安全层」这句话失效。做负向证明时临时改这个函数
 * 并在验证后还原（本轮已实测：临时放行后用例报 unexpectedly-allowed 并失败）。
 */
function assertTrustedSender(event, channel) {
  const expectedDocument = trustedRendererDocuments.get(event.sender.id);
  const frame = event.senderFrame;
  const actualDocument = frame ? normalizeRendererDocumentUrl(frame.url) : null;
  if (!expectedDocument
    || !frame
    || frame !== event.sender.mainFrame
    || actualDocument !== expectedDocument) {
    throw new Error(`已拒绝不受信任的 IPC 调用：${channel}`);
  }
}

/**
 * 注册 channel 的统一入口，镜像生产 ipc.ts 的 handle 包装器：
 * 先校验发送方，再执行 handler。
 *
 * 用包装器而不是在每个 handler 里手写校验：生产侧就是这个形态（一处包装、
 * 56 个 channel 必经），fixture 若逐个手写会漏，而漏掉的那个 channel 在 e2e
 * 里就成了「绕过安全层也能通」的样本。
 */
function handleTrusted(channel, listener) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    return listener(event, ...args);
  });
}

function registerFixtureIpc() {
  handleTrusted('workspace.openDialog', () => {
    track('workspace.openDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-overlay', label: 'fixture-overlay' };
  });

  handleTrusted('workspace.scan', () => {
    track('workspace.scan');
    const scanned = LARGE_WORKSPACE
      ? [...fixtureFiles, ...makeLargeFixtureFiles()]
      : fixtureFiles;
    return {
      workspaceSessionId: 'fixture-session',
      workspaceLabel: 'fixture-workspace',
      files: scanned.map((file) => ({ ...file })),
      countsByKind: {
        event: 2, map: (LARGE_WORKSPACE ? LARGE_FILE_COUNT : 0) + 1, param: 4, msg: 1, menu: 2, script: 1,
        action: 2, ai: 2, sfx: 2, chr: 2, obj: 0, other: 2, unknown: 1
      },
      diagnostics: [],
      session: {
        workspaceSessionId: 'fixture-session',
        workspaceLabel: 'fixture-workspace',
        game: 'sekiro',
        openedAt: new Date().toISOString(),
        baseMounted: false
      }
    };
  });

  handleTrusted('workspace.analyze', () => ({
    parsedFiles: fixtureFiles.length,
    inspectedFiles: fixtureFiles.length,
    referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 },
    diagnostics: [],
    events: [],
    tools: []
  }));

  handleTrusted('workspace.openBaseDialog', () => {
    track('workspace.openBaseDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-base', label: 'fixture-base' };
  });

  handleTrusted('resource.search', () => []);
  handleTrusted('resource.preview', () => null);

  // ── MSB 地图工作台（MAP-50B）合成通道 ──────────────────────────────────
  // 基础 fixture 没有 map 文件，readMsbDocument 从未被 stub——选中 map 文件会走
  // 真实 Bridge 读不存在的源文件，工作台永远停在「读不出来」。这里注册合成 DTO
  // （微小、合法构造、明确标记）：2 models / 3 parts / 2 regions / 1 event / 1 route，
  // 全部带 nativeOffset（id 稳定为 offset-<hex>），供 tree↔viewport↔inspector 联动断言。
  const fixtureMapUri = 'fixture://map/m10.msb.dcx';

  handleTrusted('resource.readMsbDocument', (_event, sourceUri) => {
    track('resource.readMsbDocument');
    if (sourceUri !== fixtureMapUri) {
      return {
        ok: false,
        diagnostics: [{ severity: 'error', code: 'MSB_NOT_REGISTERED', message: `fixture 未登记的 MSB：${sourceUri}` }]
      };
    }
    return {
      ok: true,
      data: {
        sourceHash: 'fixture-msb-hash-0001',
        version: 101,
        modelCount: 2,
        partCount: 3,
        regionCount: 2,
        eventCount: 1,
        routeCount: 1,
        models: [
          { name: 'c0000', nativeOffset: 0x10, typeId: 0 },
          { name: 'a0000', nativeOffset: 0x20, typeId: 1 }
        ],
        parts: [
          { name: 'p0000', nativeOffset: 0x30, typeId: 0, modelIndex: 0, posX: 0, posY: 0, posZ: 0, rotX: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
          { name: 'p0001', nativeOffset: 0x40, typeId: 0, modelIndex: 1, posX: 10, posY: 0, posZ: 0, rotX: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
          { name: 'p0002', nativeOffset: 0x50, typeId: 1, modelIndex: 0, posX: -5, posY: 2, posZ: 3, rotX: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }
        ],
        regions: [
          { name: 'r0000', nativeOffset: 0x60, typeId: 0, posX: 0, posY: 0, posZ: 0 },
          { name: 'r0001', nativeOffset: 0x70, typeId: 1, posX: 5, posY: 0, posZ: 5 }
        ],
        events: [
          { name: 'e0000', nativeOffset: 0x80, typeId: 0, eventId: 100 }
        ],
        routes: [
          { name: 'route0000', nativeOffset: 0x90, typeId: 0, id: 42 }
        ]
      },
      diagnostics: []
    };
  });

  // ── FLVER 模型工作台（MODEL-51B）合成通道 ──────────────────────────────
  // 基础 fixture 此前没有 .flver 文件，readFlverDocument 从未被 stub——选中 flver
  // 文件会走真实 Bridge 读不存在的源文件，工作台永远停在「读不出来」。这里注册
  // 合成 envelope（微小、合法构造、明确标记）：2 meshes / 1 material / 2 texture
  // slots / 2 bones，全部带 index，供 tree↔viewport↔inspector 联动断言。
  const fixtureFlverUri = 'fixture://chr/c1000.flver';

  handleTrusted('resource.readFlverDocument', (_event, sourceUri) => {
    track('resource.readFlverDocument');
    if (sourceUri !== fixtureFlverUri) {
      return {
        ok: false,
        diagnostics: [{ severity: 'error', code: 'FLVER_NOT_REGISTERED', message: `fixture 未登记的 FLVER：${sourceUri}` }]
      };
    }
    return {
      ok: true,
      data: {
        format: 'FLVER',
        version: 'L',
        internalVersion: '0x2001A',
        sourceSize: 4096,
        sourceHash: 'fixture-flver-hash-0001',
        skeletonTransformCount: 2,
        materialCount: 1,
        boneCount: 2,
        vertexBufferCount: 1,
        meshCount: 2,
        faceSetCount: 2,
        bufferLayoutCount: 1,
        textureCount: 2,
        faceCount: 24,
        totalFaceCount: 24,
        vertexStride: 40,
        vertexStrides: [40],
        unicode: false,
        boundingBox: { min: [0, 0, 0], max: [10, 20, 30] },
        materials: [
          { name: 'mat_a', mtdPath: 'mtd/m_a.mtd', textureCount: 2, flags: 0, gxOffset: 0, unk18: 0, gxList: null }
        ],
        materialsTruncated: false,
        bones: [
          { name: 'root', parentIndex: -1, nextSiblingIndex: -1 },
          { name: 'hand', parentIndex: 0, nextSiblingIndex: -1 }
        ],
        bonesTruncated: false,
        meshes: [
          { index: 0, dynamic: 0, materialIndex: 0, defaultBoneIndex: 0, vertexCount: 10, vertexStride: 40, bufferLayoutIndex: 0, faceSetCount: 1, boneCount: 2, indexFormat: 16 },
          { index: 1, dynamic: 0, materialIndex: 0, defaultBoneIndex: 0, vertexCount: 6, vertexStride: 40, bufferLayoutIndex: 0, faceSetCount: 1, boneCount: 2, indexFormat: 16 }
        ],
        meshesTruncated: false,
        bufferLayouts: [],
        textureSlots: [
          { index: 0, type: 'g', path: 'tex/a.dds', materialIndex: 0 },
          { index: 1, type: 'g', path: 'tex/b.dds', materialIndex: 0 }
        ],
        texturesTruncated: false,
        layoutWarnings: [],
        unparsedGaps: [],
        roundTrip: {
          byteIdentical: true, semanticIdentical: true,
          sourceHash: 'fixture-flver-hash-0001', rebuiltHash: 'fixture-flver-hash-0001',
          skeletonTransformCount: 2, materialCount: 1, boneCount: 2, meshCount: 2
        },
        authority: 'native-verified'
      },
      diagnostics: []
    };
  });

  // FlverViewer 在 sourceUri/meshIndex 变化时并行读 mesh/skeleton/dummies；
  // 不 stub 会走真实 Bridge 报「未登记」。返回合成基元（3 顶点三角形），
  // 让 viewport 渲染语义场景且 selection summary 有真实 mesh 数据可依赖。
  handleTrusted('resource.readFlverMesh', (_event, sourceUri, meshIndex) => {
    track('resource.readFlverMesh');
    const floats = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const buf = Buffer.alloc(floats.length * 4);
    floats.forEach((v, i) => buf.writeFloatLE(v, i * 4));
    return {
      ok: true,
      data: {
        meshIndex,
        vertexCount: 3,
        vertexStride: 12,
        bufferLayoutIndex: 0,
        materialIndex: 0,
        indexFormat: 16,
        positionsBase64: buf.toString('base64'),
        indicesBase64: null,
        uvsBase64: null,
        normalsBase64: null,
        boneWeightsBase64: null,
        boneIndicesBase64: null
      },
      diagnostics: []
    };
  });

  handleTrusted('resource.readFlverSkeleton', () => {
    track('resource.readFlverSkeleton');
    return {
      ok: true,
      data: {
        boneCount: 2,
        bones: [
          { index: 0, name: 'root', parentIndex: -1, nextSiblingIndex: -1, translation: [0, 0, 0], rotation: [0, 0, 0] },
          { index: 1, name: 'hand', parentIndex: 0, nextSiblingIndex: -1, translation: [0, 1, 0], rotation: [0, 0, 0] }
        ]
      },
      diagnostics: []
    };
  });

  handleTrusted('resource.readFlverDummies', () => {
    track('resource.readFlverDummies');
    return { ok: true, data: { dummyCount: 0, dummies: [] }, diagnostics: [] };
  });

  handleTrusted('resource.readFlverTextureSlots', (_event, sourceUri) => {
    track('resource.readFlverTextureSlots');
    return {
      ok: true,
      data: {
        textureCount: 2,
        textures: [
          { index: 0, type: 'g', path: 'tex/a.dds', materialIndex: 0 },
          { index: 1, type: 'g', path: 'tex/b.dds', materialIndex: 0 }
        ]
      },
      diagnostics: []
    };
  });

  // ── PARAM 容器工作台（PARAM-10B）合成通道 ──────────────────────────────
  const fixtureParamUri = 'fixture://param/gameparam/gameparam.parambnd.dcx';

  handleTrusted('resource.listContainerParams', (_event, containerUri) => {
    track('resource.listContainerParams');
    if (containerUri !== fixtureParamUri) {
      return {
        ok: false, containerUri, params: [],
        diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}` }]
      };
    }
    return {
      ok: true,
      containerUri,
      containerFormat: 'bnd4',
      params: paramTables.map((t) => ({ entryIndex: t.entryIndex, name: t.name, size: 4096 })),
      diagnostics: []
    };
  });

  handleTrusted('resource.readContainerParamRowIndex', async (_event, containerUri, entryIndex) => {
    track('resource.readContainerParamRowIndex');
    // 与旧分页等待测试同口径：延迟只由测试 env 打开，用来观察索引首屏的加载反馈。
    const delayMs = Number(process.env.SF_TEST_PARAM_READ_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
    const failure = (message, code) => ({
      ok: false,
      containerUri,
      entryIndex,
      paramName: null,
      typeName: null,
      rowDataSize: 0,
      rowCount: 0,
      rows: [],
      rowsTruncated: false,
      containerHash: null,
      childHash: null,
      diagnostics: [{ severity: 'error', code, message, containerUri }]
    });
    if (containerUri !== fixtureParamUri) {
      return failure(`fixture 未登记的容器：${containerUri}`, 'CONTAINER_NOT_FOUND');
    }
    const table = paramTables.find((t) => t.entryIndex === entryIndex);
    if (!table || table.broken) {
      return failure('BrokenParam 是 fixture 的失败样本：字段层读取失败。', 'PARAM_READ_FAILED');
    }
    const rows = table.rows.map((row, rowIndex) => ({
      rowIndex,
      id: row.id,
      name: row.name,
      dataHash: row.dataHash
    }));
    return {
      ok: true,
      containerUri,
      entryIndex,
      paramName: table.name,
      typeName: table.typeName,
      rowDataSize: PARAM_ROW_SIZE,
      rowCount: rows.length,
      rows,
      rowsTruncated: false,
      containerHash: 'fixture-container-hash',
      childHash: `fixture-child-hash-${entryIndex}`,
      sessionToken: `fixture-param-session-${entryIndex}`,
      authority: 'fixture',
      diagnostics: []
    };
  });

  handleTrusted('resource.readContainerParamPage', async (_event, containerUri, entryIndex, page, pageSize, query, loadAll, documentSessionToken) => {
    track('resource.readContainerParamPage');
    // 问题 5-E：SF_TEST_PARAM_READ_DELAY_MS 只在 spec 自己的 env 里设，用来
    // 稳定复现「打开大表后、行出来之前」的等待窗口（默认 fixture 73ms 就答完，
    // 加载指示器那条测试抢不到那一帧）。
    const delayMs = Number(process.env.SF_TEST_PARAM_READ_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
    const failure = (message, code) => ({
      ok: false,
      containerUri, entryIndex, page: 0, pageSize: 0, pageCount: 0,
      rows: [], rowCount: 0, sourceHash: null, typeName: null, rowDataSize: 0,
      paramName: null, containerHash: null, childHash: null,
      diagnostics: [{ severity: 'error', code, message, containerUri }]
    });
    if (containerUri !== fixtureParamUri) {
      return failure(`fixture 未登记的容器：${containerUri}`, 'CONTAINER_NOT_FOUND');
    }
    const table = paramTables.find((t) => t.entryIndex === entryIndex);
    if (!table || table.broken) {
      return failure('BrokenParam 是 fixture 的失败样本：字段层读取失败。', 'PARAM_READ_FAILED');
    }
    if (loadAll !== true && documentSessionToken !== `fixture-param-session-${entryIndex}`) {
      return failure('容器 PARAM 分页缺少或使用了错误的 native session token。', 'PARAM_DOCUMENT_SESSION_MISSING');
    }
    const indexedRows = table.rows.map((row, rowIndex) => ({ ...row, rowIndex }));
    const needle = (query ?? '').trim().toLowerCase();
    const filtered = needle
      ? indexedRows.filter((r) => String(r.id).includes(needle) || (r.name ?? '').toLowerCase().includes(needle))
      : indexedRows;
    // 用户裁定（2026-08-14）：loadAll=true 时一次返回全部行（含字节），
    // 与生产 main 的 includeAllPayloads 全量路径同语义。
    if (loadAll === true) {
      return {
        ok: true,
        containerUri, entryIndex, page: 0, pageSize: filtered.length, pageCount: 1,
        rows: filtered.map((r) => ({ rowIndex: r.rowIndex, id: r.id, name: r.name, dataBase64: r.dataBase64, dataHash: r.dataHash })),
        rowCount: filtered.length,
        sourceHash: 'fixture-param-container-hash',
        typeName: table.typeName,
        rowDataSize: PARAM_ROW_SIZE,
        paramName: table.name,
        containerHash: 'fixture-container-hash',
        childHash: `fixture-child-hash-${entryIndex}`,
        sessionToken: `fixture-param-session-${entryIndex}`,
        // P1：字段定义随容器 PARAM 下发（与生产 main 的 resolveTrustedParamDefinition
        // 同字段面；fixture 统一用合成定义，明确标记 synthetic）。
        // 大表用表自己的 221 字段定义：回落到默认 4 个就测不出字段栏成本。
        fieldDefs: table.fieldDefs ?? paramFieldDefsFixture,
        fieldEnums: paramFieldEnumsFixture,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: 'fixture',
        fieldDefsTrusted: false,
        diagnostics: []
      };
    }
    const size = pageSize > 0 ? pageSize : 20;
    const pageCount = Math.max(1, Math.ceil(filtered.length / size));
    const p = Math.min(Math.max(0, page), pageCount - 1);
    const slice = filtered.slice(p * size, p * size + size);
    return {
      ok: true,
      containerUri, entryIndex, page: p, pageSize: size, pageCount,
      rows: slice.map((r) => ({ rowIndex: r.rowIndex, id: r.id, name: r.name, dataBase64: r.dataBase64, dataHash: r.dataHash })),
      rowCount: filtered.length,
      sourceHash: 'fixture-param-container-hash',
      typeName: table.typeName,
      rowDataSize: PARAM_ROW_SIZE,
      paramName: table.name,
      containerHash: 'fixture-container-hash',
      childHash: `fixture-child-hash-${entryIndex}`,
      sessionToken: `fixture-param-session-${entryIndex}`,
      // 与 loadAll=true 保持同一字段定义契约：Fields 栏的按需 payload
      // 路径也必须携带当前表的 221 字段定义，否则选中行后只会看到空栏。
      fieldDefs: table.fieldDefs ?? paramFieldDefsFixture,
      fieldEnums: paramFieldEnumsFixture,
      fieldDefsDiagnostic: null,
      fieldDefsOrigin: 'fixture',
      fieldDefsTrusted: false,
      diagnostics: []
    };
  });

  // App 的 loadParam 会以容器 URI 调 readParamDocument（合成文档：容器不解包，
  // fixture 直接给出一份与 paramTables[0] 同布局的文档，让字段定义可用）。
  handleTrusted('resource.readParamDocument', (_event, sourceUri) => {
    track('resource.readParamDocument');
    if (sourceUri !== fixtureParamUri) {
      return {
        ok: false, sourceUri, relativePath: sourceUri,
        fieldDefs: null, fieldEnums: null, fieldDefsDiagnostic: null,
        fieldDefsOrigin: null, fieldDefsTrusted: false, rows: [],
        diagnostics: [{ severity: 'error', code: 'RESOURCE_NOT_INDEXED', message: `fixture 未登记资源：${sourceUri}` }]
      };
    }
    return {
      ok: true,
      sourceUri,
      relativePath: 'param/gameparam/gameparam.parambnd.dcx',
      fieldDefs: paramFieldDefsFixture,
      fieldEnums: paramFieldEnumsFixture,
      fieldDefsDiagnostic: null,
      fieldDefsOrigin: 'fixture',
      fieldDefsTrusted: false,
      data: {
        sourceHash: 'fixture-param-hash',
        typeName: paramTables[0].typeName,
        rowCount: paramTables[0].rows.length,
        rowDataSize: PARAM_ROW_SIZE,
        rows: paramTables[0].rows.map((r) => ({ id: r.id, dataBase64: r.dataBase64, dataHash: r.dataHash, name: r.name })),
        rowsTruncated: false,
        authority: 'fixture'
      },
      diagnostics: []
    };
  });

  // T5-3/T5-6：容器内 PARAM 行名提交。fixture 走合成内存态（就地改名，重读即见
  // 新值），不真写盘 —— 与 GPARAM 的 synthetic 内存态（L816）同一套约定。
  handleTrusted('resource.applyContainerParamRowNameMutation', (_event, containerUri, _expectedContainerHash, mutation) => {
    track('resource.applyContainerParamRowNameMutation');
    if (containerUri !== fixtureParamUri) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}`, containerUri }]
      };
    }
    const table = paramTables.find((t) => t.entryIndex === mutation?.entryIndex);
    const row = table?.rows.find((r) => r.id === mutation?.rowId);
    if (!table || !row) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_NOT_FOUND', message: `fixture 找不到行 ${mutation?.rowId}。`, containerUri }]
      };
    }
    row.name = mutation.name;
    return {
      ok: true,
      changedFiles: [{ sourceUri: containerUri, sourcePath: 'param/gameparam/gameparam.parambnd.dcx', changed: true }],
      diagnostics: []
    };
  });

  // 问题 4：容器内 PARAM 行级写入（新建行/复制当前行/删除当前行）。fixture 走
  // 合成内存态：就地增删 paramTables 行的 rows，重读即见 —— 与行名/CSV 的
  // fixture 同一套约定（不真写盘）。
  handleTrusted('resource.applyContainerParamRowMutations', (_event, containerUri, _expectedContainerHash, mutation) => {
    track('resource.applyContainerParamRowMutations');
    if (containerUri !== fixtureParamUri) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}`, containerUri }]
      };
    }
    const table = paramTables.find((t) => t.entryIndex === mutation?.entryIndex);
    const kind = mutation?.kind;
    if (!table || !table.rows || !['add', 'copy', 'delete'].includes(kind)) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'PARAM_ROW_MUTATION_INVALID', message: 'fixture 行级写入目标无效。', containerUri }]
      };
    }
    if (kind === 'delete') {
      const before = table.rows.length;
      table.rows = table.rows.filter((r) => r.id !== mutation.rowId);
      if (table.rows.length === before) {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'PARAM_ROW_NOT_FOUND', message: `fixture 找不到行 ${mutation.rowId}。`, containerUri }]
        };
      }
    } else {
      table.rows.push({
        id: mutation.rowId,
        name: '',
        dataBase64: mutation.rowDataBase64,
        dataHash: `fixture-param-row-${mutation.rowId}`
      });
    }
    return {
      ok: true,
      changedFiles: [{ sourceUri: containerUri, sourcePath: 'param/gameparam/gameparam.parambnd.dcx', changed: true }],
      diagnostics: []
    };
  });

  // T5-4/T5-6：CSV 导入导出。fixture 不真开对话框、不写盘，返回成功诊断；
  // 渲染器 footer 据此显示「操作完成」类文案（与生产 RendererSaveResult 同面）。
  function csvOk(code, message) {
    return { ok: true, changedFiles: [], diagnostics: [{ severity: 'info', code, message, containerUri: fixtureParamUri }] };
  }
  function tableLabel(entryIndex) {
    const table = paramTables.find((t) => t.entryIndex === entryIndex);
    return table ? `${table.name}（${table.rows.length} 行）` : `entry ${entryIndex}`;
  }
  handleTrusted('param.exportRowsCsv', (_event, containerUri, _expectedContainerHash, entryIndex) => {
    track('param.exportRowsCsv');
    if (containerUri !== fixtureParamUri) {
      return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}`, containerUri }] };
    }
    return csvOk('PARAM_EXPORT_ROWS_OK', `fixture 导出 ${tableLabel(entryIndex)}行数据。`);
  });
  handleTrusted('param.exportNamesCsv', (_event, containerUri, _expectedContainerHash, entryIndex) => {
    track('param.exportNamesCsv');
    if (containerUri !== fixtureParamUri) {
      return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}`, containerUri }] };
    }
    return csvOk('PARAM_EXPORT_NAMES_OK', `fixture 导出 ${tableLabel(entryIndex)}行名。`);
  });
  handleTrusted('param.importNamesCsv', (_event, containerUri, _expectedContainerHash, entryIndex, _expectedChildHash) => {
    track('param.importNamesCsv');
    if (containerUri !== fixtureParamUri) {
      return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}`, containerUri }] };
    }
    return csvOk('PARAM_IMPORT_NAMES_OK', `fixture 导入 ${tableLabel(entryIndex)}行名完成。`);
  });
  handleTrusted('param.importRowsCsv', (_event, containerUri, _expectedContainerHash, entryIndex, _expectedChildHash) => {
    track('param.importRowsCsv');
    if (containerUri !== fixtureParamUri) {
      return { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'CONTAINER_NOT_FOUND', message: `fixture 未登记的容器：${containerUri}`, containerUri }] };
    }
    return csvOk('PARAM_IMPORT_ROWS_OK', `fixture 导入 ${tableLabel(entryIndex)}行数据完成。`);
  });

  // ── GPARAM 工作台（GPARAM-11B）合成通道 ────────────────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。两个可读 bank 各含 2 个 group、
  // 不同值类型（float3 / int / float2），一个失败样本（broken）。
  const fixtureGparamBanks = {
    'fixture://param/drawparam/m10_00.gparam.dcx': {
      groups: [
        {
          groupId: 0, name1: 'LightSet ParamEditor', name2: 'LightSet',
          paramCount: 2, comments: [], paramPreviewLimit: 50,
          params: [
            {
              paramId: 0, name1: 'Directional Light Angle0', name2: 'Angle',
              type: 'float3', typeCode: 6, valueCount: 2,
              values: [1.25, 0.5, 0.75, 2.0, 0.1, 0.2],
              valueIds: [11, 12], unkFloats: [0, 0]
            },
            {
              paramId: 1, name1: 'Fog Enable', name2: 'Enable',
              type: 'bool', typeCode: 5, valueCount: 1,
              values: [1], valueIds: [21], unkFloats: [0]
            }
          ]
        },
        {
          groupId: 1, name1: 'Shadows ParamEditor', name2: 'Shadows',
          paramCount: 1, comments: ['shadow distance'], paramPreviewLimit: 50,
          params: [
            {
              paramId: 0, name1: 'Shadow Distance', name2: 'Distance',
              type: 'float', typeCode: 4, valueCount: 1,
              values: [42.5], valueIds: [31], unkFloats: [0]
            }
          ]
        }
      ],
      roundTrip: {
        byteIdentical: true, semanticIdentical: true,
        sourceHash: 'fixture-gparam-m10', rebuiltHash: 'fixture-gparam-m10',
        groupCount: 2, paramCount: 3, valueCount: 4, note: null
      }
    },
    'fixture://param/drawparam/m11_00.gparam.dcx': {
      groups: [
        {
          groupId: 0, name1: 'Camera ParamEditor', name2: 'Camera',
          paramCount: 2, comments: [], paramPreviewLimit: 50,
          params: [
            {
              paramId: 0, name1: 'FOV Horizontal', name2: 'FOV',
              type: 'float2', typeCode: 6, valueCount: 1,
              values: [60, 75], valueIds: [41], unkFloats: [0]
            },
            {
              paramId: 1, name1: 'Near Clip', name2: 'Near',
              type: 'float', typeCode: 4, valueCount: 1,
              values: [0.1], valueIds: [42], unkFloats: [0]
            }
          ]
        }
      ],
      roundTrip: {
        byteIdentical: true, semanticIdentical: true,
        sourceHash: 'fixture-gparam-m11', rebuiltHash: 'fixture-gparam-m11',
        groupCount: 1, paramCount: 2, valueCount: 2, note: null
      }
    }
  };

  handleTrusted('resource.readGparamDocument', (_event, sourceUri) => {
    track('resource.readGparamDocument');
    const bank = fixtureGparamBanks[sourceUri];
    if (!bank) {
      // broken.gparam.dcx 等未登记样本：结构化失败，绝不能显示为空 bank。
      return {
        ok: false, sourceUri,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'GPARAM_DOCUMENT_READ_FAILED',
          message: 'fixture 未登记或损坏的 GPARAM：读取失败。', sourceUri
        }]
      };
    }
    return {
      ok: true, sourceUri,
      data: {
        format: 'GPARAM', game: 'sekiro', gameCode: 5,
        groupCount: bank.groups.length,
        unk14: 0, unk50: 0, unk0D: false, unk3Count: 0,
        sourceSize: 2048, sourceHash: bank.roundTrip.sourceHash,
        groups: bank.groups,
        groupPage: 0, groupPageSize: 50, groupPageCount: 1,
        groupsTruncated: false,
        roundTrip: bank.roundTrip,
        authority: 'fixture',
        fieldLayout: 'typed-gparam-values'
      },
      diagnostics: []
    };
  });

  // GPARAM-11C：typed field-set 写回（合成内存态，明确标记 synthetic）。
  // 登记 bank：逐条校验 mutation 定位并就地更新值（重读即看到新值）；
  // 未登记/越界/空 mutations：结构化失败，绝不静默成功。
  handleTrusted('resource.commitGparamMutations', (_event, sourceUri, expectedDocumentHash, mutations) => {
    track('resource.commitGparamMutations');
    const bank = fixtureGparamBanks[sourceUri];
    if (!bank) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error', code: 'GPARAM_STAGING_WRITE_FAILED',
          message: 'fixture 未登记或损坏的 GPARAM：拒绝写入。', sourceUri
        }]
      };
    }
    if (expectedDocumentHash !== bank.roundTrip.sourceHash) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error', code: 'GPARAM_STAGING_WRITE_FAILED',
          message: 'GPARAM source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri
        }]
      };
    }
    if (!Array.isArray(mutations) || mutations.length === 0) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error', code: 'GPARAM_MUTATIONS_REQUIRED',
          message: 'GPARAM typed write 需要至少一条 mutation。', sourceUri
        }]
      };
    }
    const comps = (type) => ({ float2: 2, float3: 3, float4: 4, byte4: 4 }[type] ?? 1);
    for (const m of mutations) {
      const group = bank.groups.find((g) => g.groupId === m.groupId);
      const param = group && group.params.find((p) => p.paramId === m.paramId);
      const count = param ? param.valueCount * comps(param.type) : 0;
      if (!param || m.valueIndex < 0 || m.valueIndex >= count) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error', code: 'GPARAM_STAGING_WRITE_FAILED',
            message: `fixture mutation 越界：group ${m.groupId} param ${m.paramId} valueIndex ${m.valueIndex}。`,
            sourceUri
          }]
        };
      }
      param.values[m.valueIndex] = m.value; // 就地更新：重读即看到新值（synthetic 内存态）
    }
    return {
      ok: true,
      sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{ severity: 'info', code: 'GPARAM_STAGING_WRITE_VERIFIED', message: 'fixture GPARAM 已写入（合成）并重读验证。', sourceUri }]
    };
  });

  // ── TEXTURE-52B：TPF 纹理工作台合成通道 ──────────────────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。一个可读容器（start）含 3 张纹理：
  // 纹理 0/1 可预览（受界 512 下采样，原始尺寸经 sourceWidth/sourceHeight 上报），
  // 纹理 2 是预览失败样本（对应真实里不可解码的纹理，驱动 preview failure
  // isolation）；broken 容器是读取失败样本（保留在列表并标记，不能显示为空包）。
  const fixtureTpfContainers = {
    'fixture://menu/start.tpf.dcx': {
      sourceHash: 'fixture-tpf-start',
      textures: [
        { index: 0, name: 'm_00_title', format: 'BC1', formatByte: 0x00, mipCount: 8, dataOffset: 0x40, dataSize: 1048576, width: 512, height: 512, ddsFourCC: 'DX10' },
        { index: 1, name: 'm_01_icon', format: 'BC4', formatByte: 0x67, mipCount: 6, dataOffset: 0x100040, dataSize: 524288, width: 256, height: 256, ddsFourCC: 'ATI1' },
        { index: 2, name: 'm_02_hud', format: 'BC1', formatByte: 0x00, mipCount: 8, dataOffset: 0x180040, dataSize: 2048, width: 4, height: 4, ddsFourCC: 'DX10' }
      ]
    }
  };

  handleTrusted('resource.readTpfDocument', (_event, sourceUri) => {
    track('resource.readTpfDocument');
    const container = fixtureTpfContainers[sourceUri];
    if (!container) {
      // broken.tpf.dcx 等未登记样本：结构化失败，绝不能显示为空包。
      return {
        ok: false, sourceUri,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'TPF_DOCUMENT_READ_FAILED',
          message: 'fixture 未登记或损坏的 TPF：读取失败。', sourceUri
        }]
      };
    }
    return {
      ok: true, sourceUri,
      data: {
        format: 'TPF', game: 'sekiro', gameCode: 5,
        sourceSize: 2048, sourceHash: container.sourceHash,
        textureCount: container.textures.length,
        platform: 1, encoding: 0, flags: 0,
        textures: container.textures,
        roundTrip: {
          byteIdentical: true, semanticIdentical: true,
          sourceHash: container.sourceHash, rebuiltHash: container.sourceHash,
          textureCount: container.textures.length
        },
        rebuildCoverage: { uncoveredBytes: 0, uncoveredNonZeroBytes: 0, firstNonZeroOffset: -1 },
        authority: 'fixture'
      },
      diagnostics: []
    };
  });

  // TPF-55C：纹理替换写回（合成内存态，明确标记 synthetic）。
  // textureIndex 越界拒绝；base64 仅验证非空透传（真实 C# 校验 dimensions/format/
  // color-space/mipmap 与源一致，不匹配则 TPF_STAGING_WRITE_FAILED）。fixture 不
  // 建模像素数据，替换只验证边界与链路，不做模拟解码。
  handleTrusted('resource.saveTpfTextureReplace', (_event, sourceUri, expectedDocumentHash, textureIndex, textureDataBase64) => {
    track('resource.saveTpfTextureReplace');
    const container = fixtureTpfContainers[sourceUri];
    if (!container) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TPF_STAGING_WRITE_FAILED', message: 'fixture 未登记或损坏的 TPF：拒绝写入。', sourceUri }]
      };
    }
    if (expectedDocumentHash !== container.sourceHash) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TPF_STAGING_WRITE_FAILED', message: 'TPF source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri }]
      };
    }
    const tex = container.textures.find((t) => t.index === textureIndex);
    if (!tex) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TPF_STAGING_WRITE_FAILED', message: `fixture TPF 纹理越界：textureIndex ${textureIndex}。`, sourceUri }]
      };
    }
    if (typeof textureDataBase64 !== 'string' || textureDataBase64.length === 0) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TPF_STAGING_WRITE_FAILED', message: 'fixture TPF 替换载荷为空：拒绝写入。', sourceUri }]
      };
    }
    return {
      ok: true, sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{ severity: 'info', code: 'TPF_STAGING_WRITE_VERIFIED', message: 'fixture TPF 纹理替换已接受（合成）。', sourceUri }]
    };
  });

  handleTrusted('resource.readTpfTexturePreview', (_event, sourceUri, textureIndex) => {
    track('resource.readTpfTexturePreview');
    const container = fixtureTpfContainers[sourceUri];
    const tex = container && container.textures.find((t) => t.index === textureIndex);
    if (!container || !tex) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error', code: 'TPF_TEXTURE_PREVIEW_FAILED',
          message: 'fixture 未登记或越界的纹理：预览失败。', sourceUri
        }]
      };
    }
    if (textureIndex === 2) {
      // m_02_hud：预览失败样本（真实里不可解码的纹理）。纹理列表保留、选择链
      // 不清空，Viewer 栏独立给出结构化诊断。
      return {
        ok: false,
        diagnostics: [{
          severity: 'error', code: 'TPF_TEXTURE_PREVIEW_FAILED',
          message: '纹理不可解码，无法生成预览。', sourceUri
        }]
      };
    }
    return {
      ok: true,
      data: {
        textureIndex,
        name: tex.name,
        width: Math.min(tex.width, 512),
        height: Math.min(tex.height, 512),
        sourceWidth: tex.width,
        sourceHeight: tex.height,
        colorSpace: 'srgb',
        mediaType: 'image/png',
        byteLength: 4096,
        previewToken: makePngDataUri(Math.max(1, Math.min(tex.width, 512)), Math.max(1, Math.min(tex.height, 512)))
      },
      diagnostics: []
    };
  });

  // ── MATERIAL-53B：Material 工作台合成通道 ────────────────────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。一个可读 MTD：3 个属性（含一个带
  // 未识别属性 unkAttr 的 UnknownParam，驱动 unknown readonly 断言）＋ 1 个纹理
  // 引用。authority 'partial'：unparsedGaps 非空，gap 区段必须可见。未登记样本
  // 结构化失败，绝不显示为空文档。
  const fixtureMtdDocs = {
    'fixture://material/materials.mtd': {
      format: 'MTD-XML',
      formatId: 'mtd',
      sourceSize: 2048,
      sourceHash: 'fixture-mtd-hash-0001',
      rootElement: 'material',
      name: 'm_test_material',
      version: '1.0',
      header: null,
      shaderPath: 'shader/standard.mtdshader',
      materialCount: 1,
      properties: [
        { id: 'p1', type: 'float', name: 'DiffuseIntensity', value: '0.8' },
        { id: 'p2', type: 'texture', name: 'BaseColorMap', value: 'tex/base.dds' },
        { id: 'p3', type: 'float', name: 'UnknownParam', value: '1.0', unknown: { unkAttr: '0x2a' } }
      ],
      propertiesTruncated: false,
      textureRefs: [{ path: 'tex/base.dds', type: 'g', name: 'BaseColorMap' }],
      textureRefsTruncated: false,
      unparsedGaps: ['param UnknownParam 的未识别属性 unkAttr'],
      layoutWarnings: [],
      roundTrip: {
        consistent: true,
        sourceHash: 'fixture-mtd-hash-0001',
        reparsedHash: 'fixture-mtd-hash-0001',
        paramCount: 3,
        textureRefCount: 1,
        note: null
      },
      authority: 'partial'
    }
  };

  handleTrusted('resource.readMtdDocument', (_event, sourceUri) => {
    track('resource.readMtdDocument');
    const doc = fixtureMtdDocs[sourceUri];
    if (!doc) {
      return {
        ok: false,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'MTD_DOCUMENT_READ_FAILED',
          message: 'fixture 未登记或损坏的 MTD：读取失败。', sourceUri
        }]
      };
    }
    return { ok: true, data: { ...doc }, diagnostics: [] };
  });

  // MATERIAL-53C：MTD typed property-set 写回（合成内存态，明确标记 synthetic）。
  // 就地更新已登记属性（p1/p2 可写；p3 UnknownParam 是 unknown——production 侧
  // unknown 不可写，fixture 同样拒绝）→ 重读即看到新值；未登记/unknown/漂移：
  // 结构化失败，绝不静默成功。
  handleTrusted('resource.commitMtdPropertySet', (_event, sourceUri, expectedDocumentHash, set) => {
    track('resource.commitMtdPropertySet');
    const doc = fixtureMtdDocs[sourceUri];
    if (!doc) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'MTD_STAGING_WRITE_FAILED', message: 'fixture 未登记或损坏的 MTD：拒绝写入。', sourceUri }]
      };
    }
    if (expectedDocumentHash !== doc.sourceHash) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'MTD_STAGING_WRITE_FAILED', message: 'MTD source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri }]
      };
    }
    const prop = doc.properties.find((p) => p.id === set?.paramId);
    if (!prop || prop.unknown) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: `fixture MTD 属性不可写：paramId ${set?.paramId}（未登记或 unknown）。`, sourceUri }]
      };
    }
    prop.value = String(set.newValue ?? '');
    return {
      ok: true, sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{ severity: 'info', code: 'MTD_STAGING_WRITE_VERIFIED', message: 'fixture MTD 属性已写入（合成）并重读验证。', sourceUri }]
    };
  });

  // ── VFX-54B：VFX 工作台合成通道 ──────────────────────────────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。一个可读 FXR：Effect 节点树含已知
  // typeId 2000 / 2200 与一个未知节点 9999（驱动 known/unknown 断言）、1 个已知
  // host（typeId 0）与 1 个未知 host（typeId 7777）、1 个属性（typeId 3）。
  // authority 'partial'：unparsedGaps 非空（section11 无 schema + 未知类型），
  // 缺口必须可见。未登记样本结构化失败，绝不显示为空文档。
  const fixtureFxrDocs = {
    'fixture://sfx/f0000.fxr': {
      format: 'FXR3',
      formatId: 'fxr',
      version: 5,
      sourceSize: 4096,
      sourceHash: 'fixture-fxr-hash-0001',
      resourceId: 0x00094F00,
      rootNodeCount: 2,
      totalNodeCount: 3,
      hostCount: 2,
      propertyCount: 1,
      section11ValueCount: 3,
      sectionCounts: {
        section1: 1, section2: 1, section3: 1, section4: 3, section5: 0,
        section6: 2, section7: 1, section8: 0, section9: 0, section10: 0,
        section11: 3, section12: 0, section13: 0, section14: 0
      },
      effect: {
        format: 'FXR3',
        version: 5,
        resourceId: 0x00094F00,
        rootNodeCount: 2,
        nodes: [
          {
            typeId: 2000, childCount: 1, drawEntityCount: 1, drawEntityRefCount: 0,
            children: [
              {
                typeId: 2200, childCount: 0, drawEntityCount: 0, drawEntityRefCount: 0,
                children: [], childrenTruncated: false
              }
            ],
            childrenTruncated: false
          },
          {
            typeId: 9999, childCount: 0, drawEntityCount: 0, drawEntityRefCount: 0,
            children: [], childrenTruncated: false
          }
        ],
        nodesTruncated: false
      },
      nodes: {
        total: 3,
        byType: [
          { typeId: 2000, count: 1 },
          { typeId: 2200, count: 1 },
          { typeId: 9999, count: 1 }
        ]
      },
      fields: {
        hosts: [
          {
            typeId: 0, unk02: 1, unk03: 0, unk04: 2,
            section11Count: 1, section10Count: 0, section7Count: 1,
            properties: [
              {
                typeId: 3, unk04: 0, section11Count: 1, section8Count: 0,
                values: [1, 2, 3], valuesTruncated: false,
                section8: [], section8Truncated: false
              }
            ],
            propertiesTruncated: false,
            section10: [],
            section10Truncated: false,
            values: [10, 11],
            valuesTruncated: false
          },
          {
            typeId: 7777, unk02: 0, unk03: 0, unk04: 0,
            section11Count: 0, section10Count: 0, section7Count: 0,
            properties: [], propertiesTruncated: false,
            section10: [], section10Truncated: false,
            values: [], valuesTruncated: false
          }
        ],
        hostsTruncated: false
      },
      unparsedGaps: [
        'section11:opaque-int-array（混合 int/float 位模式，无 schema，按不透明 int 数组上报）；values=3',
        'section12-14-empty-samples-only（真实样本恒空，非空布局未验证）',
        'unknown-type:section4:9999',
        'unknown-type:section6:7777'
      ],
      layoutWarnings: [],
      roundTrip: {
        consistent: true,
        sourceHash: 'fixture-fxr-hash-0001',
        reparsedHash: 'fixture-fxr-hash-0001',
        nodeCount: 3,
        propertyCount: 1,
        section11ValueCount: 3,
        note: null
      },
      authority: 'partial'
    }
  };

  handleTrusted('resource.readFxrDocument', (_event, sourceUri) => {
    track('resource.readFxrDocument');
    const doc = fixtureFxrDocs[sourceUri];
    if (!doc) {
      return {
        ok: false,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'FXR_DOCUMENT_READ_FAILED',
          message: 'fixture 未登记或损坏的 FXR：读取失败。', sourceUri
        }]
      };
    }
    return { ok: true, data: { ...doc }, diagnostics: [] };
  });

  // VFX-54C：FXR vfx-field-set 写回（合成内存态，明确标记 synthetic）。
  // address 按 read 信封下标定位（host 收集序 / property 连续序 / section8 下标 /
  // valueIndex）；越界、unknown host（typeId 7777）拒绝——镜像 C# fail-closed。
  handleTrusted('resource.commitFxrFieldSet', (_event, sourceUri, expectedDocumentHash, mutations) => {
    track('resource.commitFxrFieldSet');
    const doc = fixtureFxrDocs[sourceUri];
    if (!doc) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: 'fixture 未登记或损坏的 FXR：拒绝写入。', sourceUri }]
      };
    }
    if (expectedDocumentHash !== doc.sourceHash) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: 'FXR source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri }]
      };
    }
    for (const m of mutations ?? []) {
      const addr = m.address;
      if (!addr || m.mutation !== 'vfx-field-set') {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: 'fixture FXR mutation 形状非法。', sourceUri }]
        };
      }
      const host = doc.fields.hosts[addr.hostIndex];
      if (!host || host.typeId === 7777) {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: `fixture FXR host 不可写：hostIndex ${addr.hostIndex}（不存在或 unknown type）。`, sourceUri }]
        };
      }
      if (addr.container === 'host') {
        if (addr.valueIndex < 0 || addr.valueIndex >= host.values.length) {
          return {
            ok: false, changedFiles: [],
            diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: `fixture FXR value 越界：host ${addr.hostIndex} valueIndex ${addr.valueIndex}。`, sourceUri }]
          };
        }
        host.values[addr.valueIndex] = m.value;
      } else if (addr.container === 'property') {
        const prop = host.properties[addr.propertyIndex];
        if (!prop || addr.valueIndex < 0 || addr.valueIndex >= prop.values.length) {
          return {
            ok: false, changedFiles: [],
            diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: `fixture FXR property 越界：host ${addr.hostIndex} property ${addr.propertyIndex} value ${addr.valueIndex}。`, sourceUri }]
          };
        }
        prop.values[addr.valueIndex] = m.value;
      } else if (addr.container === 'section8') {
        const prop = host.properties[addr.propertyIndex];
        const sec8 = prop && prop.section8[addr.section8Index];
        if (!prop || !sec8 || addr.valueIndex < 0 || addr.valueIndex >= sec8.values.length) {
          return {
            ok: false, changedFiles: [],
            diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: `fixture FXR section8 越界：host ${addr.hostIndex} property ${addr.propertyIndex} sec8 ${addr.section8Index} value ${addr.valueIndex}。`, sourceUri }]
          };
        }
        sec8.values[addr.valueIndex] = m.value;
      } else {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE', message: `fixture FXR 未知容器：${addr.container}。`, sourceUri }]
        };
      }
    }
    return {
      ok: true, sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{ severity: 'info', code: 'FXR_STAGING_WRITE_VERIFIED', message: 'fixture FXR 字段已写入（合成）并重读验证。', sourceUri }]
    };
  });

  // ── BEHAVIOR-55B：Behavior 工作台合成通道 ────────────────────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。一个可读 ESD：2 个状态组 / 2 个条件
  // 样本 / 2 个命令调用，authority 'candidate'（闭合、无缺口），驱动
  // machine → state → condition 选择链断言。未登记样本结构化失败，绝不显示为空文档。
  const fixtureEsdDocs = {
    'fixture://ai/m10.esd': {
      format: 'ESD',
      version: 1,
      sourceSize: 4096,
      sourceHash: 'fixture-esd-hash-0001',
      stateGroupCount: 2,
      stateCount: 4,
      conditionCount: 2,
      commandCallCount: 2,
      commandArgCount: 2,
      declaredStateGroupCount: 2,
      declaredStateCount: 4,
      declaredConditionCount: 2,
      declaredCommandCallCount: 2,
      declaredCommandArgCount: 2,
      parsedStateCount: 4,
      parsedStateRecordCount: 6,
      stateSentinelPerGroup: 1,
      stateSentinelModelConsistent: true,
      stateSentinelDivergentGroupIds: [],
      parsedConditionCount: 2,
      parsedCommandCallCount: 2,
      parsedCommandArgCount: 2,
      stateGroups: [
        { groupId: 0, stateCount: 2 },
        { groupId: 1, stateCount: 2 }
      ],
      stateGroupsTruncated: false,
      commandBanks: [0],
      bytecodeRegionCount: 2,
      conditionSamples: [
        { conditionRelOffset: 0x10, sourceGroupId: 0, sourceStateRelOffset: 0x0, targetStateRelOffset: 0x28, subConditionCount: 1, evaluatorLength: 8, passCommandCount: 1 },
        { conditionRelOffset: 0x20, sourceGroupId: 1, sourceStateRelOffset: 0x4, targetStateRelOffset: -1, subConditionCount: 0, evaluatorLength: 4, passCommandCount: 0 }
      ],
      conditionSamplesTruncated: false,
      transitionGraph: {
        edgeCount: 2, resolved: 1, none: 1, sentinel: 0, dangling: 0, closed: true,
        danglingSamples: [], sentinelSamples: [], edges: [], edgesTruncated: false
      },
      commandCalls: {
        total: 2, distinctCommandIds: 2,
        bySlot: [
          { slot: 'entry', count: 1 },
          { slot: 'condition-pass', count: 1 }
        ],
        samples: [
          { sourceGroupId: 0, slot: 'entry', bank: 0, commandId: 10, argCount: 2 },
          { sourceGroupId: 1, slot: 'condition-pass', bank: 0, commandId: 20, argCount: 1 }
        ],
        samplesTruncated: false
      },
      coverageComplete: true,
      coverageShortfalls: [],
      unparsedGaps: [],
      roundTrip: {
        byteIdentical: true, semanticIdentical: true,
        sourceHash: 'fixture-esd-hash-0001', rebuiltHash: 'fixture-esd-hash-0001',
        stateGroupCount: 2, stateCount: 4, stateRecordCount: 6,
        conditionCount: 2, commandCallCount: 2, commandArgCount: 2
      },
      authority: 'candidate'
    }
  };

  // 问题 5：SF_TEST_LARGE_ESD=1 时把 m10.esd 扩为 260 个状态组（超旧上限 200），
  // 验证 ESD 状态组表全量渲染、可滚到最后一条、不出现备选截断说明。合成、
  // 微小、明确标记（AGENTS.md §15）；只在独立 spec 的 env 里开，不影响默认套件。
  if (process.env.SF_TEST_LARGE_ESD === '1' && fixtureEsdDocs['fixture://ai/m10.esd']) {
    const doc = fixtureEsdDocs['fixture://ai/m10.esd'];
    const total = 260;
    fixtureEsdDocs['fixture://ai/m10.esd'] = {
      ...doc,
      stateGroupCount: total,
      stateCount: total * 2,
      parsedStateCount: total * 2,
      parsedStateRecordCount: total * 2 + 2,
      declaredStateGroupCount: total,
      declaredStateCount: total * 2,
      stateGroups: Array.from({ length: total }, (_unused, i) => ({ groupId: i, stateCount: 2 }))
    };
  }

  handleTrusted('resource.readEsdDocument', (_event, sourceUri) => {
    track('resource.readEsdDocument');
    const doc = fixtureEsdDocs[sourceUri];
    if (!doc) {
      return {
        ok: false,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'ESD_DOCUMENT_READ_FAILED',
          message: 'fixture 未登记或损坏的 ESD：读取失败。', sourceUri
        }]
      };
    }
    return { ok: true, data: { ...doc }, diagnostics: [] };
  });

  // BEHAVIOR-55B：ESD 转移目标写回（合成内存态，明确标记 synthetic）。
  // mutation 必须是 'set-transition-target'（C# EsdNativeWriter.ParseMutation 只接受
  // set-transition-target / insert-transition / set-command-arg）；按 conditionRelOffset
  // 命中 conditionSamples 就地更新 targetStateRelOffset。
  handleTrusted('resource.commitEsdTransition', (_event, sourceUri, expectedDocumentHash, mutations) => {
    track('resource.commitEsdTransition');
    const doc = fixtureEsdDocs[sourceUri];
    if (!doc) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'ESD_STAGING_WRITE_FAILED', message: 'fixture 未登记或损坏的 ESD：拒绝写入。', sourceUri }]
      };
    }
    if (expectedDocumentHash !== doc.sourceHash) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'ESD_STAGING_WRITE_FAILED', message: 'ESD source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri }]
      };
    }
    for (const m of mutations ?? []) {
      if (m.mutation !== 'set-transition-target' || typeof m.conditionRelOffset !== 'number') {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'ESD_STAGING_WRITE_FAILED', message: 'fixture ESD mutation 形状非法。', sourceUri }]
        };
      }
      const cond = doc.conditionSamples.find((c) => c.conditionRelOffset === m.conditionRelOffset);
      if (!cond) {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'ESD_STAGING_WRITE_FAILED', message: `fixture ESD 条件不存在：conditionRelOffset ${m.conditionRelOffset}。`, sourceUri }]
        };
      }
      cond.targetStateRelOffset = m.targetStateRelOffset;
    }
    return {
      ok: true, sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{ severity: 'info', code: 'ESD_STAGING_WRITE_VERIFIED', message: 'fixture ESD 转移目标已写入（合成）并重读验证。', sourceUri }]
    };
  });

  // ── ANIMATION-56B：Animation 工作台合成通道 ──────────────────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。一个可读 TAE：2 个动画 / 3 个时间轴
  // 事件 / 3 种事件类型，authority 'candidate'，驱动 animation → timeline 选择链断言。
  // 未登记样本结构化失败，绝不显示为空文档。
  const fixtureTaeDocs = {
    'fixture://action/c0000.tae': {
      format: 'TAE',
      version: '0x20',
      sourceSize: 4096,
      sourceHash: 'fixture-tae-hash-0001',
      animationCount: 2,
      totalEventCount: 3,
      totalGroupCount: 1,
      animations: [
        {
          animId: 0, eventCount: 2, groupCount: 1, timesCount: 2, hkxName: 'a0000.hkx',
          events: [
            { startTime: 0, endTime: 1, eventTypeId: 1 },
            { startTime: 1.5, endTime: 2, eventTypeId: 2 }
          ],
          eventsTruncated: false
        },
        {
          animId: 1, eventCount: 1, groupCount: 0, timesCount: 1,
          events: [{ startTime: 0, endTime: 5, eventTypeId: 3 }],
          eventsTruncated: false
        }
      ],
      animationsTruncated: false,
      eventTypes: [1, 2, 3],
      roundTrip: {
        byteIdentical: true, semanticIdentical: true,
        sourceHash: 'fixture-tae-hash-0001', rebuiltHash: 'fixture-tae-hash-0001',
        animationCount: 2, totalEventCount: 3, totalGroupCount: 1
      },
      diagnostics: [],
      authority: 'candidate'
    },
    // T3 anibnd 容器 → TAE 提取的合成信封：sourceUri 是 anibnd 的 fixture URI，
    // 读链与裸 .tae 相同（readTaeDocument），但 diagnostics 带 TAE_FROM_ANIBND_EXTRACTED
    // 让 e2e 能断言「anibnd 走动作工作台而不是 BND4 容器页」。animId 用真实主 TAE
    // 形态的 hkxName 去扩展展示名（a000_003013），区别于裸 .tae 的 a0000。
    'fixture://chr/c5030.anibnd.dcx': {
      format: 'TAE',
      version: '0x20',
      sourceSize: 8192,
      sourceHash: 'fixture-tae-anibnd-hash-0002',
      animationCount: 2,
      totalEventCount: 3,
      totalGroupCount: 1,
      animations: [
        {
          animId: 0, eventCount: 2, groupCount: 1, timesCount: 2, hkxName: 'a000_003013.hkx',
          events: [
            { startTime: 0, endTime: 0.5, eventTypeId: 7 },
            { startTime: 1, endTime: 2, eventTypeId: 7 }
          ],
          eventsTruncated: false
        },
        {
          animId: 1, eventCount: 1, groupCount: 0, timesCount: 1,
          events: [{ startTime: 0, endTime: 1.5, eventTypeId: 12 }],
          eventsTruncated: false
        }
      ],
      animationsTruncated: false,
      eventTypes: [7, 12],
      roundTrip: {
        byteIdentical: true, semanticIdentical: true,
        sourceHash: 'fixture-tae-anibnd-hash-0002', rebuiltHash: 'fixture-tae-anibnd-hash-0002',
        animationCount: 2, totalEventCount: 3, totalGroupCount: 1
      },
      diagnostics: [{
        severity: 'info', code: 'TAE_FROM_ANIBND_EXTRACTED',
        message: '从 anibnd 容器提取 TAE（BND4 内 1 个 TAE 条目，本次打开 id=5000000）。hkx 未读取。',
        sourceUri: 'fixture://chr/c5030.anibnd.dcx'
      }],
      authority: 'candidate'
    },
    // 问题4-D：长列表 TAE（213 动画，超旧 ANIMATION_RENDER_LIMIT=200）。标称
    // animationsTruncated:false + animationCount 213，e2e 断言全量渲染且栏内能
    // 滚到最后一条 a999_000212；列表被砍回 200 时此测试必须红。
    'fixture://action/c9999.tae': {
      format: 'TAE',
      version: '0x20',
      sourceSize: 65536,
      sourceHash: 'fixture-tae-long-list-hash-0003',
      animationCount: 213,
      totalEventCount: 213,
      totalGroupCount: 0,
      animations: Array.from({ length: 213 }, (_unused, i) => ({
        animId: i,
        eventCount: 1,
        groupCount: 0,
        timesCount: 1,
        hkxName: `a999_${String(i).padStart(6, '0')}.hkx`,
        events: [{ startTime: 0, endTime: 1, eventTypeId: 5 }],
        eventsTruncated: false
      })),
      animationsTruncated: false,
      eventTypes: [5],
      roundTrip: {
        byteIdentical: true, semanticIdentical: true,
        sourceHash: 'fixture-tae-long-list-hash-0003', rebuiltHash: 'fixture-tae-long-list-hash-0003',
        animationCount: 213, totalEventCount: 213, totalGroupCount: 0
      },
      diagnostics: [],
      authority: 'candidate'
    }
  };

  handleTrusted('resource.readTaeDocument', (_event, sourceUri) => {
    track('resource.readTaeDocument');
    const doc = fixtureTaeDocs[sourceUri];
    if (!doc) {
      return {
        ok: false,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'TAE_DOCUMENT_READ_FAILED',
          message: 'fixture 未登记或损坏的 TAE：读取失败。', sourceUri
        }]
      };
    }
    return { ok: true, data: { ...doc }, diagnostics: [] };
  });

  // 问题4-C：词条详情参数体拉取（合成 stub）。fixture 无 DSAS 模板目录 → 走
  // 「未解码 + hex」边界：fields 空、undecodedHex 非空，让 e2e 断言「参数体
  // 未解码边界必须明示（不伪装成完整解析）」成立。
  handleTrusted('resource.readTaeEventParams', (_event, sourceUri, animId, eventIndex) => ({
    ok: true,
    data: {
      eventTypeId: animId === 0 && eventIndex === 0 ? 1 : 7,
      templateName: null,
      fields: [],
      tailHex: null,
      undecodedHex: '48 00 00 00 4C 00 00 00'
    },
    diagnostics: []
  }));

  // ANIMATION-56B：TAE 事件时间/新增写回（合成内存态，明确标记 synthetic）。
  // update-event-times 按 animId + eventIndex 命中 events 就地更新 startTime/endTime；
  // insert-event 以 templateEventIndex 为模板，eventTypeId 必须一致（C# fail-closed），
  // 插入到模板后。参数体未建模，insert 只登记位置与类型。
  handleTrusted('resource.commitTaeEvent', (_event, sourceUri, expectedDocumentHash, mutations) => {
    track('resource.commitTaeEvent');
    const doc = fixtureTaeDocs[sourceUri];
    if (!doc) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TAE_STAGING_WRITE_FAILED', message: 'fixture 未登记或损坏的 TAE：拒绝写入。', sourceUri }]
      };
    }
    if (expectedDocumentHash !== doc.sourceHash) {
      return {
        ok: false, changedFiles: [],
        diagnostics: [{ severity: 'error', code: 'TAE_STAGING_WRITE_FAILED', message: 'TAE source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri }]
      };
    }
    for (const m of mutations ?? []) {
      const anim = doc.animations.find((a) => a.animId === m.animId);
      if (!anim) {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'TAE_STAGING_WRITE_FAILED', message: `fixture TAE 动画不存在：animId ${m.animId}。`, sourceUri }]
        };
      }
      if (m.mutation === 'update-event-times') {
        const ev = anim.events[m.eventIndex];
        if (!ev) {
          return {
            ok: false, changedFiles: [],
            diagnostics: [{ severity: 'error', code: 'TAE_STAGING_WRITE_FAILED', message: `fixture TAE 事件越界：anim ${m.animId} eventIndex ${m.eventIndex}。`, sourceUri }]
          };
        }
        ev.startTime = m.startTime;
        ev.endTime = m.endTime;
      } else if (m.mutation === 'insert-event') {
        const template = anim.events[m.templateEventIndex];
        if (!template || template.eventTypeId !== m.eventTypeId) {
          return {
            ok: false, changedFiles: [],
            diagnostics: [{ severity: 'error', code: 'TAE_STAGING_WRITE_FAILED', message: `fixture TAE 模板不一致：anim ${m.animId} templateIndex ${m.templateEventIndex}。`, sourceUri }]
          };
        }
        anim.events.splice(m.templateEventIndex + 1, 0, {
          startTime: m.startTime, endTime: m.endTime, eventTypeId: m.eventTypeId
        });
      } else {
        return {
          ok: false, changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'TAE_STAGING_WRITE_FAILED', message: 'fixture TAE mutation 形状非法。', sourceUri }]
        };
      }
    }
    return {
      ok: true, sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{ severity: 'info', code: 'TAE_STAGING_WRITE_VERIFIED', message: 'fixture TAE 事件已写入（合成）并重读验证。', sourceUri }]
    };
  });

  // ── EVENT-30B：DarkScript3 式事件源码工作台合成通道 ──────────────────
  // 微小、合法构造、明确标记（AGENTS.md §15）。两个登记 bank（对应两个事件
  // 文件，驱动多 tab 测试）：common 的 event 60 有一条指令但样本缺失 → 投影为
  // unknown（read-only），驱动 diagnostic gutter 的 warning 标记；menu 是干净
  // 文档（无未知指令）。未登记资源结构化失败，绝不显示为空文档。
  function makeFixtureEmevdBank({ events, instructionsSample, dslTemplate }) {
    const bank = {
      sourceHash: 'fixture-emevd-0001',
      events,
      instructionsSample,
      dslTemplate,
      envelope() {
        return {
          sourceHash: this.sourceHash,
          eventCount: this.events.length,
          instructionCount: (this.instructionsSample ?? []).length,
          events: this.events,
          instructionsSample: this.instructionsSample ?? [],
          authority: 'fixture'
        };
      },
      /**
       * 事件判据（gutter「未知指令数」）现在跟着 full document 一次下发，renderer
       * 不再为这一列计数另发一次 readEmevdDocument。真实主进程按 EMEDF registry
       * 逐条判 unknown；fixture 没有 registry，就沿用本 bank 既有的判据 ——
       * 「[start, start+count) 里缺 instructionsSample 的那几条算 unknown」，
       * 于是 common 的 event 60 仍是 1 条未知，menu 仍干净。
       */
      outline() {
        const sampleIndexes = new Set((this.instructionsSample ?? []).map((item) => item.index));
        const outlineEvents = this.events.map((event) => {
          const start = event.instructionStartIndex ?? -1;
          const count = event.instructionCount ?? 0;
          let unknownCount = 0;
          if (start >= 0) {
            for (let i = 0; i < count; i += 1) {
              if (!sampleIndexes.has(start + i)) unknownCount += 1;
            }
          }
          return { eventId: event.id, instructionCount: count, unknownCount };
        });
        return {
          eventCount: outlineEvents.length,
          instructionTotal: outlineEvents.reduce((sum, e) => sum + e.instructionCount, 0),
          truncated: false,
          limit: 4096,
          events: outlineEvents
        };
      }
    };
    return bank;
  }
  const fixtureEmevdBanks = {
    'fixture://event/common.emevd': makeFixtureEmevdBank({
      events: [
        { id: 50, restBehavior: 1, layer: -1, instructionCount: 1, instructionStartIndex: 0 },
        { id: 60, restBehavior: 0, layer: -1, instructionCount: 1, instructionStartIndex: 1 }
      ],
      // index 1 缺失：event 60 的那条指令在 bounded projection 里是 unknown。
      instructionsSample: [{ index: 0, bank: 0, id: 0, argsBase64: '' }],
      dslTemplate: [
        'resource "fixture://event/common.emevd"',
        'base revision 0 schema "sekiro"',
        'event @e:ev50 {',
        '  set id = 50',
        '  set rest = 1',
        '  instruction @i:ev50-0 { set arg bank = 0; set arg id = 0; }',
        '}',
        'event @e:ev60 {',
        '  set id = 60',
        '  set rest = 0',
        '  // read-only ev60-0 bank=1 id=20',
        '}',
        ''
      ].join('\n')
    }),
    'fixture://event/menu.emevd': makeFixtureEmevdBank({
      events: [
        { id: 100, restBehavior: 1, layer: -1, instructionCount: 1, instructionStartIndex: 0 },
        { id: 110, restBehavior: 0, layer: -1, instructionCount: 0, instructionStartIndex: -1 }
      ],
      instructionsSample: [{ index: 0, bank: 0, id: 10, argsBase64: '' }],
      dslTemplate: [
        'resource "fixture://event/menu.emevd"',
        'base revision 0 schema "sekiro"',
        'event @e:ev100 {',
        '  set id = 100',
        '  set rest = 1',
        '  instruction @i:ev100-0 { set arg bank = 0; set arg id = 10; }',
        '}',
        'event @e:ev110 {',
        '  set id = 110',
        '  set rest = 0',
        '}',
        ''
      ].join('\n')
    })
  };

  const emevdBank = (sourceUri) => fixtureEmevdBanks[sourceUri];

  handleTrusted('resource.readEmevdDocument', (_event, sourceUri) => {
    track('resource.readEmevdDocument');
    const bank = emevdBank(sourceUri);
    if (!bank) {
      return {
        ok: false,
        data: null,
        diagnostics: [{
          severity: 'error', code: 'RESOURCE_NOT_INDEXED',
          message: `fixture 未登记的 EMEVD 资源：${sourceUri}`, sourceUri
        }]
      };
    }
    return { ok: true, data: bank.envelope() };
  });

  /*
   * 打开事件文档的在飞槽 —— 镜像生产 ipc.ts 的 activeEmevdOpen / beginEmevdOpen /
   * emevdOpenCancelled 三件套（ipc.ts:218-247）。
   *
   * 为什么 fixture 也要有：renderer 侧「被放弃的旧请求不得覆盖 UI」这条判据，唯一
   * 的触发条件是主进程给旧请求返回 `cancelled: true`。fixture 若一律返回 ok:true，
   * 那条分支在 e2e 里零覆盖，而它正是快速切换时唯一防止 UI 回跳的东西。
   *
   * 契约（与生产逐字段对齐）：新请求同步接管槽位并中止旧的；被中止的那份返回
   * `{ ok: false, cancelled: true, EMEVD_LOAD_CANCELLED, severity: info }`，
   * **不是**解析失败。fixture 不复制生产的分页读/outline/反汇编，只复制这个契约。
   *
   * SF_TEST_EMEVD_OPEN_DELAY_MS 给打开加延迟（各次不等长，见下面的 emevdOpenDelayFor）。
   * 没有延迟时 fixture 的 handler 同步返回，两次点击必然串行完成，「后到的请求取代先到
   * 的」这个形态根本不出现；加了延迟后第二次点击一定落在第一次的 sleep 里，竞态从
   * 「靠运气」变成必然。默认 0：既有 40 个调用点行为不变。
   */
  const EMEVD_OPEN_DELAY_MS = Number(process.env.SF_TEST_EMEVD_OPEN_DELAY_MS ?? 0) || 0;
  /*
   * 第一个请求等满额，后续按 1/4 递减 —— 不是每次等长。
   *
   * 等长延迟下到达顺序 == 发起顺序，被放弃的那份**必然先完成**：实测 common 起于
   * 12546ms、8000ms 后返回，menu 起于 14536ms、返回于 22536ms，common 早 2s 落地。
   * 那样只覆盖「旧响应不得建标签页」，覆盖不到「迟到的旧响应不得覆盖已经正确的 UI」，
   * 而后者才是 renderer 侧 cancelled 判据要防的回跳。递减后 common 反而最后落地
   *（20546ms vs menu 16536ms），旧响应确实迟到约 4s，一次快速切换覆盖两条判据。
   */
  const emevdOpenDelayFor = (arrivalIndex) => (
    arrivalIndex === 0 ? EMEVD_OPEN_DELAY_MS : Math.round(EMEVD_OPEN_DELAY_MS / 4)
  );
  let activeEmevdOpen = null;
  const fixtureEmevdSourceTokens = new Map();

  /*
   * 打开事件文档的观测记录，测试经 app.evaluate(() => global.__fixtureEmevdOpenLog) 读。
   *
   * 为什么必须暴露到测试侧：「快速切换时旧请求被取消」这条判据成立的前提是第二次请求
   * 真的落在第一次的 sleep 里。这个前提**会自己失效** —— 实测 Playwright 两次
   * `.file-item` 点击之间隔了 1990ms（第一次点击后工作台挂载 CodeMirror，
   * 布局不稳，第二次点击的 actionability 检查一直等），当时的 700ms 延迟早就到期，
   * 两个请求全程串行、fixture 两次都返回 ok。UI 断言那时仍然「看起来对」（终态确实
   * 是 menu），于是整条用例静默退化成「顺序打开两个文件」，不再覆盖取消分支。
   *
   * 所以延迟本身不够，还要把到达时刻与取消次数记下来让测试断言前提成立。
   *
   * arrivals（发起顺序）与 settlements（响应落地顺序）分开记，两个都要：测试还要证
   * 「被放弃的旧请求迟于它的替代者落地」，这条由上面的递减延迟制造，而延迟只是手段 ——
   * 递减系数、点击间隔、机器快慢任一变化都能让它悄悄失效，失效后 UI 终态仍然是对的
   *（menu），断言照样全绿。落地顺序必须记下来让测试直接断言，不能靠推断。
   */
  global.__fixtureEmevdOpenLog = {
    arrivals: [], settlements: [], cancelled: 0, delayMs: EMEVD_OPEN_DELAY_MS
  };
  const noteEmevdSettled = (sourceUri, cancelled) => {
    global.__fixtureEmevdOpenLog.settlements.push({
      atMs: Math.round(performance.now()), sourceUri, cancelled
    });
  };

  handleTrusted('resource.readEmevdFullDocument', async (_event, sourceUri, documentInstanceId, _loadFullDslTemplate) => {
    track('resource.readEmevdFullDocument');
    global.__fixtureEmevdOpenLog.arrivals.push({
      atMs: Math.round(performance.now()),
      sourceUri
    });
    // S14/S15：KRAK 压缩样本返回可读失败句（code + 人话 + 下一步），不返回假源码；
    // 方括号 code 随 message 下发，e2e 据此断言失败面形态。
    if (sourceUri.includes('krak')) {
      return {
        ok: false,
        sourceUri,
        diagnostics: [{
          severity: 'error',
          code: 'EMEVD_DOCUMENT_READ_FAILED',
          message: '[EMEVD_DOCUMENT_READ_FAILED] 这份事件是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。',
          sourceUri
        }]
      };
    }
    const bank = emevdBank(sourceUri);
    if (!bank) {
      return {
        ok: false,
        sourceUri,
        diagnostics: [{
          severity: 'error', code: 'RESOURCE_NOT_INDEXED',
          message: `fixture 未登记的 EMEVD 资源：${sourceUri}`, sourceUri
        }]
      };
    }
    // 同步接管槽位：必须在任何 await 之前，否则新请求发出时旧请求还没被标记中止。
    const controller = new AbortController();
    activeEmevdOpen?.abort();
    activeEmevdOpen = controller;
    // arrivals 已在上面 push 过，-1 拿到本次请求自己的序号（第一个是 0）。
    const delayMs = emevdOpenDelayFor(global.__fixtureEmevdOpenLog.arrivals.length - 1);
    if (delayMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
    if (controller.signal.aborted) {
      global.__fixtureEmevdOpenLog.cancelled += 1;
      noteEmevdSettled(sourceUri, true);
      return {
        ok: false,
        cancelled: true,
        sourceUri,
        diagnostics: [{
          severity: 'info', code: 'EMEVD_LOAD_CANCELLED',
          message: '打开事件文档的请求已被更晚的打开请求取代。', sourceUri
        }]
      };
    }
    noteEmevdSettled(sourceUri, false);
    const lines = bank.dslTemplate.split('\n');
    const sourceToken = randomUUID();
    fixtureEmevdSourceTokens.set(sourceToken, { lines, sourceUri });
    return {
      ok: true,
      sourceUri,
      documentInstanceId,
      revision: 0,
      eventCount: bank.events.length,
      instructionCount: bank.events.reduce((sum, e) => sum + (e.instructionCount ?? 0), 0),
      dslTemplate: null,
      sourcePrefix: lines.slice(0, 400).join('\n'),
      sourceToken,
      sourceTotalLines: lines.length,
      sourceStyle: 'dark-script',
      dslTemplateTruncated: false,
      dslTemplateTotalLines: lines.length,
      sourceHash: bank.sourceHash,
      sourceFormat: 'emevd',
      outerFileHash: null,
      // fixture 是合成往返，语义与字节都由自己构造，不冒充 native-verified。
      authority: 'fixture',
      outline: bank.outline(),
      diagnostics: []
    };
  });

  handleTrusted('resource.readEmevdSourceSlice', (_event, token, fromLine, lineCount) => {
    track('resource.readEmevdSourceSlice');
    const entry = fixtureEmevdSourceTokens.get(token);
    if (!entry) {
      return { ok: false, code: 'EMEVD_SOURCE_TOKEN_EXPIRED', message: '源码切片令牌已失效。' };
    }
    const start = Number(fromLine) || 0;
    const count = Number(lineCount) || 0;
    const slice = entry.lines.slice(start, start + count);
    return {
      ok: true,
      fromLine: start,
      lineCount: slice.length,
      totalLines: entry.lines.length,
      eof: start + slice.length >= entry.lines.length,
      sliceText: slice.join('\n')
    };
  });

  handleTrusted('resource.cancelEmevdFullDocument', async () => {
    track('resource.cancelEmevdFullDocument');
    const slot = activeEmevdOpen;
    if (!slot || slot.signal.aborted) return { ok: true, cancelled: false };
    slot.abort();
    return { ok: true, cancelled: true };
  });

  // T4-3：fixture 指令名补全目录（与 core createSekiroFixtureEmedf 对齐），
  // 供 e2e 断言 CodeMirror autocomplete / 悬停参数名。
  handleTrusted('resource.readEmedfCompletionCatalog', () => {
    track('resource.readEmedfCompletionCatalog');
    return {
      ok: true,
      origin: 'fixture',
      items: [
        {
          name: 'IfConditionGroup', bank: 2000, id: 0,
          args: [
            { name: 'resultConditionGroup', type: 's8' },
            { name: 'desiredComparisonType', type: 'u8' },
            { name: 'targetConditionGroup', type: 's8' },
            { name: 'pad0', type: 'u8' },
            { name: 'pad1', type: 'u32' },
            { name: 'pad2', type: 'u32' }
          ]
        },
        {
          name: 'WaitFor', bank: 1000, id: 0,
          args: [
            { name: 'conditionGroup', type: 's8' },
            { name: 'pad0', type: 'u8' },
            { name: 'pad1', type: 'u16' },
            { name: 'unknown', type: 'u32' }
          ]
        },
        {
          name: 'EndEvent', bank: 2003, id: 1, args: []
        }
      ]
    };
  });

  // 提交 DSL：fixture 接受登记资源的任意源码（合成内存态），sourceHash 递增，
  // 提交后重读即见新模板（与 TEXT-20C 的写回模式同构）。未登记/空源码结构化失败。
  handleTrusted('resource.submitEmevdDslPlan', (_event, sourceUri, sourceText) => {
    track('resource.submitEmevdDslPlan');
    const bank = emevdBank(sourceUri);
    if (!bank || typeof sourceText !== 'string' || sourceText.trim() === '') {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error', code: 'EMEVD_DSL_SUBMIT_FAILED',
          message: 'fixture 拒绝提交：未登记资源或空源码。', sourceUri
        }]
      };
    }
    bank.dslTemplate = sourceText;
    bank.sourceHash = `fixture-emevd-${String(Number(bank.sourceHash.split('-').pop()) + 1).padStart(4, '0')}`;
    return {
      ok: true,
      sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{
        severity: 'info', code: 'EMEVD_DSL_SUBMIT_VERIFIED',
        message: 'fixture EMEVD DSL 已写入（合成）并验证。', sourceUri
      }]
    };
  });

  handleTrusted('resource.applyEmevdMutation', (_event, sourceUri, expectedHash, _mutation) => {
    track('resource.applyEmevdMutation');
    const bank = emevdBank(sourceUri);
    if (!bank) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error', code: 'EMEVD_STAGING_WRITE_FAILED',
          message: 'fixture 未登记 EMEVD：拒绝写入。', sourceUri
        }]
      };
    }
    if (expectedHash !== bank.sourceHash) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error', code: 'EMEVD_STAGING_WRITE_FAILED',
          message: 'EMEVD source hash 不匹配（工作副本已漂移），拒绝写入。', sourceUri
        }]
      };
    }
    bank.sourceHash = `fixture-emevd-${String(Number(bank.sourceHash.split('-').pop()) + 1).padStart(4, '0')}`;
    return {
      ok: true,
      sourceUri,
      changedFiles: [{ sourceUri, action: 'modify' }],
      diagnostics: [{
        severity: 'info', code: 'EMEVD_STAGING_WRITE_VERIFIED',
        message: 'fixture EMEVD mutation 已写入（合成）并验证。', sourceUri
      }]
    };
  });

  // 容器工作台合成通道：微小、合法构造、明确标记（AGENTS.md §15）。
  const containerChildren = [
    {
      childId: '0', name: 'item.fmg', offset: 0, size: 512,
      hash: 'fixture-child-0000', formatKind: 'fmg',
      sourceContainerUri: 'fixture://msg/test.msgbnd.dcx',
      childUri: 'fixture://msg/test.msgbnd.dcx#0',
      rawBytesAvailable: false, canReplace: false
    },
    {
      childId: '1', name: 'menu.fmg', offset: 512, size: 512,
      hash: 'fixture-child-0001', formatKind: 'fmg',
      sourceContainerUri: 'fixture://msg/test.msgbnd.dcx',
      childUri: 'fixture://msg/test.msgbnd.dcx#1',
      rawBytesAvailable: false, canReplace: false
    }
  ];
  handleTrusted('resource.inspectContainerTree', (_event, uri) => ({
    ok: true,
    rootUri: uri,
    root: {
      uri, format: 'bnd4', authority: 'fixture', magic: 'BND4',
      size: 2048, hash: 'fixture-container-0001', childCount: containerChildren.length,
      canListChildren: true, canReadChild: false, canReplaceChild: false,
      canRepackContainer: false, containerRoundTripSafe: false,
      decompressionStatus: 'not-applicable', compressionStatus: 'not-applicable'
    },
    diagnostics: []
  }));
  handleTrusted('resource.listContainerChildrenPage', (_event, _uri, page, pageSize) => ({
    ok: true,
    totalCount: containerChildren.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(containerChildren.length / pageSize)),
    children: containerChildren.slice(page * pageSize, page * pageSize + pageSize),
    diagnostics: []
  }));
  handleTrusted('resource.listContainerChildren', () => ({
    ok: true,
    children: containerChildren.map((child) => ({ ...child })),
    diagnostics: []
  }));

  /* ── SCRIPT-41 fixture：合成脚本容器条目（微小、合法构造、明确标记）──
     三条通道（evidence / 分页 / 明文视图）一起提供，renderer 才会走真实
     readScriptEntryPlaintext 链路。goal_list.lua 判明文（CRLF 换行），
     battle.lua 判 `\x1bLua` 字节码（只读字节视图）。 */
  const fixtureScriptEntries = [
    {
      name: 'goal_list.lua', index: 0, size: 214, extension: 'lua',
      classification: 'lua-bytecode', headerHex: '2300424f4d', magicLabel: 'plaintext sample'
    },
    {
      name: 'battle.lua', index: 1, size: 4096, extension: 'lua',
      classification: 'lua-bytecode', headerHex: '1b4c756151', magicLabel: '\\x1bLuaQ bytecode'
    },
    {
      name: 'esd_common.esd', index: 2, size: 1024, extension: 'esd',
      classification: 'esd-bytecode', headerHex: '', magicLabel: 'ESD'
    }
  ];
  const fixtureScriptSummary = {
    'lua-bytecode': 2, luagnl: 0, luainfo: 0, 'esd-bytecode': 1, 'hkx-bytecode': 0, unknown: 0
  };
  handleTrusted('resource.scriptContainerEvidence', () => ({
    ok: true,
    containerFormat: 'BND4',
    entryCount: fixtureScriptEntries.length,
    entries: fixtureScriptEntries.map((entry) => ({ ...entry })),
    truncated: false,
    classificationSummary: { ...fixtureScriptSummary },
    diagnostics: []
  }));
  handleTrusted('resource.listScriptContainerEntriesPage', (_event, _uri, page, pageSize) => ({
    ok: true,
    containerFormat: 'BND4',
    entryCount: fixtureScriptEntries.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(fixtureScriptEntries.length / pageSize)),
    entries: fixtureScriptEntries
      .slice(page * pageSize, page * pageSize + pageSize)
      .map((entry) => ({ ...entry })),
    classificationSummary: { ...fixtureScriptSummary },
    entriesComplete: true,
    diagnostics: []
  }));
  handleTrusted('resource.readScriptEntryPlaintext', (_event, _uri, entryName) => {
    if (entryName === 'goal_list.lua') {
      return {
        ok: true, name: entryName, classification: 'lua-bytecode', isPlaintext: true,
        verdictCode: 'PLAINTEXT_CONFIRMED', printableRatio: 1, totalBytes: 214,
        trailingPaddingBytes: 0, containsNul: false, luaBytecodeMagic: false,
        encoding: 'utf8', hasBom: false,
        newlines: { crlf: 3, lf: 0, cr: 0 },
        text: '-- SoulForge synthetic plaintext fixture (explicitly constructed)\r\n'
          + '-- 目标列表示例：goal_list.lua\r\n'
          + 'local goal = { name = "合成目标", id = 100 }\r\n',
        diagnostics: [{ severity: 'info', code: 'PLAINTEXT_CONFIRMED', message: '条目确认为明文。' }]
      };
    }
    if (entryName === 'battle.lua') {
      return {
        ok: true, name: entryName, classification: 'lua-bytecode', isPlaintext: false,
        verdictCode: 'PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC', printableRatio: 0.5, totalBytes: 4096,
        trailingPaddingBytes: 0, containsNul: false, luaBytecodeMagic: true,
        encoding: 'mixed-unknown', hasBom: false,
        newlines: { crlf: 0, lf: 0, cr: 0 },
        diagnostics: [{
          severity: 'error', code: 'PLAINTEXT_REJECTED_LUA_BYTECODE_MAGIC',
          message: '条目以 \\x1bLua 字节码签名开头，是编译产物。'
        }]
      };
    }
    return {
      ok: true, name: entryName, classification: 'esd-bytecode', isPlaintext: false,
      verdictCode: 'PLAINTEXT_REJECTED_LOW_PRINTABLE_RATIO', printableRatio: 0.3, totalBytes: 1024,
      trailingPaddingBytes: 4, containsNul: true, luaBytecodeMagic: false,
      encoding: 'mixed-unknown', hasBom: false,
      newlines: { crlf: 0, lf: 0, cr: 0 },
      diagnostics: [{
        severity: 'error', code: 'PLAINTEXT_REJECTED_LOW_PRINTABLE_RATIO',
        message: '可打印字节比例 0.3000 低于阈值 0.99。'
      }]
    };
  });
  // S16 脚本 IDE 走 readScriptSource（替代 readScriptEntryPlaintext）。
  // fixture 镜像 ScriptSourceView：goal_list.lua 明文可编辑、battle.lua 是
  // Lua 字节码，经 fixture 的假 DSLuaDecompiler 反编译为 Lua（同无反编译器
  // 环境走 SCRIPT_DECOMPILER_NOT_FOUND 的结构化只读失败）。
  handleTrusted('resource.readScriptSource', (_event, sourceUri, entryName) => {
    if (entryName === 'goal_list.lua') {
      return {
        ok: true,
        logicalName: 'goal_list.lua',
        kind: 'plaintext',
        sourceText: '-- SoulForge synthetic plaintext fixture (explicitly constructed)\r\n'
          + '-- 目标列表示例：goal_list.lua\r\n'
          + 'local goal = { name = "合成目标", id = 100 }\r\n',
        encoding: 'utf8',
        decompiled: false,
        containerUri: sourceUri,
        entryName: 'goal_list.lua',
        // 保存后 renderer 按 entryName+entryIndex 重读基线；缺 index 会落
        // loadSource(null)，容器 uri 无 entryName 命中失败分支。
        entryIndex: 0,
        writeSupported: true,
        diagnostics: [{ severity: 'info', code: 'PLAINTEXT_CONFIRMED', message: '条目确认为明文。' }]
      };
    }
    if (entryName === 'battle.lua') {
      return {
        ok: true,
        logicalName: 'battle.lua',
        kind: 'decompiled',
        sourceText: 'function BattleStart()\n  SetHp(1000)\nend\n',
        encoding: 'decompiled',
        decompiled: true,
        decompiler: 'DSLuaDecompiler v1.1.5 (fixture stub)',
        containerUri: sourceUri,
        entryName: 'battle.lua',
        entryIndex: 1,
        writeSupported: true,
        diagnostics: []
      };
    }
    // S16 独立 .hks：单 Source、打开即反编译（合成反编译文本，明确标记 fixture）。
    if (sourceUri.toLowerCase().endsWith('.hks')) {
      return {
        ok: true,
        logicalName: sourceUri.split('/').pop() ?? 'script',
        kind: 'decompiled',
        sourceText: '-- SoulForge synthetic decompiled fixture (explicitly constructed)\nBEH_ADD_NONE = 0\n',
        encoding: 'decompiled',
        decompiled: true,
        decompiler: 'DSLuaDecompiler v1.1.5 (fixture stub)',
        containerUri: sourceUri,
        writeSupported: true,
        diagnostics: []
      };
    }
    return {
      ok: false,
      logicalName: entryName ?? 'script',
      kind: 'failure',
      containerUri: sourceUri,
      entryName,
      writeSupported: false,
      diagnostics: [{
        severity: 'error', code: 'SCRIPT_SOURCE_BYTECODE_UNSUPPORTED',
        message: '该条目是其他类型字节码，fixture 无反编译器，只读。'
      }]
    };
  });
  // S16 脚本 IDE 写回镜像：fixture 不落盘，只记调用并回成功；renderer 成功分支
  // 只看 result.ok，随后经 readScriptSource 重读基线（fixture 返回不变文本）。
  handleTrusted('resource.saveScriptSource', (_event, sourceUri, entryName) => {
    track('resource.saveScriptSource');
    return {
      ok: true,
      changedFiles: [{ sourceUri, sourcePath: entryName ?? 'script', changed: true }],
      diagnostics: []
    };
  });
  // S-FILE-ROLLBACK 审计种子：第一条两文件可单文件回滚；第二条路径未脱敏映射
  // （[本机路径已隐藏]），面板只给提示不给按钮。rollbackFile 后第一条转 rolled_back。
  let fixtureOp1RolledBack = false;
  handleTrusted('operation.list', () => {
    if (!FIXTURE_OPERATIONS) return [];
    return [
      {
        opId: 'fixture-op-1',
        title: 'fixture 写入：item.fmg 文本',
        author: 'user',
        mode: 'commit',
        status: fixtureOp1RolledBack ? 'rolled_back' : 'committed',
        createdAt: '2026-08-21T08:00:00.000Z',
        committedAt: '2026-08-21T08:00:01.000Z',
        ...(fixtureOp1RolledBack ? { rolledBackAt: '2026-08-21T09:00:00.000Z' } : {}),
        fileCount: 2,
        changedPaths: ['msg/zhocn/item.fmg', 'msg/zhocn/menu.fmg']
      },
      {
        opId: 'fixture-op-2',
        title: 'fixture 写入：未脱敏路径样本',
        author: 'user',
        mode: 'commit',
        status: 'committed',
        createdAt: '2026-08-21T08:10:00.000Z',
        committedAt: '2026-08-21T08:10:01.000Z',
        fileCount: 1,
        changedPaths: ['[本机路径已隐藏]']
      }
    ];
  });
  handleTrusted('operation.rollbackFile', (_event, opId, targetUri) => {
    track('operation.rollbackFile');
    if (opId === 'fixture-op-1') fixtureOp1RolledBack = true;
    return { ok: true, opId, restoredFiles: [targetUri], diagnostics: [] };
  });
  handleTrusted('operation.rollback', (_event, opId) => ({
    ok: false,
    opId,
    restoredFiles: [],
    diagnostics: [{ severity: 'warning', code: 'FIXTURE_NO_ROLLBACK', message: 'fixture 不提供回滚。' }]
  }));
  handleTrusted('ai.tools', () => {
    track('ai.tools');
    return [
      { name: 'search_resources', description: 'fixture 只读工具', permission: 'read', permissionLevel: 'read' },
      { name: 'stage_patch', description: 'fixture 暂存工具', permission: 'plan', permissionLevel: 'stage' }
    ];
  });

  // AGENT-60C：资源引用签发（opaque token，合成内存态）。
  // 与生产同形态：preload 传 { selection } 包裹，main 解 selection 后做安全校验。
  // fixture 只镜像路径形式白名单——files 域 + 相对路径；绝对路径 / raw parser /
  // Hex dump 域拒绝（生产是 selectionRendererSafetyIssues）。token 不携带路径。
  handleTrusted('agent.attachment.create', () => {
    track('agent.attachment.create');
    return {
      ok: false,
      cancelled: true,
      error: { code: 'ATTACHMENT_CANCELLED', message: '未选择文件。' }
    };
  });

  handleTrusted('agent.resourceReference.create', (_event, request) => {
    track('agent.resourceReference.create');
    const selection = request && typeof request === 'object' ? request.selection : undefined;
    if (!selection || typeof selection !== 'object' || selection.domain !== 'files') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '资源引用只支持 files 域选区。' } };
    }
    const documentId = selection.documentId;
    if (typeof documentId !== 'string' || documentId.trim() === '') {
      return { ok: false, error: { code: 'AGENT_SELECTION_UNSAFE', message: '缺少文档路径，无法签发资源引用。' } };
    }
    if (documentId.startsWith('/') || documentId.startsWith('\\\\') || /^[a-zA-Z]:/.test(documentId)) {
      return { ok: false, error: { code: 'AGENT_SELECTION_UNSAFE', message: '资源引用拒绝绝对路径。' } };
    }
    return {
      ok: true,
      reference: {
        token: `agent-ref:fixture:${documentId}`,
        domain: 'files',
        label: `fixture 资源引用：${documentId}`,
        expiresAt: 4102444800000
      }
    };
  });

  // S10 引用框选签发：与生产同形态（main 侧解码 + 合并 + 拼标签），fixture 复用
  // shared 构建产物保证标签格式不漂移；跨表/跨行或无命中如实拒绝。
  handleTrusted('agent.citation.create', (_event, request) => {
    track('agent.citation.create');
    const hitsValue = request && typeof request === 'object' ? request.hits : undefined;
    const citation = mergeCiteHits(decodeCiteHits(hitsValue));
    if (citation === null) {
      return {
        ok: false,
        error: {
          code: 'CITATION_UNSUPPORTED',
          message: '这块还不能引用：框选命中跨了不同的表或行，或没有可引用的节点。'
        }
      };
    }
    return {
      ok: true,
      reference: {
        token: `agent-cite:fixture:${randomUUID()}`,
        domain: citation.kind === 'param' ? 'param' : citation.kind,
        label: formatCitationLabel(citation),
        expiresAt: 4102444800000
      }
    };
  });

  /* ── AI agent 会话（合成，不调用任何模型）─────────────────────────────────
     这里**不跑真实模型**，只驱动 renderer 的推送折叠与取消链路：run 受理后按
     计时器推 turn-started / tool-call / delta，cancel 停掉计时器并推终态。

     为什么必须有推送：`ai:agent:event` 是 webContents.send，进度只能靠事件到达
     推进。fixture 若只回一个 sessionId 不推事件，「进度事件到达界面就更新」这条
     在 e2e 层等于零覆盖——而那正是本轮要守的两条行为之一。

     覆盖边界：不验证真实 provider、不验证主进程的 AbortController 语义（那是
     生产 ipc.ts 的行为），只验证 renderer 发出了 ai.agent.cancel 并据推送更新界面。 */
  const agentTimers = new Set();
  let agentSessionSeq = 0;
  const agentEventHistory = new Map();
  /** approval-requested 后挂起的推进回调；ai.agent.approval.respond 触发。 */
  let pendingApprovalAdvance = null;

  function pushAgentEvent(window, sessionId, event) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const history = agentEventHistory.get(sessionId) ?? [];
    const envelope = { sessionId, seq: history.length + 1, event };
    history.push(envelope);
    if (history.length > 4096) history.splice(0, history.length - 4096);
    agentEventHistory.set(sessionId, history);
    window.webContents.send('ai:agent:event', envelope);
  }

  function scheduleAgentEvent(window, sessionId, delayMs, event) {
    const timer = setTimeout(() => {
      agentTimers.delete(timer);
      pushAgentEvent(window, sessionId, event);
    }, delayMs);
    agentTimers.add(timer);
  }

  handleTrusted('ai.agent.run', (event, request) => {
    track('ai.agent.run');
    // 与生产同形态的必填校验（ipc.ts:2929）：configId / prompt 缺失即结构化失败。
    if (typeof request?.configId !== 'string' || request.configId.trim() === ''
      || typeof request?.prompt !== 'string' || request.prompt.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'configId 与 prompt 必填。' } };
    }
    if (request.resumeSessionPath !== undefined) track('ai.agent.run:resume');
    // 生产侧 request.mode 省略时落到 'plan'（ipc.ts:2967）。renderer 若开始传
    // fullPermission，这里的记账会让它在断言中现形。
    track(`ai.agent.run:mode=${request.mode ?? 'absent'}`);
    // S10：opaque 资源引用随任务提交（App 在 resources 非空时透传）。
    if (Array.isArray(request.resources) && request.resources.length > 0) {
      track(`ai.agent.run:resources=${request.resources.length}`);
    }
    agentSessionSeq += 1;
    const sessionId = `fixture-session-${agentSessionSeq}`;
    const window = BrowserWindow.fromWebContents(event.sender);
    pushAgentEvent(window, sessionId, { type: 'session-accepted', mode: 'plan' });

    const prompt = request.prompt ?? '';

    // AGENT-60D 审批态：停在 approval-requested，等 ai.agent.approval.respond 推进。
    if (prompt.includes('审批')) {
      scheduleAgentEvent(window, sessionId, 120, { type: 'turn-started', step: 1 });
      scheduleAgentEvent(window, sessionId, 200, {
        type: 'approval-requested', step: 1, callId: 'fixture-approval-1',
        toolName: 'propose_text_patch', permissionLevel: 'commit',
        argumentsJson: JSON.stringify({
          targetPath: 'm12b/param/gameparam.parambnd.dcx',
          changes: [{
            targetPath: 'm12b/param/gameparam.parambnd.dcx',
            structuredEdit: { newText: '8' }
          }]
        }),
        diff: {
          targetPath: 'm12b/param/gameparam.parambnd.dcx',
          unifiedDiff: '--- m12b/param/gameparam.parambnd.dcx\n+++ m12b/param/gameparam.parambnd.dcx\n@@ -1 +1 @@\n-old\n+new\n',
          addedLines: 1, removedLines: 1, newFile: false
        }
      });
      pendingApprovalAdvance = (respondEvent, respondRequest) => {
        const w = BrowserWindow.fromWebContents(respondEvent.sender);
        pushAgentEvent(w, sessionId, {
          type: 'approval-resolved', step: 1, callId: 'fixture-approval-1',
          toolName: 'propose_text_patch', decision: respondRequest.decision, fromMemory: false
        });
        scheduleAgentEvent(w, sessionId, 120, { type: 'tool-call-begin', step: 1, callId: 'fixture-call-1', name: 'propose_text_patch' });
        scheduleAgentEvent(w, sessionId, 200, { type: 'tool-call-end', step: 1, callId: 'fixture-call-1', name: 'propose_text_patch', ok: true });
        scheduleAgentEvent(w, sessionId, 260, { type: 'agent-message-delta', step: 1, text: '已写入暂存区' });
      };
      return { ok: true, sessionId };
    }

    // AGENT-60D 失败态：推 session-error 让消息流收敛到有界失败诊断。
    if (prompt.includes('失败')) {
      scheduleAgentEvent(window, sessionId, 120, { type: 'turn-started', step: 1 });
      scheduleAgentEvent(window, sessionId, 260, {
        type: 'session-error', code: 'AGENT_SESSION_FAILED', message: 'fixture 合成失败：模型调用超时。'
      });
      return { ok: true, sessionId };
    }

    // AGENT-60D 工具运行态：只推 tool-call-begin，不推 end —— 停在 running 供截图。
    if (prompt.includes('工具')) {
      scheduleAgentEvent(window, sessionId, 120, { type: 'turn-started', step: 1 });
      scheduleAgentEvent(window, sessionId, 200, {
        type: 'tool-call-begin', step: 1, callId: 'fixture-call-1', name: 'search_resources',
        argumentsJson: '{"query":"药葫芦","limit":8}'
      });
      return { ok: true, sessionId };
    }

    // 默认运行中：可取消（取消用例的对象）。
    scheduleAgentEvent(window, sessionId, 120, { type: 'turn-started', step: 1 });
    scheduleAgentEvent(window, sessionId, 200, {
      type: 'tool-call-begin', step: 1, callId: 'fixture-call-1', name: 'search_resources'
    });
    scheduleAgentEvent(window, sessionId, 280, {
      type: 'tool-call-end', step: 1, callId: 'fixture-call-1', name: 'search_resources', ok: true
    });
    scheduleAgentEvent(window, sessionId, 360, {
      type: 'agent-message-delta', step: 1, text: '合成增量文本'
    });
    // 刻意**不**自动推终态：任务停在运行中，取消用例才有可取消的对象。
    return { ok: true, sessionId };
  });

  handleTrusted('ai.agent.cancel', (event, sessionId) => {
    track('ai.agent.cancel');
    for (const timer of agentTimers) clearTimeout(timer);
    agentTimers.clear();
    const window = BrowserWindow.fromWebContents(event.sender);
    // 终态由主进程回报，与生产一致（ipc.ts:3009 的 session-done）。
    pushAgentEvent(window, sessionId, {
      type: 'session-done', finishReason: 'cancelled', steps: 1, rolloutFileName: 'fixture-rollout.jsonl'
    });
    return { ok: true };
  });

  handleTrusted('ai.agent.events', (_event, sessionId, afterSeq = 0) => {
    track('ai.agent.events');
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId 必填。' } };
    }
    const history = agentEventHistory.get(sessionId) ?? [];
    return { ok: true, events: history.filter((envelope) => envelope.seq > afterSeq) };
  });

  handleTrusted('ai.agent.approval.respond', (event, request) => {
    track('ai.agent.approval.respond');
    if (typeof request?.sessionId !== 'string' || request.sessionId === ''
      || typeof request?.callId !== 'string' || request.callId === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId 与 callId 必填。' } };
    }
    const allowed = ['once', 'always', 'reject', 'never', 'abort'];
    if (!allowed.includes(request.decision)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'decision 非法。' } };
    }
    if (request.callId === 'fixture-approval-1' && typeof pendingApprovalAdvance === 'function') {
      const advance = pendingApprovalAdvance;
      pendingApprovalAdvance = null;
      advance(event, request);
    }
    return { ok: true, matched: request.callId === 'fixture-approval-1' };
  });

  handleTrusted('ai.agent.sessions', () => {
    track('ai.agent.sessions');
    // 23 条：跨过每页 10 条的阈值，分页控件与区间文案才会真的出现。
    return {
      ok: true,
      sessions: Array.from({ length: 23 }, (_unused, index) => ({
        sessionPath: `2026/08/08/fixture-rollout-${String(index).padStart(4, '0')}.jsonl`,
        fileName: `fixture-rollout-${String(index).padStart(4, '0')}.jsonl`,
        sessionId: `fixture-s-${index}`,
        startedAt: `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`,
        messageCount: index,
        parseErrors: 0,
        interrupted: false,
        compactedWindows: 0,
        sizeBytes: 4096,
        modifiedAt: `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`
      }))
    };
  });

  handleTrusted('ai.agent.session.load', (_event, sessionPath) => {
    track('ai.agent.session.load');
    if (typeof sessionPath !== 'string' || sessionPath.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionPath 必填。' } };
    }
    return {
      ok: true,
      meta: {
        sessionId: 'fixture-loaded',
        startedAt: '2026-08-08T10:00:00.000Z',
        configId: 'fixture-service',
        protocol: 'openai-compatible',
        permissionMode: 'plan'
      },
      messageCount: 12,
      parseErrors: 0,
      interrupted: false,
      compactedWindows: 0,
      messagesPage: [{ role: 'user', content: 'fixture 会话尾部消息' }]
    };
  });

  handleTrusted('ai.sidebarDraft', () => ({
    summary: 'fixture draft',
    steps: [],
    evidence: [],
    diagnostics: []
  }));
  /*
   * 合成模型服务：hasCredential=true 只表示「vault 里有一条已加密记录」，
   * 不代表存在可用的真实 provider——fixture 从不发起网络请求。
   * 需要它是因为任务面板的运行入口以「有已配置凭据的服务」为前置条件，
   * 空列表下运行按钮恒禁用，取消链路在 e2e 层就无从触达。
   *
   * T6 无模型用例（FIXTURE_EMPTY_MODEL_SERVICES=1）：返回空列表模拟用户
   * 从未配置任何模型服务。此时 renderer 发送应落「尚未配置模型服务」系统提示
   * 且不调 ai.agent.run——那是 renderer 侧行为，fixture 只负责提供空服务。
   */
  // 会话内 upsert 的服务（fixture 内存态），list 时合并返回 —— 保存后
  // renderer 的 refresh() 才能看到新服务与高级选项字段（embedding 标记等）。
  let savedFixtureServices = [];
  handleTrusted('modelService.list', () => {
    if (process.env.FIXTURE_EMPTY_MODEL_SERVICES === '1') return [];
    return [{
      id: 'fixture-service',
      displayName: 'fixture 合成模型服务',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'fixture-model',
      hasCredential: true,
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z'
    }, ...savedFixtureServices];
  });
  // 合成保存：echo 输入（含高级选项字段），供「保存模型服务」与高级选项 e2e 使用。
  handleTrusted('modelService.upsert', (_event, input) => {
    track('modelService.upsert');
    const saved = {
      id: input.id ?? 'fixture-saved',
      displayName: input.displayName,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.model,
      hasCredential: Boolean(input.apiKey),
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.contextWindowTokens !== undefined ? { contextWindowTokens: input.contextWindowTokens } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.embeddingModel !== undefined ? { embeddingModel: input.embeddingModel } : {})
    };
    savedFixtureServices = [saved];
    return saved;
  });
  // 合成模型列表：模拟 GET /v1/models 返回两个可用模型（e2e 不发真实网络）。
  handleTrusted('modelService.listModels', () => ({
    ok: true,
    models: [
      { id: 'fixture-model-a' },
      { id: 'fixture-model-b', displayName: 'fixture 模型 B' }
    ]
  }));
  // 生产设置面板会在加载/保存后并发读取用量汇总；fixture 也必须提供
  // 同形的空汇总，否则保存本身成功却会被缺失 IPC handler 伪装成失败。
  handleTrusted('modelService.usageSummary', () => ({
    calls: 0,
    reportedCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    byService: [],
    latestSession: null
  }));
  // 合成向量索引：模拟 /v1/embeddings 全量生成完成（e2e 不发真实网络）。
  handleTrusted('rag.embed', () => ({
    ok: true,
    embedded: 6,
    failed: 0,
    model: 'fixture-embed-model',
    dim: 384
  }));
  // 合成混合检索：返回固定命中（e2e 不依赖真实语料）。
  handleTrusted('rag.searchEvidence', () => ({
    ok: true,
    query: 'fixture query',
    hits: [{
      chunk: {
        chunkId: 'rag:event:fixture',
        workspaceId: 'fixture-ws',
        sourceUri: 'file://fixture/common.emevd.dcx',
        symbolUri: 'event://m10_00_00_00/1000',
        family: 'event',
        title: 'event 1000',
        body: 'event 1000\nSetEventFlag flag=71000000',
        numericIds: [1000, 71000000],
        contentHash: 'fixture-hash'
      },
      score: 200,
      reasons: ['id:71000000'],
      excerpt: 'event 1000\nSetEventFlag flag=71000000'
    }],
    stats: { scanned: 6, matched: 1, expanded: 0, truncated: false }
  }));
  handleTrusted('modelService.encryptionAvailable', () => false);
  handleTrusted('runtime.detectMe3', () => ({ detected: false }));

  handleTrusted('resource.readFmgDocument', () => ({
    ok: true,
    data: {
      sourceHash: fixture.fmg.sourceHash,
      entries: fixture.fmg.entries.map((entry) => ({ ...entry })),
      entryCount: fixture.fmg.entries.length,
      authority: 'fixture'
    }
  }));

  handleTrusted('resource.readFmgPage', (_event, _uri, page, pageSize) => {
    const start = page * pageSize;
    return {
      ok: true,
      entries: fixture.fmg.entries.slice(start, start + pageSize),
      page,
      pageCount: Math.max(1, Math.ceil(fixture.fmg.entries.length / pageSize)),
      entryCount: fixture.fmg.entries.length,
      maxId: fixture.fmg.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
      diagnostics: []
    };
  });

  // TEXT-20B：§9.1 文本工作台走目录链。fixture 登记 **两个** msgbnd 容器（zhocn
  // 语言）：item 容器挂 item.fmg（fixture.fmg.entries，写入后重读即见新文本），
  // menu 容器挂 menu.fmg（真空表，用于「真空表 ≠ 失败」断言）。11-B 之后左栏
  // 按容器分组，两个容器必须都在，否则 menu 组消失。与生产 main 的
  // readTextCatalog / readFmgTablePage 同语义：typed tableId 定位，条目由 main
  // 端按完整表过滤后分页。
  handleTrusted('resource.readTextCatalog', () => ({
    ok: true,
    libraryId: 'game-text',
    title: 'Text · 1 languages · 2 containers',
    languages: [{
      languageId: 'zhocn',
      containers: [
        {
          containerId: 'text:zhocn:item',
          containerKind: 'item',
          sourceUri: 'fixture://msg/test.msgbnd.dcx',
          relativePath: 'msg/test.msgbnd.dcx',
          parseStatus: 'confirmed',
          tableCount: 1,
          tables: [
            { tableId: 'text:zhocn:item:0-item.fmg', entryName: 'item.fmg', entryCount: fixture.fmg.entries.length, sourceUri: 'fixture://msg/test.msgbnd.dcx', entryIndex: 0 }
          ],
          diagnostics: []
        },
        {
          containerId: 'text:zhocn:menu',
          containerKind: 'menu',
          sourceUri: 'fixture://msg/menu.msgbnd.dcx',
          relativePath: 'msg/menu.msgbnd.dcx',
          parseStatus: 'confirmed',
          tableCount: 2,
          tables: [
            { tableId: 'text:zhocn:menu:0-menu.fmg', entryName: 'menu.fmg', entryCount: 0, sourceUri: 'fixture://msg/menu.msgbnd.dcx', entryIndex: 0 },
            { tableId: 'text:zhocn:menu:1-menu-long.fmg', entryName: 'menu-long.fmg', entryCount: fixture.fmg.longEntries.length, sourceUri: 'fixture://msg/menu.msgbnd.dcx', entryIndex: 1 }
          ],
          diagnostics: []
        }
      ]
    }],
    diagnostics: []
  }));

  handleTrusted('resource.readFmgTablePage', (_event, tableId, page, pageSize, query) => {
    if (fixture.fmg.menuEntries === undefined) fixture.fmg.menuEntries = [];
    // TEXT-20C：menu.fmg 是真空表，但写链（applyFmgMutation 按 tableId 路由到
    // menuEntries）落盘后重读必须可见——「真空表可新增」是 live 门禁放行的结果，
    // 不能让分页读取把它伪装回 0 条。3-C：menu-long.fmg 是长表（130 条只读）。
    const source = tableId.includes('menu-long')
      ? fixture.fmg.longEntries
      : tableId.includes('menu') ? fixture.fmg.menuEntries : fixture.fmg.entries;
    const q = (query ?? '').trim().toLowerCase();
    const filtered = q.length === 0
      ? source
      : source.filter((entry) =>
          String(entry.id).includes(q) || entry.text.toLowerCase().includes(q));
    return {
      ok: true,
      sourceUri: 'fixture://msg/test.msgbnd.dcx',
      sourceHash: fixture.fmg.sourceHash,
      entryCount: filtered.length,
      maxId: source.reduce((max, entry) => Math.max(max, entry.id), 0),
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(filtered.length / pageSize)),
      entries: filtered.slice(page * pageSize, page * pageSize + pageSize),
      diagnostics: []
    };
  });

  handleTrusted('resource.applyFmgMutation', (_event, _uri, expectedHash, mutation, tableId) => {
    if (APPLY_FAIL) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'ORIGINAL_CHANGED_DURING_STAGING',
          message: '写入校验时发现目标已被外部修改；未写入任何内容。'
        }]
      };
    }
    if (expectedHash !== fixture.fmg.sourceHash) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'HASH_PRECONDITION_FAILED',
          message: 'hash 前置条件不匹配，拒绝写入。'
        }]
      };
    }
    // TEXT-20C：mutation 带 tableId 时按表路由（menu.fmg 是真空表，单独维护，
    // 其余归 item.fmg = fixture.fmg.entries）。不带 tableId 的旧调用仍落 item。
    if (fixture.fmg.menuEntries === undefined) fixture.fmg.menuEntries = [];
    const source = typeof tableId === 'string' && tableId.includes('menu')
      ? fixture.fmg.menuEntries
      : fixture.fmg.entries;
    if (mutation.kind === 'delete') {
      if (source === fixture.fmg.entries) {
        fixture.fmg.entries = fixture.fmg.entries.filter((entry) => entry.id !== mutation.id);
      } else {
        fixture.fmg.menuEntries = fixture.fmg.menuEntries.filter((entry) => entry.id !== mutation.id);
      }
    } else if (mutation.kind === 'add') {
      source.push({ id: mutation.id, text: mutation.text ?? '' });
    } else {
      const existing = source.find((entry) => entry.id === mutation.id);
      if (existing) existing.text = mutation.text ?? '';
      else source.push({ id: mutation.id, text: mutation.text ?? '' });
    }
    fixture.fmg.sourceHash = `fixture-hash-${String(Number(fixture.fmg.sourceHash.split('-').pop()) + 1).padStart(4, '0')}`;
    return { ok: true, diagnostics: [] };
  });
}

async function createWindow({ withPreload }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: '#FBFBF9', // 与生产 light 首帧一致（main/index.ts TITLEBAR_OVERLAY）
    // 镜像生产窗口帧（main/index.ts createWindow）：hidden 无边框 + Windows/macOS
    // titleBarOverlay 为流光溢彩白，让 e2e 能断言「暗色窗口按钮区」不复现。Linux 无
    // overlay 字段，与生产一致。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'linux' ? {} : {
      titleBarOverlay: { color: '#FBFBF9', symbolColor: '#383C42', height: 40 }
    }),
    webPreferences: {
      ...(withPreload ? { preload: path.join(outRoot, 'preload', 'index.cjs') } : {}),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const rendererFile = path.join(outRoot, 'renderer', 'index.html');
  // 先登记受信任文档再加载，顺序与生产一致：登记晚于首个 IPC 调用会让正常
  // 启动路径被自己的安全校验拒绝。
  trustedRendererDocuments.set(
    window.webContents.id,
    normalizeRendererDocumentUrl(pathToFileURL(rendererFile).href)
  );
  window.webContents.once('destroyed', () => {
    trustedRendererDocuments.delete(window.webContents.id);
  });
  await window.loadFile(rendererFile);
  return window;
}

app.whenReady().then(async () => {
  registerFixtureIpc();
  if (BROWSER_PREVIEW) {
    // browser-preview 表面：无 preload，window.soulforge 不存在。
    await createWindow({ withPreload: false });
  } else {
    await createWindow({ withPreload: true });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
