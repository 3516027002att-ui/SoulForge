/**
 * SCRIPT / AI reference provider.
 *
 * Never invents script existence from role-number patterns (cXXXX_ai.lua).
 * Relations come only from real script text via ports.readScriptText + the
 * original Lua subset scanner. Comments/strings are not relations. Local
 * shadowing of known globals is not a confirmed game API reference. Dynamic
 * args are hypothesis or unresolved diagnostics. Bytecode / no-text yields
 * coverage unsupported/partial — never a fake source-text statement.
 */
import type {
  ProviderRelationDraft,
  ReferenceProvider,
  ReferenceProviderCapability,
  ReferenceProviderCollectInput,
  ReferenceProviderCollectResult
} from './referenceProviderRegistry.js';
import {
  parseLuaCallOccurrences,
  luaIsShadowedByLocal,
  luaIsDynamicCall,
  type LuaCallOccurrence
} from './luaStaticSubset.js';

interface ScriptTargetLike {
  domain?: 'script' | 'ai' | string;
  sourceUri: string;
  childChain?: string[];
  scriptEntryIndex?: number;
  workspaceId?: string;
  name?: string;
  outerId?: string;
  format?: string;
  classification?: string;
  hasSourceText?: boolean;
}

interface ScriptTextPortResult {
  text?: string;
  childChain?: string[];
  sourceUri?: string;
  sourceHash?: string;
  classification?: string;
  ok?: boolean;
  bytecode?: boolean;
  diagnostics?: Array<{ code?: string; message?: string }>;
}

/**
 * Conservative known game/API globals that may appear in Sekiro AI/Lua scripts.
 * Only these can become confirmed `script_call` edges when unshadowed and the
 * callee name is an exact known global.
 */
const KNOWN_GAME_API_GLOBALS = new Set<string>([
  'GetLocalHandle',
  'GetChrType',
  'GetState',
  'GetEventStatus',
  'SetEventFlag',
  'GetEventFlag',
  'ClearEventEffect',
  'GetParam',
  'AICommand',
  'GetEntityId',
  'GetEntityModel',
  'IsAlive',
  'IsDead',
  'IsPlayer',
  'GetDistance',
  'GetHp',
  'SetHp',
  'GetMaxHp',
  'IsNetworkPlayer',
  'SetCharacterGravity',
  'GetTarget',
  'ClearTarget',
  'MoveTo',
  'TurnTo',
  'ForceAnimationPlayback',
  'GetAnimId',
  'BeginAction',
  'GetCustomParam',
  'GetReturnState',
  'GetTalkListId',
  'SetLogic',
  'GetLogic',
  'GetGeneralPurposeEventId',
  'GetSummonedCharacterId',
  'GetLocalPlayerId',
  'SetNpcThinkParam',
  'SetNpcParam',
  'SetNpcState',
  'GetNpcThinkParam',
  'GetRateFromParam',
  'GetSummonedCharacter',
  'IsSearchTarget',
  'ClearInterrupt',
  'GetSummonedState',
  'SetEventGeneration',
  'GetSpEffectStatus',
  'HasSpEffect'
]);

const REQUIRE_NAMES = new Set<string>(['require', 'Require', 'dofile', 'loadfile']);

export function createScriptReferenceProvider(): ReferenceProvider {
  return {
    id: 'script',
    domains: ['script', 'ai'],
    capabilities(): ReferenceProviderCapability[] {
      return [
        {
          resourceKind: 'script',
          formatFamilies: ['lua', 'luabnd', 'hks'],
          support: 'supported',
          relationKinds: ['script_call', 'script_require'],
          nativeReader: 'read_script_source',
          writerSupported: true
        },
        {
          resourceKind: 'ai',
          formatFamilies: ['lua', 'luabnd', 'hks'],
          support: 'supported',
          relationKinds: ['script_call', 'script_require'],
          nativeReader: 'read_script_source',
          writerSupported: true
        }
      ];
    },
    async collect(input: ReferenceProviderCollectInput): Promise<ReferenceProviderCollectResult> {
      const diagnostics: ReferenceProviderCollectResult['diagnostics'] = [];
      const coverageNotes: ReferenceProviderCollectResult['coverageNotes'] = [];
      const relations: ProviderRelationDraft[] = [];

      const target = input.target as ScriptTargetLike | null | undefined;
      if (!target || typeof target.sourceUri !== 'string' || target.sourceUri.trim() === '') {
        diagnostics.push({
          code: 'SCRIPT_TARGET_REQUIRED',
          message: 'SCRIPT provider 需要带 sourceUri 的 script/ai 目标。',
          severity: 'error'
        });
        coverageNotes.push({ domain: 'script', status: 'failed', notes: ['target_missing'] });
        return { relations, coverageNotes, diagnostics };
      }

      const domain = target.domain === 'ai' ? 'ai' : 'script';
      const sourceUri = target.sourceUri;
      const workspaceId = target.workspaceId ?? 'unknown';
      const childChain = target.childChain ?? (target.name ? [target.name] : [sourceUri]);

      const fromIdentity = {
        workspaceId,
        domain: domain as 'script' | 'ai',
        sourceUri,
        outerId: target.outerId ?? sourceUri,
        childChain,
        namespace: childChain[0] ?? domain,
        objectKey: `script:${sourceUri}#${target.scriptEntryIndex ?? 0}`,
        ...(target.scriptEntryIndex !== undefined ? { entryIndex: target.scriptEntryIndex } : {}),
        ...(target.name ? { entryName: target.name } : {}),
        ...(target.name ? { label: target.name } : {})
      };

      // Explicitly refuse role-number pattern invention when no port/source is available.
      const looksLikeRolePattern = /c\d{3,5}_ai\.lua$/i.test(sourceUri) || /c\d{3,5}_.*\.lua$/i.test(sourceUri);

      if (!input.ports.readScriptText) {
        if (looksLikeRolePattern) {
          diagnostics.push({
            code: 'SCRIPT_PATTERN_NOT_EVIDENCE',
            message: `角色号模式脚本名 ${sourceUri} 不能单独证明脚本存在或被引用；未提供 readScriptText 端口。`,
            severity: 'warning'
          });
        }
        coverageNotes.push({
          domain: domain === 'ai' ? 'ai' : 'script',
          status: 'unsupported',
          notes: ['readScriptText_port_absent', 'no_role_number_pattern_inference']
        });
        return { relations, coverageNotes, diagnostics };
      }

      let scriptRead: ScriptTextPortResult | null = null;
      try {
        const raw = await input.ports.readScriptText({
          domain,
          sourceUri,
          childChain,
          ...(target.scriptEntryIndex !== undefined ? { scriptEntryIndex: target.scriptEntryIndex } : {}),
          workspaceId
        });
        scriptRead = (raw ?? null) as ScriptTextPortResult | null;
      } catch (error) {
        diagnostics.push({
          code: 'SCRIPT_TEXT_READ_FAILED',
          message: `readScriptText 失败：${error instanceof Error ? error.message : String(error)}`,
          severity: 'warning'
        });
        coverageNotes.push({
          domain: domain === 'ai' ? 'ai' : 'script',
          status: 'partial',
          notes: ['script_text_read_failed']
        });
        return { relations, coverageNotes, diagnostics };
      }

      const text = typeof scriptRead?.text === 'string' ? scriptRead.text : undefined;
      const classification = scriptRead?.classification ?? target.classification ?? target.format;
      const isBytecode =
        scriptRead?.bytecode === true ||
        classification === 'lua-bytecode' ||
        classification === 'esd-bytecode' ||
        classification === 'hkx-bytecode' ||
        (text !== undefined && text.startsWith('\x1bLua'));

      if (text === undefined || text.length === 0) {
        const note = isBytecode
          ? 'script_entry_is_bytecode_no_source_text'
          : 'script_source_text_unavailable';
        if (isBytecode) {
          diagnostics.push({
            code: 'SCRIPT_BYTECODE_NO_SOURCE',
            message: '脚本条目为字节码（无 source text），不得伪造 source-text 语句或调用边。',
            severity: 'info'
          });
        } else {
          diagnostics.push({
            code: 'SCRIPT_SOURCE_TEXT_MISSING',
            message: 'readScriptText 未返回可分析的源文本；覆盖记为 partial/unsupported，不产生虚构关系。',
            severity: 'warning'
          });
        }
        if (looksLikeRolePattern) {
          diagnostics.push({
            code: 'SCRIPT_PATTERN_NOT_EVIDENCE',
            message: '角色号模式文件名不能替代真实脚本文本证据。',
            severity: 'info'
          });
        }
        coverageNotes.push({
          domain: domain === 'ai' ? 'ai' : 'script',
          status: isBytecode ? 'unsupported' : 'partial',
          notes: [note, 'no_fake_source_text_statement']
        });
        return { relations, coverageNotes, diagnostics };
      }

      const scan = parseLuaCallOccurrences(text);
      const localNames = scan.localNames;
      const effectiveSourceUri = scriptRead?.sourceUri ?? sourceUri;
      const effectiveChildChain = scriptRead?.childChain ?? childChain;

      let confirmedCalls = 0;
      let confirmedRequires = 0;
      let shadowed = 0;
      let dynamicSkipped = 0;
      let unknownGlobals = 0;

      for (const call of scan.calls) {
        const baseName = call.name;
        const rootName = baseName.split(/[.:]/)[0] ?? baseName;

        // require-like: script_require
        if (REQUIRE_NAMES.has(rootName) || REQUIRE_NAMES.has(baseName)) {
          const modulePath = call.stringLiteralArg;
          if (modulePath !== undefined && modulePath.trim() !== '') {
            if (luaIsShadowedByLocal(rootName, localNames)) {
              shadowed += 1;
              diagnostics.push({
                code: 'SCRIPT_REQUIRE_SHADOWED',
                message: `require 名 ${rootName} 被 local 遮蔽，不构成游戏脚本 require 关系。`,
                severity: 'info'
              });
              continue;
            }
            confirmedRequires += 1;
            relations.push({
              relationKind: 'script_require',
              certainty: 'confirmed',
              from: fromIdentity,
              to: makeScriptModuleIdentity(workspaceId, modulePath),
              evidence: makeSourceTextEvidence(effectiveSourceUri, domain, call, text, 'script_require', scriptRead?.sourceHash),
              limitNote: '字符串字面量 require；模块是否已索引另核'
            });
            continue;
          }

          // Dynamic require argument.
          diagnostics.push({
            code: 'SCRIPT_REQUIRE_DYNAMIC',
            message: `require 参数非字符串字面量（line ${call.line}），不可确认模块目标。`,
            severity: 'warning'
          });
          dynamicSkipped += 1;
          if (input.includeHypotheses) {
            relations.push({
              relationKind: 'script_require',
              certainty: 'hypothesis',
              from: fromIdentity,
              to: {
                workspaceId,
                domain: 'script',
                sourceUri: effectiveSourceUri,
                outerId: `dynamic_require:${call.line}`,
                childChain: effectiveChildChain,
                namespace: 'dynamic_require',
                objectKey: `script_require_dynamic#${call.line}:${call.column}`,
                unresolved: true
              },
              evidence: makeSourceTextEvidence(
                effectiveSourceUri,
                domain,
                call,
                text,
                'script_require_dynamic',
                scriptRead?.sourceHash,
                ['dynamic_require_arg']
              ),
              limitNote: '动态 require；includeHypotheses 时仅作假设'
            });
          }
          continue;
        }

        // Known game API call.
        const isKnownGlobal = KNOWN_GAME_API_GLOBALS.has(baseName) || KNOWN_GAME_API_GLOBALS.has(rootName);
        if (!isKnownGlobal) {
          unknownGlobals += 1;
          // Unknown callee: not a confirmed game API edge. Optional hypothesis when dynamic and opted-in.
          if (input.includeHypotheses && luaIsDynamicCall(call)) {
            relations.push({
              relationKind: 'script_call',
              certainty: 'hypothesis',
              from: fromIdentity,
              to: {
                workspaceId,
                domain: 'script',
                sourceUri: effectiveSourceUri,
                outerId: `unknown_call:${baseName}`,
                childChain: effectiveChildChain,
                namespace: 'unknown_script_call',
                objectKey: `script_call_unknown#${call.line}:${call.column}:${baseName}`,
                label: baseName,
                unresolved: true
              },
              evidence: makeSourceTextEvidence(
                effectiveSourceUri,
                domain,
                call,
                text,
                'script_call_unknown_dynamic',
                scriptRead?.sourceHash,
                ['dynamic_or_unknown_callee']
              ),
              limitNote: '动态/未知被调用名；不构成 confirmed 游戏 API 引用'
            });
          } else if (luaIsDynamicCall(call)) {
            dynamicSkipped += 1;
            diagnostics.push({
              code: 'SCRIPT_CALL_DYNAMIC',
              message: `调用 ${baseName} 含动态被调用名或动态参数（line ${call.line}）。`,
              severity: 'info'
            });
          }
          continue;
        }

        // Known global but locally shadowed → not confirmed game API ref.
        if (luaIsShadowedByLocal(baseName, localNames) || luaIsShadowedByLocal(rootName, localNames)) {
          shadowed += 1;
          diagnostics.push({
            code: 'SCRIPT_GLOBAL_SHADOWED',
            message: `已知全局 ${baseName} 被 local 遮蔽，不确认为游戏 API 引用。`,
            severity: 'info'
          });
          if (input.includeHypotheses) {
            relations.push({
              relationKind: 'script_call',
              certainty: 'hypothesis',
              from: fromIdentity,
              to: {
                workspaceId,
                domain: 'script',
                sourceUri: effectiveSourceUri,
                outerId: `shadowed:${baseName}`,
                childChain: effectiveChildChain,
                namespace: 'shadowed_global',
                objectKey: `script_call_shadowed#${call.line}:${baseName}`,
                label: baseName
              },
              evidence: makeSourceTextEvidence(
                effectiveSourceUri,
                domain,
                call,
                text,
                'script_call_shadowed',
                scriptRead?.sourceHash,
                ['local_shadowing']
              ),
              limitNote: 'local 遮蔽的同名全局；非 confirmed 游戏 API 引用'
            });
          }
          continue;
        }

        // Known global, not shadowed. Dynamic args → still a confirmed *call site*
        // for the API name, but mark arg-dependent certainty as indirect when args dynamic.
        const dynamic = luaIsDynamicCall(call);
        if (dynamic) {
          dynamicSkipped += 1;
          diagnostics.push({
            code: 'SCRIPT_CALL_ARGS_DYNAMIC',
            message: `已知 API ${baseName} 调用参数含动态表达式（line ${call.line}），边标为 hypothesis/indirect。`,
            severity: 'info'
          });
          if (input.includeHypotheses) {
            relations.push({
              relationKind: 'script_call',
              certainty: 'hypothesis',
              from: fromIdentity,
              to: makeApiIdentity(workspaceId, effectiveSourceUri, effectiveChildChain, baseName),
              evidence: makeSourceTextEvidence(
                effectiveSourceUri,
                domain,
                call,
                text,
                'script_call_dynamic_args',
                scriptRead?.sourceHash,
                ['dynamic_call_args']
              ),
              limitNote: '已知 API 但参数动态，无法确认具体目标实体/事件'
            });
          }
          continue;
        }

        confirmedCalls += 1;
        relations.push({
          relationKind: 'script_call',
          certainty: 'confirmed',
          from: fromIdentity,
          to: makeApiIdentity(workspaceId, effectiveSourceUri, effectiveChildChain, baseName),
          evidence: makeSourceTextEvidence(
            effectiveSourceUri,
            domain,
            call,
            text,
            'script_call',
            scriptRead?.sourceHash
          ),
          limitNote: '源文本静态扫描确认的已知全局调用点；不构成整脚本写入证明'
        });
      }

      if (scan.diagnostics.length > 0) {
        for (const item of scan.diagnostics) {
          diagnostics.push({
            code: 'SCRIPT_SCAN_NOTE',
            message: item,
            severity: 'info'
          });
        }
      }

      const notes: string[] = [
        `calls_scanned:${scan.calls.length}`,
        `confirmed_script_call:${confirmedCalls}`,
        `confirmed_script_require:${confirmedRequires}`,
        `shadowed:${shadowed}`,
        `dynamic_or_skipped:${dynamicSkipped}`,
        `unknown_globals:${unknownGlobals}`,
        'observation_fragments_only'
      ];
      let status: 'complete' | 'partial' | 'unsupported' = 'complete';
      if (dynamicSkipped > 0 || shadowed > 0 || unknownGlobals > 0) {
        status = 'partial';
        notes.push('dynamic_shadowed_or_unknown_prevents_complete_claim');
      }
      coverageNotes.push({ domain: domain === 'ai' ? 'ai' : 'script', status, notes });

      return { relations, coverageNotes, diagnostics };
    }
  };
}

function makeApiIdentity(
  workspaceId: string,
  sourceUri: string,
  childChain: string[],
  apiName: string
) {
  return {
    workspaceId,
    domain: 'other' as const,
    sourceUri: `api/${apiName}`,
    outerId: apiName,
    childChain: ['api', apiName],
    namespace: 'script_api',
    objectKey: `script_api#${apiName}`,
    label: apiName,
    entryName: apiName
  };
}

function makeScriptModuleIdentity(workspaceId: string, modulePath: string) {
  return {
    workspaceId,
    domain: 'script' as const,
    sourceUri: `script-module/${modulePath}`,
    outerId: modulePath,
    childChain: ['module', modulePath],
    namespace: 'script_module',
    objectKey: `script_module#${modulePath}`,
    label: modulePath,
    entryName: modulePath
  };
}

function makeSourceTextEvidence(
  sourceUri: string,
  domain: 'script' | 'ai',
  call: LuaCallOccurrence,
  text: string,
  ruleName: string,
  sourceHash?: string,
  extraDiagnostics?: string[]
) {
  const sliceStart = Math.max(0, call.start);
  const sliceEnd = Math.min(text.length, call.end);
  const slice = text.slice(sliceStart, sliceEnd);
  return {
    version: {
      ...(sourceHash ? { childHash: sourceHash } : {}),
      readerSchema: 'lua-static-subset-v1'
    },
    location: {
      sourceUri,
      domain: domain as 'script',
      locator: `${sourceUri}#L${call.line}:${call.column}`,
      line: call.line,
      column: call.column
    },
    statement: {
      kind: 'source-text' as const,
      text: slice.length > 0 ? slice : `${call.name}(${call.argsRaw})`,
      language: 'lua',
      range: { start: sliceStart, end: sliceEnd }
    },
    ruleName,
    fieldFacts: {
      fieldId: call.name,
      value: call.argsRaw,
      metadataRule: ruleName,
      targetStatus: 'unverified' as const
    },
    ...(extraDiagnostics && extraDiagnostics.length > 0 ? { diagnostics: extraDiagnostics } : {})
  };
}
