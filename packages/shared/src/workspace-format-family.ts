/**
 * 工作区文件的格式族与第一层打开种类。
 *
 * 只根据相对路径的复合后缀判定，不读文件、不调 Bridge。
 * renderer 的 selectEditor / 加载门和 native 完成度矩阵共用这份表，
 * 避免「前端按目录名加载、矩阵按后缀打开」再分叉。
 *
 * 没有真实 parser 的族记 blocked-*，不得伪装成已语义可读。
 */

export type WorkspaceOpenKind =
  | 'param-container'
  | 'param-rows'
  | 'gparam'
  | 'fmg'
  | 'emevd'
  | 'msb'
  | 'script'
  | 'plain-text'
  | 'tae'
  | 'esd'
  | 'flver'
  | 'tpf'
  | 'vfx'
  | 'container'
  | 'history'
  | 'blocked-no-parser'
  | 'blocked-scope'
  | 'binary';

export interface WorkspaceFormatFamily {
  familyId: string;
  openKind: WorkspaceOpenKind;
}

const FAMILY_RULES: ReadonlyArray<{ suffix: string; familyId: string; openKind: WorkspaceOpenKind }> = [
  { suffix: '.emevd.dcx.bak', familyId: '.emevd.dcx.bak', openKind: 'history' },
  { suffix: '.emevd.dcx.js', familyId: '.emevd.dcx.js', openKind: 'plain-text' },
  { suffix: '.emevd.dcx', familyId: '.emevd.dcx', openKind: 'emevd' },
  { suffix: '.emevd', familyId: '.emevd', openKind: 'emevd' },
  { suffix: '.msb.dcx', familyId: '.msb.dcx', openKind: 'msb' },
  { suffix: '.msb', familyId: '.msb', openKind: 'msb' },
  { suffix: '.parambnd.dcx.bak', familyId: '.parambnd.dcx.bak', openKind: 'history' },
  { suffix: '.parambnd.dcx', familyId: '.parambnd.dcx', openKind: 'param-container' },
  { suffix: '.parambnd', familyId: '.parambnd', openKind: 'param-container' },
  { suffix: '.gameparambnd.dcx', familyId: '.gameparambnd.dcx', openKind: 'param-container' },
  { suffix: '.drawparambnd.dcx', familyId: '.drawparambnd.dcx', openKind: 'param-container' },
  { suffix: '.gparam.dcx', familyId: '.gparam.dcx', openKind: 'gparam' },
  { suffix: '.gparam', familyId: '.gparam', openKind: 'gparam' },
  { suffix: '.msgbnd.dcx', familyId: '.msgbnd.dcx', openKind: 'fmg' },
  { suffix: '.fmg.dcx', familyId: '.fmg.dcx', openKind: 'fmg' },
  { suffix: '.fmg', familyId: '.fmg', openKind: 'fmg' },
  { suffix: '.luabnd.dcx', familyId: '.luabnd.dcx', openKind: 'script' },
  { suffix: '.talkesdbnd.dcx.bak', familyId: '.talkesdbnd.dcx.bak', openKind: 'history' },
  { suffix: '.talkesdbnd.dcx', familyId: '.talkesdbnd.dcx', openKind: 'esd' },
  { suffix: '.anibnd.dcx', familyId: '.anibnd.dcx', openKind: 'tae' },
  { suffix: '.tae.dcx', familyId: '.tae.dcx', openKind: 'tae' },
  { suffix: '.tae', familyId: '.tae', openKind: 'tae' },
  { suffix: '.esd.dcx', familyId: '.esd.dcx', openKind: 'esd' },
  { suffix: '.esd', familyId: '.esd', openKind: 'esd' },
  { suffix: '.texbnd.dcx', familyId: '.texbnd.dcx', openKind: 'tpf' },
  { suffix: '.tpf.dcx', familyId: '.tpf.dcx', openKind: 'tpf' },
  { suffix: '.tpf', familyId: '.tpf', openKind: 'tpf' },
  { suffix: '.ffxbnd.dcx', familyId: '.ffxbnd.dcx', openKind: 'vfx' },
  { suffix: '.fxr.dcx', familyId: '.fxr.dcx', openKind: 'vfx' },
  { suffix: '.fxr', familyId: '.fxr', openKind: 'vfx' },
  { suffix: '.chrbnd.dcx', familyId: '.chrbnd.dcx', openKind: 'container' },
  { suffix: '.objbnd.dcx', familyId: '.objbnd.dcx', openKind: 'container' },
  { suffix: '.mapbnd.dcx', familyId: '.mapbnd.dcx', openKind: 'container' },
  { suffix: '.behbnd.dcx', familyId: '.behbnd.dcx', openKind: 'blocked-scope' },
  { suffix: '.sblytbnd.dcx', familyId: '.sblytbnd.dcx', openKind: 'blocked-no-parser' },
  { suffix: '.btl.dcx', familyId: '.btl.dcx', openKind: 'blocked-no-parser' },
  { suffix: '.gfx', familyId: '.gfx', openKind: 'blocked-no-parser' },
  { suffix: '.flver.dcx', familyId: '.flver.dcx', openKind: 'flver' },
  { suffix: '.flver', familyId: '.flver', openKind: 'flver' },
  { suffix: '.param', familyId: '.param', openKind: 'param-rows' },
  // S39（2026-08-18）：裸 .hks/.lua 与 selectEditor 同口径——点开走脚本 IDE
  // （与 .luabnd.dcx 同一读链）。侧栏归属由 domainLibraries 按路径段另行分类
  // （action/script/*.hks 进「动作」域），不影响打开路由。
  { suffix: '.hks', familyId: '.hks', openKind: 'script' },
  { suffix: '.lua', familyId: '.lua', openKind: 'script' },
  { suffix: '.bak', familyId: '.bak', openKind: 'history' }
];

const TEXT_SUFFIXES = new Set([
  '.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.js', '.ts',
  '.csv', '.ini', '.cfg', '.toml', '.log'
]);

export function normalizeWorkspaceRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

export function classifyWorkspaceOpen(relativePath: string): WorkspaceFormatFamily {
  const normalized = normalizeWorkspaceRelativePath(relativePath).toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (normalized.endsWith(rule.suffix)) {
      return { familyId: rule.familyId, openKind: rule.openKind };
    }
  }
  const dot = normalized.lastIndexOf('.');
  const slash = normalized.lastIndexOf('/');
  const ext = dot > slash ? normalized.slice(dot) : '';
  if (TEXT_SUFFIXES.has(ext)) {
    return { familyId: ext, openKind: 'plain-text' };
  }
  if (normalized.endsWith('.dcx') || normalized.includes('.bnd')) {
    return { familyId: ext || '.dcx', openKind: 'container' };
  }
  return { familyId: ext || '(none)', openKind: 'binary' };
}

export function isHistoryArtifactPath(relativePath: string): boolean {
  return classifyWorkspaceOpen(relativePath).openKind === 'history';
}

export function isSemanticOpenKind(kind: WorkspaceOpenKind): boolean {
  return kind !== 'history'
    && kind !== 'blocked-no-parser'
    && kind !== 'blocked-scope'
    && kind !== 'binary';
}
