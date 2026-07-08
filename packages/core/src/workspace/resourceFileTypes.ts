import type { ResourceFormatKind } from '@soulforge/shared';

export interface ResourceFileTypeInfo {
  extension: string;
  compoundExtension: string;
  formatKind: ResourceFormatKind;
  formatLabel: string;
}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yml',
  '.yaml',
  '.lua',
  '.hks',
  '.js',
  '.ts',
  '.csv',
  '.ini',
  '.cfg',
  '.toml',
  '.log'
]);

const COMPOUND_PATTERNS: Array<{ suffix: string; formatKind: ResourceFormatKind; label: string }> = [
  { suffix: '.emevd.dcx.bak', formatKind: 'backup', label: 'EMEVD DCX Backup' },
  { suffix: '.emevd.dcx.js', formatKind: 'text', label: 'DarkScript JS Event' },
  { suffix: '.emevd.dcx', formatKind: 'emevd', label: 'EMEVD DCX' },
  { suffix: '.msb.dcx', formatKind: 'msb', label: 'MSB DCX' },
  { suffix: '.parambnd.dcx', formatKind: 'param', label: 'PARAM BND DCX' },
  { suffix: '.gameparambnd.dcx', formatKind: 'param', label: 'GameParam BND DCX' },
  { suffix: '.drawparambnd.dcx', formatKind: 'param', label: 'DrawParam BND DCX' },
  { suffix: '.fmg.dcx', formatKind: 'fmg', label: 'FMG DCX' },
  { suffix: '.msgbnd.dcx', formatKind: 'fmg', label: 'MSG BND DCX' },
  { suffix: '.luabnd.dcx', formatKind: 'lua', label: 'Lua BND DCX' },
  { suffix: '.talkesdbnd.dcx', formatKind: 'lua', label: 'Talk ESD BND DCX' },
  { suffix: '.hks', formatKind: 'hks', label: 'HKS Action Script' },
  { suffix: '.anibnd.dcx', formatKind: 'bnd', label: 'Animation BND DCX' },
  { suffix: '.chrbnd.dcx', formatKind: 'bnd', label: 'Character BND DCX' },
  { suffix: '.behbnd.dcx', formatKind: 'bnd', label: 'Behavior BND DCX' },
  { suffix: '.texbnd.dcx', formatKind: 'tpf', label: 'Texture BND DCX' },
  { suffix: '.objbnd.dcx', formatKind: 'bnd', label: 'Object BND DCX' },
  { suffix: '.ffxbnd.dcx', formatKind: 'bnd', label: 'SFX BND DCX' },
  { suffix: '.tpf.dcx', formatKind: 'tpf', label: 'Texture TPF DCX' },
  { suffix: '.bnd.dcx', formatKind: 'bnd', label: 'BND DCX' },
  { suffix: '.dcx', formatKind: 'dcx', label: 'DCX Archive' },
  { suffix: '.bnd', formatKind: 'bnd', label: 'BND Archive' },
  { suffix: '.gfx', formatKind: 'gfx', label: 'Scaleform GFX' },
  { suffix: '.tpf', formatKind: 'tpf', label: 'Texture TPF' },
  { suffix: '.bak', formatKind: 'backup', label: 'Backup File' }
];

export function detectResourceFileType(relativePath: string): ResourceFileTypeInfo {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const extension = getLastExtension(normalized);

  for (const pattern of COMPOUND_PATTERNS) {
    if (normalized.endsWith(pattern.suffix)) {
      return {
        extension,
        compoundExtension: pattern.suffix,
        formatKind: pattern.formatKind,
        formatLabel: pattern.label
      };
    }
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return {
      extension,
      compoundExtension: extension,
      formatKind: 'text',
      formatLabel: 'Text File'
    };
  }

  return {
    extension,
    compoundExtension: extension,
    formatKind: 'unknown',
    formatLabel: extension ? `${extension.slice(1).toUpperCase()} File` : 'Unknown File'
  };
}

function getLastExtension(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex) : '';
}
