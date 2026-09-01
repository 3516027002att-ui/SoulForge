import type { RendererIndexedFile } from '../../../main/rendererDto.js';

/**
 * 命令面板只搜索 renderer 已拿到的索引投影。
 * 不把 sourceUri、诊断或物理路径加入可搜索文本，避免把脱敏边界变成第二套资源目录。
 */
export type CommandPaletteResource = Pick<
  RendererIndexedFile,
  'relativePath' | 'resourceKind' | 'extension' | 'compoundExtension' | 'formatKind' | 'formatLabel'
>;

/**
 * 将用户输入和索引文本投影到同一套 token：
 * - NFKC 让全角字母/数字也能命中；
 * - slash、反斜杠、点号、下划线、连字符和空白统一成分隔符；
 * - Unicode 字母/数字与中文保留，中文短语可以作为连续 token 命中。
 */
export function normalizeCommandSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function matchesCommandSearch(value: string, query: string): boolean {
  const terms = normalizeCommandSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = normalizeCommandSearchText(value);
  return terms.every((term) => text.includes(term));
}

function commandPaletteBasename(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').split('/').pop() ?? relativePath;
}

function commandPaletteStem(relativePath: string): string {
  const basename = commandPaletteBasename(relativePath);
  const firstExtension = basename.indexOf('.');
  return firstExtension > 0 ? basename.slice(0, firstExtension) : basename;
}

function startsWithSearchTerm(value: string, query: string): boolean {
  return value === query || value.startsWith(`${query} `);
}

function commandResourceRank(file: CommandPaletteResource, query: string): number {
  const normalizedPath = normalizeCommandSearchText(file.relativePath);
  const normalizedName = normalizeCommandSearchText(commandPaletteBasename(file.relativePath));
  const normalizedStem = normalizeCommandSearchText(commandPaletteStem(file.relativePath));

  // Exact path/name wins over a sibling with the same prefix when Enter is used.
  if (normalizedPath === query) return 10_000;
  if (normalizedName === query) return 9_000;
  // A bare basename such as "c0000" should prefer c0000.anibnd.dcx over
  // c0000_a000_lo.anibnd.dcx, while still leaving all indexed matches visible.
  if (normalizedStem === query) return 8_000;
  if (startsWithSearchTerm(normalizedStem, query)) return 1_000;
  return 0;
}

function commandResourceSearchText(file: CommandPaletteResource): string {
  return [
    file.relativePath,
    file.resourceKind,
    file.extension,
    file.compoundExtension,
    file.formatKind,
    file.formatLabel
  ].join(' ');
}

/**
 * 在 renderer 已有的索引文件集合内筛选资源。
 * 传入集合之外的资源永远不会被补造；原始顺序只作为最终并列时的稳定 tie-breaker。
 */
export function filterCommandPaletteResources<T extends CommandPaletteResource>(
  files: readonly T[],
  query: string
): T[] {
  const normalizedQuery = normalizeCommandSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => matchesCommandSearch(commandResourceSearchText(file), normalizedQuery))
    .sort((left, right) =>
      commandResourceRank(right.file, normalizedQuery) - commandResourceRank(left.file, normalizedQuery)
      || left.index - right.index
    )
    .map(({ file }) => file);
}
