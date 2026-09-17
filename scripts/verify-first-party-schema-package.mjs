#!/usr/bin/env node
/**
 * Verify the final Windows production payload, not only electron-vite's `out`.
 *
 * The first-party schema data is bundled into app.asar. The Bridge and the
 * native HKS compiler are deliberately unpacked resources, so both surfaces
 * are checked here. Development/validation adapters may exist in the source
 * tree, but they must not cross this package boundary.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const resourcesRoot = resolve(root, 'apps/desktop/release/win-unpacked/resources');
const archivePath = resolve(resourcesRoot, 'app.asar');
const requiredArchiveTokens = [
  'soulforge-sekiro-param',
  'soulforge-sekiro-emedf',
  'soulforge-sekiro-hks-schema',
  'sha256:e42fde9b453fad62490e0f6ee2bb9c34d37293313caf52b5df0f2747163d3daf',
  'sha256:37a75c056bf60046245651ee15f012fb3b6922c096fd8ad95901ad37609cd579',
  'update-settings',
  'rag-local-model-settings'
];
const forbiddenArchiveTokens = [
  'smithboxParamMetadataSource',
  'yappedParamMetadataSource',
  'emedfExternalAdapter',
  'realEmedfLocator',
  'dsLuaDecompilerLocator',
  'DSLuaDecompiler',
  'TAE.Template.SDT.xml',
  'SOULFORGE_DSLUADECOMPILER_PATH',
  'SOULFORGE_TAE_TEMPLATE_PATH',
  'SOULFORGE_EMEDF_PATH',
  'SOULFORGE_YAPPED_SDT_ROOT',
  'DarkScript3 安装',
  '设置环境变量'
];
const forbiddenArchivePath = [
  /(?:smithboxParamMetadataSource|yappedParamMetadataSource|emedfExternalAdapter|realEmedfLocator|dsLuaDecompilerLocator)(?:\.|\/|$)/iu,
  /TAE\.Template\.SDT\.xml/iu,
  /(?:^|\/)out\/.*(?:Smoke|\.test\.|\.spec\.|\/testing\/|_tmp)/iu,
  /(?:^|\/)node_modules\/@soulforge\/(?:core|shared)\/dist\/testing(?:\/|$)/iu
];
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.txt', '.md', '.yml']);
const findings = [];
let archiveReport = null;

if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
  findings.push({
    severity: 'error',
    code: 'FIRST_PARTY_PRODUCTION_ARCHIVE_MISSING',
    path: 'apps/desktop/release/win-unpacked/resources/app.asar',
    message: '缺少最终 app.asar；先运行 npm run exe:build。'
  });
} else {
  try {
    const archive = readAsarArchive(archivePath);
    const textEntries = archive.entries.filter((entry) => (
      !entry.unpacked && textExtensions.has(extname(entry.path).toLowerCase())
    ));
    const textContents = textEntries.map((entry) => ({
      entry,
      text: readAsarText(archive, entry)
    }));

    for (const marker of requiredArchiveTokens) {
      const hit = textContents.find((item) => item.text.includes(marker));
      if (hit) continue;
      findings.push({
        severity: 'error',
        code: 'FIRST_PARTY_MARKER_MISSING_FROM_APP_ASAR',
        path: 'apps/desktop/release/win-unpacked/resources/app.asar',
        message: `最终 app.asar 缺少 first-party/功能 marker：${marker}`
      });
    }

    const taeSchema = parseBundledTaeSchema(textContents);
    if (!taeSchema) {
      findings.push({
        severity: 'error',
        code: 'FIRST_PARTY_TAE_SCHEMA_MISSING_FROM_APP_ASAR',
        path: 'apps/desktop/release/win-unpacked/resources/app.asar',
        message: '最终 app.asar 未找到可解压校验的 first-party TAE schema。'
      });
    } else if (taeSchema.package !== 'soulforge-sekiro-tae-schema'
      || taeSchema.contentDigest !== 'sha256:3ef0d412b3742bbe6b230f289ef0f65e5f76baecc1831df313614e8ae22b099d'
      || taeSchema.eventCount !== 500
      || taeSchema.fieldCount !== 3459
      || !Array.isArray(taeSchema.banks)
      || taeSchema.banks.length !== 3) {
      findings.push({
        severity: 'error',
        code: 'FIRST_PARTY_TAE_SCHEMA_COVERAGE_INVALID_IN_APP_ASAR',
        path: 'apps/desktop/release/win-unpacked/resources/app.asar',
        message: '最终 app.asar 中的 TAE schema 身份或 500 事件/3459 字段覆盖不匹配。'
      });
    }

    for (const token of forbiddenArchiveTokens) {
      for (const item of textContents) {
        if (!item.text.includes(token)) continue;
        findings.push({
          severity: 'error',
          code: 'THIRD_PARTY_SCHEMA_ARTIFACT_IN_APP_ASAR',
          path: item.entry.path,
          message: `最终 app.asar 包含不应发布的第三方 schema/locator 内容：${token}`
        });
      }
    }

    for (const entry of archive.entries) {
      const match = forbiddenArchivePath.find((pattern) => pattern.test(entry.path));
      if (!match) continue;
      findings.push({
        severity: 'error',
        code: 'FORBIDDEN_DEVELOPMENT_FILE_IN_APP_ASAR',
        path: entry.path,
        message: '最终 app.asar 不得包含开发适配器、locator、testing 或 smoke 入口。'
      });
    }

    archiveReport = {
      archivePath: relative(root, archivePath).replaceAll('\\', '/'),
      headerBytes: archive.headerBytes,
      files: archive.entries.length,
      textFiles: textEntries.length,
      requiredMarkersFound: requiredArchiveTokens.filter((marker) => textContents.some((item) => item.text.includes(marker))),
      taeSchema: taeSchema
        ? { package: taeSchema.package, contentDigest: taeSchema.contentDigest, eventCount: taeSchema.eventCount, fieldCount: taeSchema.fieldCount, banks: taeSchema.banks.length }
        : null,
      forbiddenHits: forbiddenArchiveTokens.filter((token) => textContents.some((item) => item.text.includes(token)))
    };
  } catch (error) {
    findings.push({
      severity: 'error',
      code: 'FIRST_PARTY_APP_ASAR_READ_FAILED',
      path: 'apps/desktop/release/win-unpacked/resources/app.asar',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

const requiredResources = [
  'bridge/SoulForge.Bridge.exe',
  'bridge/SoulForge.Hksc.Native.dll',
  'native/better_sqlite3.node',
  'prompt/system.md',
  'prompt/native-read-safety.md'
];
for (const resource of requiredResources) {
  const path = resolve(resourcesRoot, resource);
  if (existsSync(path) && statSync(path).isFile()) continue;
  findings.push({
    severity: 'error',
    code: 'FIRST_PARTY_RESOURCE_MISSING_FROM_PACKAGE',
    path: `apps/desktop/release/win-unpacked/resources/${resource}`,
    message: `最终安装运行时缺少必需资源：${resource}`
  });
}

const errors = findings.filter((item) => item.severity === 'error');
const result = {
  ok: errors.length === 0,
  status: errors.length === 0 ? 'passed' : 'failed',
  message: errors.length === 0
    ? '最终 app.asar 与 unpacked resources 已包含 SoulForge first-party schema/Bridge/HKS 资源，且未包含第三方运行时适配器。'
    : '最终生产包 schema/runtime 边界失败。',
  archivePath: 'apps/desktop/release/win-unpacked/resources/app.asar',
  archive: archiveReport,
  requiredResources,
  findings
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;

function readAsarArchive(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 16) throw new Error('app.asar header is truncated.');
  const headerBytes = bytes.readUInt32LE(12);
  const headerEnd = 16 + headerBytes;
  if (headerBytes <= 0 || headerEnd > bytes.length) throw new Error('app.asar header length is invalid.');
  const header = JSON.parse(bytes.subarray(16, headerEnd).toString('utf8'));
  const entries = [];
  visitAsarNode(header, '', entries);
  return { bytes, headerBytes, dataOffset: headerEnd, entries };
}

function visitAsarNode(node, prefix, entries) {
  if (node && typeof node === 'object' && node.files && typeof node.files === 'object') {
    for (const [name, child] of Object.entries(node.files)) {
      visitAsarNode(child, `${prefix}/${name}`, entries);
    }
    return;
  }
  if (!node || typeof node !== 'object' || typeof node.size !== 'number') return;
  entries.push({
    path: prefix || '/',
    size: node.size,
    offset: node.offset === undefined ? null : Number(node.offset),
    unpacked: node.unpacked === true
  });
}

function readAsarText(archive, entry) {
  if (entry.offset === null || !Number.isSafeInteger(entry.offset) || entry.offset < 0) return '';
  const start = archive.dataOffset + entry.offset;
  const end = start + entry.size;
  if (start < archive.dataOffset || end > archive.bytes.length || end < start) return '';
  return archive.bytes.subarray(start, end).toString('utf8');
}

function parseBundledTaeSchema(textContents) {
  for (const item of textContents) {
    if (!item.text.includes('COMPRESSED_SCHEMA')) continue;
    const match = /const COMPRESSED_SCHEMA\s*=\s*`([\s\S]*?)`;/u.exec(item.text);
    if (!match) continue;
    try {
      return JSON.parse(gunzipSync(Buffer.from(match[1].replace(/\s+/gu, ''), 'base64')).toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}
