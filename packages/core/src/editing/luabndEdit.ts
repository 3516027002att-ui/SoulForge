/**
 * Agent / CLI LuaBND facade.
 *
 * ����read-luabnd-script����ȡ�ű��ṹ��Havok �ֽ���������Ƕ����ű���Ԥ����
 * �У�list-luabnd-scripts / read-luabnd-document��ö�����������нű��ļ�������š�
 * д��write-luabnd-script �� applyNativeMutation -> Patch Engine �ύ����ֱ��д�̡�
 */
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Diagnostic } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { applyNativeMutation } from './editorMutationService.js';
import type { NativeEditSession } from './nativeEditSession.js';
import {
  resolveScriptLoaderProfile,
  canEditScriptAsSource
} from '../script/scriptLoaderProfile.js';

export interface LuabndScriptSnapshot {
  sanitizedName: string;
  size: number;
  uncompressedSize: number;
  contentHash: string;
  outerFileHash?: string;
  isBytecode: boolean;
  magic: string;
  variant: string;
  isPlainText: boolean;
  embeddedSymbols: string[];
  textPreview?: string | undefined;
  sourceHash: string;
  representation?: 'plaintext' | 'bytecode' | 'unknown' | undefined;
  detectedEncoding?: string | undefined;
  canWriteBack?: boolean | undefined;
  derivedSource?: string | undefined;
  decompilerVersion?: string | undefined;
  warnings?: string[] | undefined;
  loaderProfileId?: string | undefined;
  /** Complete first-party decompiled source for current Sekiro HKS bytecode. */
  sourceText?: string | undefined;
  dialect?: string | undefined;
  compilerProvenance?: { origin: 'first-party'; package: string; revision: string } | undefined;
  decompilerProvenance?: { origin: 'first-party'; package: string; revision: string } | undefined;
  /** A child-less read is a directory/catalog view, never script content. */
  status?: 'catalog-only' | 'native-read';
}

export interface LuabndEditFailure {
  code: string;
  message: string;
  details?: unknown | undefined;
}

export type LuabndReadResult =
  | { ok: true; containerPath: string; script: LuabndScriptSnapshot; diagnostics: Diagnostic[] }
  | { ok: false; error: LuabndEditFailure; diagnostics: Diagnostic[] };

export type LuabndListResult =
  | {
      ok: true;
      containerPath: string;
      sourceUri: string;
      outerFileHash: string;
      sourceRevision: number;
      catalogComplete: boolean;
      entryCount: number;
      scriptCount: number;
      scripts: Array<{
        name: string;
        sanitizedName: string;
        size: number;
        isBytecode: boolean;
        contentKind: 'source' | 'bytecode' | 'catalog-only';
        contentHash?: string;
        embeddedSymbolsSample?: string[];
      }>;
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: LuabndEditFailure; diagnostics: Diagnostic[] };

export type LuabndSetResult =
  | {
      ok: true;
      containerPath: string;
      childPath: string;
      beforeHash: string;
      afterHash: string;
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: LuabndEditFailure; diagnostics: Diagnostic[] };

async function resolveLuabndPath(edit: NativeEditSession, file: string): Promise<string | null> {
  const overlay = edit.session.layers.overlayRoot;
  const base = edit.session.layers.baseRoot;
  const candidates: string[] = [];
  if (isAbsolute(file)) {
    candidates.push(file);
  } else {
    candidates.push(resolve(file));
    candidates.push(join(overlay, file));
    candidates.push(join(overlay, 'script', file));
    if (!file.endsWith('.luabnd.dcx')) {
      candidates.push(join(overlay, 'script', `${file}.luabnd.dcx`));
    }
    if (base) {
      candidates.push(join(base, file));
      candidates.push(join(base, 'script', file));
      if (!file.endsWith('.luabnd.dcx')) {
        candidates.push(join(base, 'script', `${file}.luabnd.dcx`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function listLuabndScripts(input: {
  edit: NativeEditSession;
  file: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LuabndListResult> {
  const containerPath = await resolveLuabndPath(input.edit, input.file);
  if (!containerPath) {
    return {
      ok: false,
      error: { code: 'FILE_NOT_FOUND', message: `δ�ҵ� luabnd �ļ�: ${input.file}` },
      diagnostics: [
        {
          severity: 'error',
          code: 'FILE_NOT_FOUND',
          message: `δ�ҵ� luabnd �����ļ�: ${input.file}`,
          sourceUri: pathToFileURL(resolve(input.file)).href
        }
      ]
    };
  }

  const bridgeResult = await runBridge({
    command: 'read-luabnd-document',
    filePath: containerPath,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    allowedRoots: input.edit.allowedRoots()
  });

  const diagnostics = bridgeResult.diagnostics ?? [];
  if (!bridgeResult.data) {
    const primaryError = diagnostics.find((d) => d.severity === 'error');
    return {
      ok: false,
      error: {
        code: primaryError?.code ?? 'LUABND_READ_FAILED',
        message: primaryError?.message ?? 'ö�� luabnd �ű�ʧ�ܡ�',
        details: primaryError?.details
      },
      diagnostics
    };
  }

  const data = bridgeResult.data as any;
  const fileStat = await stat(containerPath);
  const outerFileHash = typeof data.outerFileHash === 'string' && data.outerFileHash.length > 0
    ? data.outerFileHash
    : typeof data.sourceHash === 'string' && data.sourceHash.length > 0
      ? data.sourceHash
      : await sha256File(containerPath);
  const sourceRevision = typeof data.sourceRevision === 'number' && Number.isFinite(data.sourceRevision)
    ? data.sourceRevision
    : fileStat.mtimeMs;
  const scripts = Array.isArray(data.scripts)
    ? data.scripts.map((s: any) => ({
        name: logicalScriptName(s.name ?? s.sanitizedName),
        sanitizedName: logicalScriptName(s.sanitizedName ?? s.name),
        size: typeof s.size === 'number' ? s.size : 0,
        isBytecode: Boolean(s.isBytecode),
        contentKind: s.isBytecode ? 'bytecode' : typeof s.sourceText === 'string' ? 'source' : 'catalog-only',
        ...(typeof s.contentHash === 'string' && s.contentHash.length > 0 ? { contentHash: s.contentHash } : {}),
        embeddedSymbolsSample: s.embeddedSymbolsSample ?? []
      }))
    : [];

  return {
    ok: true,
    containerPath,
    sourceUri: pathToFileURL(containerPath).href,
    outerFileHash,
    sourceRevision,
    catalogComplete: data.catalogComplete !== false,
    entryCount: data.entryCount ?? scripts.length,
    scriptCount: data.scriptCount ?? scripts.length,
    scripts,
    diagnostics
  };
}

export async function readLuabndScript(input: {
  edit: NativeEditSession;
  file: string;
  childPath?: string;
  expectedContainerHash?: string;
  expectedChildHash?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LuabndReadResult> {
  const containerPath = await resolveLuabndPath(input.edit, input.file);
  if (!containerPath) {
    return {
      ok: false,
      error: { code: 'FILE_NOT_FOUND', message: `δ�ҵ� luabnd �ļ�: ${input.file}` },
      diagnostics: [
        {
          severity: 'error',
          code: 'FILE_NOT_FOUND',
          message: `δ�ҵ� luabnd �����ļ�: ${input.file}`,
          sourceUri: pathToFileURL(resolve(input.file)).href
        }
      ]
    };
  }

  if (!input.childPath || input.childPath === '*' || input.childPath === 'list') {
    const listRes = await listLuabndScripts(input);
    if (!listRes.ok) return listRes;
    const names = listRes.scripts.map((s) => s.sanitizedName);
    return {
      ok: true,
      containerPath,
      script: {
        sanitizedName: 'SCRIPTS_IN_CONTAINER',
        size: 0,
        uncompressedSize: 0,
        contentHash: '',
        isBytecode: false,
        magic: '',
        variant: '',
        isPlainText: true,
        embeddedSymbols: names,
        textPreview: `Available scripts in ${basename(containerPath)} (${names.length}):\n` + names.join('\n'),
        sourceHash: '',
        outerFileHash: listRes.outerFileHash,
        representation: 'unknown',
        canWriteBack: false,
        status: 'catalog-only',
        warnings: ['仅返回容器目录；必须提供 childPath 才能读取实际脚本内容、sourceHash 和写回能力。']
      },
      diagnostics: listRes.diagnostics
    };
  }

  const bridgeResult = await runBridge({
    command: 'read-luabnd-script',
    filePath: containerPath,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    commandOptions: {
      childPath: input.childPath,
      ...(input.expectedContainerHash ? { expectedContainerHash: input.expectedContainerHash } : {}),
      ...(input.expectedChildHash ? { expectedChildHash: input.expectedChildHash } : {})
    },
    allowedRoots: input.edit.allowedRoots()
  });

  const diagnostics = bridgeResult.diagnostics ?? [];
  if (!bridgeResult.data) {
    const primaryError = diagnostics.find((d) => d.severity === 'error');
    let candidateHint = '';
    try {
      const doc = await runBridge({
        command: 'read-luabnd-document',
        filePath: containerPath,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
        allowedRoots: input.edit.allowedRoots()
      });
      const names = ((doc.data as any)?.scripts ?? []).map((s: any) => s.sanitizedName);
      if (names.length > 0) {
        candidateHint = `���������а�������ʵ�ű����� (${names.length}): ` + names.slice(0, 30).join(', ') + (names.length > 30 ? ' ��...' : '');
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: {
        code: primaryError?.code ?? 'LUABND_READ_FAILED',
        message: (primaryError?.message ?? '��ȡ luabnd �ű�ʧ�ܡ�') + candidateHint,
        details: primaryError?.details
      },
      diagnostics
    };
  }

  const data = bridgeResult.data as any;
  const isBytecode = Boolean(data.isBytecode);
  const profile = resolveScriptLoaderProfile({
    game: 'sekiro',
    containerPath,
    entryName: input.childPath,
    isBytecode
  });
  const representation: 'plaintext' | 'bytecode' | 'unknown' = isBytecode
    ? 'bytecode'
    : (data.isPlainText ? 'plaintext' : 'unknown');
  const canWriteBack = isBytecode
    ? (profile?.bytecodeToSourceAllowed ?? false)
    : (profile?.supportsPlaintextSourceEdit ?? true);

  let sourceText: string | undefined = !isBytecode && typeof data.textContent === 'string'
    ? data.textContent : undefined;
  let dialect: string | undefined;
  let compilerProvenance: LuabndScriptSnapshot['compilerProvenance'];
  let decompilerProvenance: LuabndScriptSnapshot['decompilerProvenance'];
  const semanticDiagnostics: Diagnostic[] = [];
  if (isBytecode && typeof data.contentBase64 === 'string' && data.contentBase64.length > 0) {
    const semantic = await runBridge<{
      sourceText?: string;
      dialect?: string;
      compiler?: { provenance?: string; package?: string; revision?: string };
      decompiler?: { provenance?: string; package?: string; revision?: string };
    }>({
      command: 'read-hks-source',
      filePath: containerPath,
      resourceUri: pathToFileURL(containerPath).href,
      ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
      commandOptions: { contentBase64: data.contentBase64 },
      allowedRoots: input.edit.allowedRoots(),
      timeoutMs: input.timeoutMs ?? 120_000,
      ...(input.signal ? { signal: input.signal } : {}),
      maxFrameBytes: 32 * 1024 * 1024
    });
    if (semantic.parseStatus === 'failed' || !semantic.data?.sourceText) {
      return {
        ok: false,
        error: {
          code: semantic.diagnostics.find((item) => item.severity === 'error')?.code ?? 'HKS_DOCUMENT_READ_FAILED',
          message: semantic.diagnostics.find((item) => item.severity === 'error')?.message
            ?? 'SoulForge 内置 HKS dialect 未能生成完整源码。',
          details: semantic.diagnostics
        },
        diagnostics: [...diagnostics, ...semantic.diagnostics]
      };
    }
    sourceText = semantic.data.sourceText;
    dialect = semantic.data.dialect;
    if (semantic.data.compiler?.provenance === 'first-party') {
      compilerProvenance = {
        origin: 'first-party',
        package: semantic.data.compiler.package ?? 'soulforge-sekiro-hks-schema',
        revision: semantic.data.compiler.revision ?? 'unknown'
      };
    }
    if (semantic.data.decompiler?.provenance === 'first-party') {
      decompilerProvenance = {
        origin: 'first-party',
        package: semantic.data.decompiler.package ?? 'soulforge-sekiro-hks-schema',
        revision: semantic.data.decompiler.revision ?? 'unknown'
      };
    }
    semanticDiagnostics.push(...semantic.diagnostics);
  }

  const scriptSnapshot: LuabndScriptSnapshot = {
    sanitizedName: data.sanitizedName ?? input.childPath,
    size: data.size ?? 0,
    uncompressedSize: data.uncompressedSize ?? 0,
    contentHash: data.contentHash ?? '',
    isBytecode,
    magic: data.magic ?? '',
    variant: data.variant ?? '',
    isPlainText: Boolean(data.isPlainText),
    embeddedSymbols: Array.isArray(data.embeddedSymbols) ? data.embeddedSymbols : [],
    textPreview: sourceText ?? (typeof data.textPreview === 'string' ? data.textPreview : undefined),
    sourceHash: data.sourceHash || data.contentHash || '',
    ...(typeof (data.outerFileHash ?? data.containerHash) === 'string' && (data.outerFileHash ?? data.containerHash).length > 0
      ? { outerFileHash: data.outerFileHash ?? data.containerHash }
      : {}),
    representation,
    detectedEncoding: isBytecode ? undefined : (data.detectedEncoding ?? 'shift_jis'),
    canWriteBack,
    derivedSource: typeof data.derivedSource === 'string' ? data.derivedSource : undefined,
    decompilerVersion: typeof data.decompilerVersion === 'string' ? data.decompilerVersion : undefined,
    warnings: Array.isArray(data.warnings) ? data.warnings : undefined,
    loaderProfileId: profile?.id,
    status: 'native-read',
    ...(sourceText !== undefined ? { sourceText } : {}),
    ...(dialect !== undefined ? { dialect } : {}),
    ...(compilerProvenance ? { compilerProvenance } : {}),
    ...(decompilerProvenance ? { decompilerProvenance } : {})
  };

  return {
    ok: true,
    containerPath,
    script: scriptSnapshot,
    diagnostics: [...diagnostics, ...semanticDiagnostics]
  };
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function logicalScriptName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export async function setLuabndScript(input: {
  edit: NativeEditSession;
  file: string;
  childPath: string;
  text?: string;
  contentBase64?: string;
  expectedContainerHash?: string;
  expectedChildHash?: string;
}): Promise<LuabndSetResult> {
  const containerPath = await resolveLuabndPath(input.edit, input.file);
  if (!containerPath) {
    return {
      ok: false,
      error: { code: 'FILE_NOT_FOUND', message: `δ�ҵ� luabnd �ļ�: ${input.file}` },
      diagnostics: [
        {
          severity: 'error',
          code: 'FILE_NOT_FOUND',
          message: `δ�ҵ� luabnd �����ļ�: ${input.file}`,
          sourceUri: pathToFileURL(resolve(input.file)).href
        }
      ]
    };
  }

  if (input.text === undefined && input.contentBase64 === undefined) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'setLuabndScript Ҫ text  contentBase64' },
      diagnostics: []
    };
  }

  let compiledContentBase64 = input.contentBase64;
  let existingScript: LuabndScriptSnapshot | undefined;
  if (input.text !== undefined) {
    const existing = await readLuabndScript({
      edit: input.edit,
      file: containerPath,
      childPath: input.childPath,
      ...(input.expectedContainerHash ? { expectedContainerHash: input.expectedContainerHash } : {}),
      ...(input.expectedChildHash ? { expectedChildHash: input.expectedChildHash } : {})
    });
    if (!existing.ok) return existing;
    existingScript = existing.script;
    if (existing.script.isBytecode) {
      const isBytecode = true;
      const profile = resolveScriptLoaderProfile({
        game: 'sekiro',
        containerPath,
        entryName: input.childPath,
        isBytecode
      });
      const check = canEditScriptAsSource(profile, isBytecode);
      if (!check.allowed) {
        return {
          ok: false,
          error: { code: check.code ?? 'SCRIPT_SOURCE_EDIT_PROHIBITED', message: check.message ?? '该条目不允许作为源码文本写回。' },
          diagnostics: [{ severity: 'error', code: check.code ?? 'SCRIPT_SOURCE_EDIT_PROHIBITED', message: check.message ?? '该条目不允许作为源码文本写回。', sourceUri: pathToFileURL(resolve(containerPath)).href }]
        };
      }
      const raw = await runBridge<{
        contentBase64?: string;
        contentHash?: string;
      }>({
        command: 'read-luabnd-script',
        filePath: containerPath,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
        commandOptions: {
          childPath: input.childPath,
          ...(input.expectedContainerHash ? { expectedContainerHash: input.expectedContainerHash } : {}),
          ...(input.expectedChildHash ? { expectedChildHash: input.expectedChildHash } : {})
        },
        allowedRoots: input.edit.allowedRoots(),
        timeoutMs: 120_000,
        maxFrameBytes: 32 * 1024 * 1024
      });
      if (raw.parseStatus === 'failed' || !raw.data?.contentBase64) {
        return {
          ok: false,
          error: { code: 'HKS_SOURCE_READ_FAILED', message: '编译 HKS 源码前无法取得带哈希的原始字节。' },
          diagnostics: raw.diagnostics
        };
      }
      const sourceHash = raw.data.contentHash ?? existing.script.contentHash;
      const compiled = await runBridge<{
        contentBase64?: string;
      }>({
        command: 'compile-hks-source',
        filePath: containerPath,
        resourceUri: pathToFileURL(containerPath).href,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
        commandOptions: {
          sourceText: input.text,
          expectedDialect: existing.script.dialect ?? 'sekiro-hks-1.6.x',
          expectedSourceHash: sourceHash,
          sourceContentBase64: raw.data.contentBase64
        },
        allowedRoots: input.edit.allowedRoots(),
        timeoutMs: 120_000,
        maxFrameBytes: 32 * 1024 * 1024
      });
      if (compiled.parseStatus === 'failed' || !compiled.data?.contentBase64) {
        return {
          ok: false,
          error: { code: compiled.diagnostics[0]?.code ?? 'HKS_COMPILER_FAILED', message: compiled.diagnostics[0]?.message ?? 'SoulForge 内置 HKS 编译器未返回字节码。' },
          diagnostics: compiled.diagnostics
        };
      }
      compiledContentBase64 = compiled.data.contentBase64;
    }
  }

  if (input.text !== undefined && !existingScript) {
    // This branch is unreachable because text always reads the current child
    // above; keep the invariant explicit for future callers.
    return {
      ok: false,
      error: { code: 'HKS_SOURCE_READ_FAILED', message: '源码写回缺少当前条目读取证明。' },
      diagnostics: []
    };
  }

  const diskBytes = await readFile(containerPath);
  const currentContainerHash = createHash('sha256').update(diskBytes).digest('hex');
  if (input.expectedContainerHash && !input.expectedContainerHash.toLowerCase().includes(currentContainerHash.toLowerCase())) {
    return {
      ok: false,
      error: {
        code: 'LUABND_CONTAINER_HASH_MISMATCH',
        message: `luabnd ������ϣ��ƥ�䣺���� ${input.expectedContainerHash}��ʵ�� ${currentContainerHash}`
      },
      diagnostics: []
    };
  }

  const indexedFile = await input.edit.indexFile(containerPath, 'script');
  const sourceUri = pathToFileURL(containerPath).href;

  const outcome = await applyNativeMutation(
    {
      file: { ...indexedFile, sha256: currentContainerHash },
      expectedHash: currentContainerHash,
      stagingRoot: input.edit.stagingRoot,
      allowedRoots: () => [...input.edit.allowedRoots()],
      stagingPrefix: 'luabnd',
      stagingFileName: `${basename(containerPath)}.mut.dcx`,
      sourceUri,
      title: `�޸� Lua �ű�: ${input.childPath} (${basename(containerPath)})`,
      confirmActionLabel: `�޸� Lua �ű�: ${input.childPath}`,
      stageWrite: async (context) => {
        const res = await runBridge({
          command: 'write-luabnd-script',
          filePath: containerPath,
          ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
          commandOptions: {
            outputPath: context.outputPath,
            childPath: input.childPath,
            expectedContainerHash: currentContainerHash,
            ...(input.text !== undefined && compiledContentBase64 === undefined ? { text: input.text } : {}),
            ...(compiledContentBase64 !== undefined ? { contentBase64: compiledContentBase64 } : {}),
            ...(input.expectedChildHash ? { expectedChildHash: input.expectedChildHash } : {})
          },
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots
        });
        return {
          ok: res.data !== null && res.data !== undefined,
          diagnostics: res.diagnostics
        };
      }
    },
    {
      ...(input.edit.confirmationPort ? { confirm: input.edit.confirmationPort } : {}),
      commit: input.edit.commitPort
    }
  );

  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics = outcome.status === 'failed'
      ? outcome.diagnostics
      : outcome.status === 'committed'
        ? outcome.result.diagnostics
        : [{
            severity: 'error' as const,
            code: 'LUABND_WRITE_CANCELLED',
            message: 'д�뱻ȡ����',
            sourceUri
          }];
    return {
      ok: false,
      error: {
        code: diagnostics[0]?.code ?? 'LUABND_MUTATION_FAILED',
        message: diagnostics[0]?.message ?? '�޸� luabnd �ű�д��ʧ�ܡ�',
        details: outcome
      },
      diagnostics
    };
  }

  const postBytes = await readFile(containerPath);
  const afterHash = createHash('sha256').update(postBytes).digest('hex');

  return {
    ok: true,
    containerPath,
    childPath: input.childPath,
    beforeHash: currentContainerHash,
    afterHash,
    diagnostics: outcome.result.diagnostics ?? []
  };
}
