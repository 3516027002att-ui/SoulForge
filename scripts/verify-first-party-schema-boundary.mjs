#!/usr/bin/env node
/**
 * Production boundary verifier for the bundled Sekiro semantic schemas.
 *
 * This verifier is intentionally source-oriented: the third-party adapters
 * remain available to developer/validation tests, but no production entry
 * point may import them, scan their locations, or turn their environment
 * variables into runtime requirements.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

const productionFiles = [
  'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/main/ipc/event.ts',
  'apps/desktop/src/main/ipc/param.ts',
  'apps/desktop/src/main/ipc/raw.ts',
  'apps/desktop/src/main/ipc/resource.ts',
  'apps/desktop/src/main/ipc/action.ts',
  'apps/desktop/src/main/ipc/assets.ts',
  'apps/desktop/src/main/ragEmbedding.ts',
  'apps/desktop/src/main/ragEmbeddingWorker.ts',
  'apps/desktop/src/main/ragLocalModel.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/editors/EventSourceWorkbenchPanel.tsx',
  'apps/desktop/src/renderer/src/editors/ParamDefPanel.tsx',
  'apps/desktop/src/renderer/src/workbench/ParamWorkbench.tsx',
  'packages/core/src/ai/toolRegistry.ts',
  'packages/core/src/editing/emevdEdit.ts',
  'packages/core/src/editing/nativeEditSession.ts',
  'packages/core/src/emevd/emedfRegistryResolver.ts',
  'packages/core/src/index.ts',
  'packages/core/src/indexing/nativeSemanticRefresh.ts',
  'packages/core/src/param/containerParamEdit.ts',
  'packages/core/src/param/paramMetadata.ts',
  'packages/core/src/editing/luabndEdit.ts',
  'packages/core/src/editing/taeEdit.ts',
  'packages/core/src/editing/taeBridgeCommit.ts',
  'packages/core/src/script/scriptLoaderProfile.ts',
  'packages/core/src/workspace/workspaceSession.ts',
  'scripts/sf-edit.mjs'
];

const forbiddenProductionImport = /(?:from\s*|import\s*\(|require\s*\()(['"][^'"]*(?:smithboxParamMetadataSource|yappedParamMetadataSource|emedfExternalAdapter|realEmedfLocator)[^'"]*['"])/i;
const forbiddenProductionText = [
  'DSLuaDecompiler',
  'TAE.Template.SDT.xml',
  'SOULFORGE_DSLUADECOMPILER_PATH',
  'SOULFORGE_TAE_TEMPLATE_PATH',
  'SOULFORGE_EMEDF_PATH',
  'SOULFORGE_YAPPED_SDT_ROOT',
  'locateUserEmedfSync',
  'searchRealEmedf',
  'DarkScript3 安装',
  '设置环境变量'
];

const findings = [];
for (const sourcePath of [
  'packages/core/src/param/smithboxParamMetadataSource.ts',
  'packages/core/src/param/yappedParamMetadataSource.ts',
  'packages/core/src/emevd/emedfExternalAdapter.ts',
  'packages/core/src/script/dsLuaDecompilerLocator.ts',
  'packages/core/src/tae/taeEventTemplate.ts'
]) {
  if (!existsSync(resolve(root, sourcePath))) continue;
  findings.push({
    severity: 'error',
    code: 'THIRD_PARTY_ADAPTER_OUTSIDE_VALIDATION_BOUNDARY',
    path: sourcePath,
    message: '第三方适配器/locator 必须位于明确的 testing 边界，不能留在生产源码目录。'
  });
}
for (const relativePath of productionFiles) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    findings.push({
      severity: 'error',
      code: 'FIRST_PARTY_PRODUCTION_FILE_MISSING',
      path: relativePath,
      message: '生产边界清单中的入口文件不存在。'
    });
    continue;
  }
  const source = readFileSync(absolutePath, 'utf8');
  const importMatch = source.match(forbiddenProductionImport);
  if (importMatch) {
    findings.push({
      severity: 'error',
      code: 'THIRD_PARTY_SCHEMA_IMPORT_IN_PRODUCTION',
      path: relativePath,
      message: `生产入口导入了开发/验证 adapter：${importMatch[1]}`
    });
  }
  for (const token of forbiddenProductionText) {
    if (!source.includes(token)) continue;
    findings.push({
      severity: 'error',
      code: 'THIRD_PARTY_SCHEMA_RUNTIME_TOKEN_IN_PRODUCTION',
      path: relativePath,
      message: `生产入口包含第三方 schema 运行时绑定 token：${token}`
    });
  }
}

const indexSource = readFileSync(resolve(root, 'packages/core/src/index.ts'), 'utf8');
for (const adapter of [
  './param/smithboxParamMetadataSource.js',
  './param/yappedParamMetadataSource.js',
  './emevd/emedfExternalAdapter.js'
]) {
  if (!indexSource.includes(adapter)) continue;
  findings.push({
    severity: 'error',
    code: 'THIRD_PARTY_ADAPTER_EXPORTED_FROM_PRODUCTION_BARREL',
    path: 'packages/core/src/index.ts',
    message: `生产 barrel 不得导出开发/验证 adapter：${adapter}`
  });
}

const schemaSourcePath = 'packages/core/src/schema/sekiro/firstPartySchemaData.ts';
if (!existsSync(resolve(root, schemaSourcePath))) {
  findings.push({
    severity: 'error',
    code: 'FIRST_PARTY_SCHEMA_SOURCE_MISSING',
    path: schemaSourcePath,
    message: '仓库必须包含随 SoulForge 发布的 first-party schema 数据模块。'
  });
}

const coreLoaderPath = resolve(root, 'packages/core/dist/schema/sekiro/firstPartySchema.js');
const coreDataPath = resolve(root, 'packages/core/dist/schema/sekiro/firstPartySchemaData.js');
if (!existsSync(coreLoaderPath) || !existsSync(coreDataPath)) {
  findings.push({
    severity: 'error',
    code: 'FIRST_PARTY_SCHEMA_BUILD_OUTPUT_MISSING',
    path: 'packages/core/dist/schema/sekiro',
    message: 'core 构建产物缺少 first-party schema loader 或数据模块；先运行 core build。'
  });
}

let packageReport = null;
if (existsSync(coreLoaderPath) && existsSync(coreDataPath)) {
  try {
    const loader = await import(pathToFileURL(coreLoaderPath).href);
    const param = loader.loadFirstPartyParamMetadata();
    const emedf = loader.loadFirstPartyEmedfRegistry();
    const paramPackage = param.ok ? param.package : null;
    const emedfRegistry = emedf.ok ? emedf.registry : null;
    if (!param.ok || paramPackage === null) {
      findings.push({
        severity: 'error',
        code: 'FIRST_PARTY_PARAM_SCHEMA_INVALID',
        path: 'packages/core/dist/schema/sekiro/firstPartySchema.js',
        message: JSON.stringify(param.diagnostics)
      });
    } else {
      if (paramPackage.source.kind !== 'first-party'
        || paramPackage.definitions.length !== 160
        || paramPackage.definitions.some((entry) => entry.document.origin !== 'first-party')) {
        findings.push({
          severity: 'error',
          code: 'FIRST_PARTY_PARAM_SCHEMA_COVERAGE_INVALID',
          path: 'packages/core/dist/schema/sekiro/firstPartySchema.js',
          message: 'PARAM first-party provenance 或 160 条定义覆盖不满足发布边界。'
        });
      }
    }
    if (!emedf.ok || emedfRegistry === null) {
      findings.push({
        severity: 'error',
        code: 'FIRST_PARTY_EMEDF_SCHEMA_INVALID',
        path: 'packages/core/dist/schema/sekiro/firstPartySchema.js',
        message: JSON.stringify(emedf.diagnostics)
      });
    } else if (emedfRegistry.origin !== 'first-party'
      || emedfRegistry.instructions.length !== 405
      || emedfRegistry.banks?.length !== 27) {
      findings.push({
        severity: 'error',
        code: 'FIRST_PARTY_EMEDF_SCHEMA_COVERAGE_INVALID',
        path: 'packages/core/dist/schema/sekiro/firstPartySchema.js',
        message: 'EMEVD first-party provenance 或 405 指令/27 bank 覆盖不满足发布边界。'
      });
    }
    packageReport = {
      param: {
        status: param.ok ? 'valid' : 'invalid',
        origin: paramPackage?.source.kind ?? null,
        definitions: paramPackage?.definitions.length ?? 0,
        packageDigest: paramPackage?.packageDigest ?? null,
        nativeFormatAuthority: param.ok ? false : null
      },
      emevd: {
        status: emedf.ok ? 'valid' : 'invalid',
        origin: emedfRegistry?.origin ?? null,
        instructions: emedfRegistry?.instructions.length ?? 0,
        banks: emedfRegistry?.banks?.length ?? 0,
        contentDigest: emedfRegistry?.contentDigest ?? null
      }
    };
  } catch (error) {
    findings.push({
      severity: 'error',
      code: 'FIRST_PARTY_SCHEMA_LOADER_IMPORT_FAILED',
      path: 'packages/core/dist/schema/sekiro/firstPartySchema.js',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

const errors = findings.filter((item) => item.severity === 'error');
const result = {
  ok: errors.length === 0,
  status: errors.length === 0 ? 'passed' : 'failed',
  message: errors.length === 0
    ? '生产 schema 边界通过：PARAM/EMEVD 使用 SoulForge first-party 包，第三方 adapter 仅留在开发/验证边界。'
    : '生产 schema 边界失败。',
  productionFilesChecked: productionFiles.length,
  package: packageReport,
  findings
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
