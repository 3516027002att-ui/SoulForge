/**
 * Agent / CLI LuaBND facade.
 *
 * ����read-luabnd-script����ȡ�ű��ṹ��Havok �ֽ���������Ƕ����ű���Ԥ����
 * �У�list-luabnd-scripts / read-luabnd-document��ö�����������нű��ļ�������š�
 * д��write-luabnd-script �� applyNativeMutation -> Patch Engine �ύ����ֱ��д�̡�
 */
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Diagnostic } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { applyNativeMutation } from './editorMutationService.js';
import type { NativeEditSession } from './nativeEditSession.js';

export interface LuabndScriptSnapshot {
  sanitizedName: string;
  size: number;
  uncompressedSize: number;
  contentHash: string;
  isBytecode: boolean;
  magic: string;
  variant: string;
  isPlainText: boolean;
  embeddedSymbols: string[];
  textPreview?: string;
  sourceHash: string;
}

export interface LuabndEditFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type LuabndReadResult =
  | { ok: true; containerPath: string; script: LuabndScriptSnapshot; diagnostics: Diagnostic[] }
  | { ok: false; error: LuabndEditFailure; diagnostics: Diagnostic[] };

export type LuabndListResult =
  | {
      ok: true;
      containerPath: string;
      entryCount: number;
      scriptCount: number;
      scripts: Array<{
        name: string;
        sanitizedName: string;
        size: number;
        isBytecode: boolean;
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
  const scripts = Array.isArray(data.scripts)
    ? data.scripts.map((s: any) => ({
        name: s.name,
        sanitizedName: s.sanitizedName,
        size: s.size,
        isBytecode: Boolean(s.isBytecode),
        embeddedSymbolsSample: s.embeddedSymbolsSample ?? []
      }))
    : [];

  return {
    ok: true,
    containerPath,
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
        sourceHash: ''
      },
      diagnostics: listRes.diagnostics
    };
  }

  const bridgeResult = await runBridge({
    command: 'read-luabnd-script',
    filePath: containerPath,
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
  const scriptSnapshot: LuabndScriptSnapshot = {
    sanitizedName: data.sanitizedName ?? input.childPath,
    size: data.size ?? 0,
    uncompressedSize: data.uncompressedSize ?? 0,
    contentHash: data.contentHash ?? '',
    isBytecode: Boolean(data.isBytecode),
    magic: data.magic ?? '',
    variant: data.variant ?? '',
    isPlainText: Boolean(data.isPlainText),
    embeddedSymbols: Array.isArray(data.embeddedSymbols) ? data.embeddedSymbols : [],
    textPreview: typeof data.textPreview === 'string' ? data.textPreview : undefined,
    sourceHash: data.sourceHash || data.contentHash || ''
  };

  return {
    ok: true,
    containerPath,
    script: scriptSnapshot,
    diagnostics
  };
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
      error: { code: 'INVALID_INPUT', message: 'setLuabndScript ��Ҫ text �� contentBase64��' },
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
            ...(input.text !== undefined ? { text: input.text } : {}),
            ...(input.contentBase64 !== undefined ? { contentBase64: input.contentBase64 } : {}),
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
