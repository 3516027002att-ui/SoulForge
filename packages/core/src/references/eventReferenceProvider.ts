/**
 * EVENT (EMEVD) reference provider.
 *
 * Confirmed edges only from typed argument roles (paramId / entityId / eventId)
 * with safe-integer values. Event-call edges require a known call instruction
 * signature; unknown bank/id yields diagnostics + partial coverage, never a
 * silent zero-ref claim. Name-similarity edges are hypotheses only when the
 * caller opts in via includeHypotheses.
 */
import type {
  ProviderRelationDraft,
  ReferenceProvider,
  ReferenceProviderCapability,
  ReferenceProviderCollectInput,
  ReferenceProviderCollectResult
} from './referenceProviderRegistry.js';

type TypedRole = 'flag' | 'eventId' | 'entityId' | 'regionId' | 'paramId' | 'textId' | 'unknown';

interface EventTypedArgLike {
  instructionIndex?: number;
  instructionName?: string;
  instructionUri?: string;
  argName?: string;
  role?: TypedRole | string;
  paramName?: string;
  value: unknown;
}

interface EventInstructionLike {
  uri?: string;
  index?: number;
  name?: string;
  bank?: number;
  id?: number;
  unknown?: boolean;
  args?: Array<{
    name?: string;
    value: string | number | boolean;
    role?: TypedRole | string;
    paramName?: string;
    confidence?: string;
  }>;
}

interface EventParameterMapLike {
  instructionIndex: number;
  targetStartByte: number;
  sourceStartByte: number;
  byteCount: number;
  unkId: number;
}

interface EventCallArgLike {
  instructionIndex?: number;
  instructionName?: string;
  bank?: number;
  id?: number;
  eventId?: unknown;
  paramName?: string;
  paramNameHint?: string;
  parameterValue?: unknown;
  sourceStartByte?: number;
  byteCount?: number;
}

interface EventTargetLike {
  domain: 'emevd';
  sourceUri: string;
  eventId: number;
  workspaceId?: string;
  outerId?: string;
  name?: string;
  instructions?: EventInstructionLike[];
  typedArgs?: EventTypedArgLike[];
  callArgs?: EventCallArgLike[];
  parameters?: EventParameterMapLike[];
  parameterMaps?: EventParameterMapLike[];
  parameterBytesHex?: string;
  document?: {
    events?: Array<{
      eventId?: number;
      instructions?: EventInstructionLike[];
      parameters?: EventParameterMapLike[];
    }>;
  };
}

/**
 * Known EMEVD event-call signatures (bank:id) that the provider is willing to
 * treat as event-call instructions. Unknown pairs are never guessed.
 */
const KNOWN_EVENT_CALL_SIGNATURES = new Set<string>([
  // Common FromSoftware EMEVD control / call families observed in production corpus.
  '2003:1',
  '2003:2',
  '2003:3',
  '2004:0',
  '2004:1',
  '2007:0',
  '2007:1',
  '1000:0',
  '1000:1',
  '1001:0',
  '1001:1',
  '1110:50',
  '1110:51'
]);

/** Instruction name fragments that mean "call another event" when signature bank is known. */
const EVENT_CALL_NAME_HINTS = [
  'eventidcall',
  'eventidterminate',
  'eventrestart',
  'callevent',
  'runevent',
  'gotostate'
];

export function createEventReferenceProvider(): ReferenceProvider {
  return {
    id: 'event',
    domains: ['emevd'],
    capabilities(): ReferenceProviderCapability[] {
      return [
        {
          resourceKind: 'event',
          formatFamilies: ['emevd'],
          support: 'supported',
          relationKinds: ['emevd_param_arg', 'emevd_event_call', 'emevd_entity_ref'],
          nativeReader: 'read_emevd_event',
          writerSupported: true
        }
      ];
    },
    async collect(input: ReferenceProviderCollectInput): Promise<ReferenceProviderCollectResult> {
      const diagnostics: ReferenceProviderCollectResult['diagnostics'] = [];
      const coverageNotes: ReferenceProviderCollectResult['coverageNotes'] = [];
      const relations: ProviderRelationDraft[] = [];

      const target = input.target as EventTargetLike | null | undefined;
      if (!target || (target as { domain?: string }).domain !== 'emevd') {
        diagnostics.push({
          code: 'EVENT_TARGET_REQUIRED',
          message: 'EVENT provider 需要已解析的 emevd 目标。',
          severity: 'error'
        });
        coverageNotes.push({ domain: 'emevd', status: 'failed', notes: ['target_missing'] });
        return { relations, coverageNotes, diagnostics };
      }

      const sourceUri = target.sourceUri ?? '';
      const workspaceId = target.workspaceId ?? 'unknown';
      const eventId = Number.isSafeInteger(target.eventId) ? target.eventId : null;

      if (eventId === null) {
        diagnostics.push({
          code: 'EVENT_ID_INVALID',
          message: 'emevd 目标 eventId 不是安全整数。',
          severity: 'error'
        });
        coverageNotes.push({ domain: 'emevd', status: 'failed', notes: ['event_id_invalid'] });
        return { relations, coverageNotes, diagnostics };
      }

      const fromIdentity = makeEventIdentity(workspaceId, sourceUri, eventId, target.outerId);

      // Optionally enrich from native document port.
      let instructions: EventInstructionLike[] = target.instructions ?? [];
      let parameters: EventParameterMapLike[] = target.parameters ?? target.parameterMaps ?? [];
      let callArgs: EventCallArgLike[] = target.callArgs ?? [];
      let typedArgs: EventTypedArgLike[] = target.typedArgs ?? [];

      if (input.ports.readEmevdDocument) {
        try {
          const docRaw = await input.ports.readEmevdDocument({
            domain: 'emevd',
            sourceUri,
            eventId,
            workspaceId
          });
          const doc = docRaw as {
            instructions?: EventInstructionLike[];
            parameters?: EventParameterMapLike[];
            events?: Array<{
              eventId?: number;
              instructions?: EventInstructionLike[];
              parameters?: EventParameterMapLike[];
            }>;
          } | null;
          if (doc) {
            if (doc.instructions && doc.instructions.length > 0) {
              instructions = doc.instructions;
            }
            if (doc.parameters && doc.parameters.length > 0) {
              parameters = doc.parameters;
            }
            if (Array.isArray(doc.events)) {
              const matched = doc.events.find((evt) => Number(evt.eventId) === eventId);
              if (matched) {
                if (matched.instructions && matched.instructions.length > 0) {
                  instructions = matched.instructions;
                }
                if (matched.parameters && matched.parameters.length > 0) {
                  parameters = matched.parameters;
                }
              }
            }
          }
        } catch (error) {
          diagnostics.push({
            code: 'EVENT_DOCUMENT_READ_FAILED',
            message: `readEmevdDocument 失败：${error instanceof Error ? error.message : String(error)}`,
            severity: 'warning'
          });
          coverageNotes.push({ domain: 'emevd', status: 'partial', notes: ['document_read_failed'] });
        }
      }

      // Always merge typed args from instruction payloads (in addition to any
      // caller-supplied typedArgs) so role-tagged instruction args are not dropped.
      {
        const seenTyped = new Set(
          typedArgs.map(
            (arg) =>
              `${arg.instructionIndex ?? ''}|${arg.argName ?? ''}|${String(arg.role)}|${String(arg.value)}`
          )
        );
        for (const instruction of instructions) {
          for (const arg of instruction.args ?? []) {
            const role = normalizeRole(arg.role);
            if (role === undefined || role === 'unknown' || role === 'flag') continue;
            const key = `${instruction.index ?? ''}|${arg.name ?? ''}|${String(role)}|${String(arg.value)}`;
            if (seenTyped.has(key)) continue;
            seenTyped.add(key);
            typedArgs.push({
              ...(instruction.index !== undefined ? { instructionIndex: instruction.index } : {}),
              ...(instruction.name !== undefined ? { instructionName: instruction.name } : {}),
              ...(instruction.uri !== undefined ? { instructionUri: instruction.uri } : {}),
              ...(arg.name !== undefined ? { argName: arg.name } : {}),
              role,
              ...(arg.paramName !== undefined ? { paramName: arg.paramName } : {}),
              value: arg.value
            });
          }
        }
      }

      let confirmedTyped = 0;
      let unknownTyped = 0;
      let callKnown = 0;
      let callUnknown = 0;
      let parameterResolved = 0;
      let parameterUnresolved = 0;
      const unknownSignatureInventory: string[] = [];

      // ── Typed argument edges (confirmed only for known role + safe integer) ──
      for (const arg of typedArgs) {
        const role = normalizeRole(arg.role);
        if (role === undefined || role === 'unknown' || role === 'flag' || role === 'textId') {
          unknownTyped += 1;
          continue;
        }

        const numeric = toSafeInteger(arg.value);
        if (numeric === null) {
          diagnostics.push({
            code: 'EVENT_TYPED_ARG_NOT_SAFE_INT',
            message: `指令 ${arg.instructionName ?? arg.instructionIndex ?? '?'} 的 ${String(arg.argName ?? role)} 值不是安全整数，不产生 confirmed 边。`,
            severity: 'warning'
          });
          unknownTyped += 1;
          continue;
        }

        const evidence = {
          ruleName: `emevd_typed_arg:${role}`,
          fieldFacts: {
            fieldId: String(arg.argName ?? role),
            value: numeric,
            metadataRule: role,
            targetStatus: 'unverified' as const
          },
          location: {
            sourceUri,
            domain: 'emevd' as const,
            locator: `event#${eventId}${arg.instructionIndex !== undefined ? `.i${arg.instructionIndex}` : ''}${arg.argName ? `.${arg.argName}` : ''}`,
            ...(arg.instructionIndex !== undefined ? { instructionIndex: arg.instructionIndex } : {}),
            ...(arg.instructionUri ? { fieldId: arg.instructionUri } : {})
          },
          diagnostics: [] as string[]
        };

        if (role === 'eventId') {
          relations.push({
            relationKind: 'emevd_event_call',
            certainty: 'confirmed',
            from: fromIdentity,
            to: makeEventIdentity(workspaceId, sourceUri, numeric),
            evidence,
            limitNote: 'typed role=eventId + safe integer；目标事件是否实际存在需单独核验'
          });
          confirmedTyped += 1;
          continue;
        }

        if (role === 'entityId' || role === 'regionId') {
          relations.push({
            relationKind: 'emevd_entity_ref',
            certainty: 'confirmed',
            from: fromIdentity,
            to: makeEntityIdentity(workspaceId, sourceUri, numeric, role === 'regionId'),
            evidence,
            limitNote: 'typed role=entityId/regionId；实体是否在当前 map 中另核'
          });
          confirmedTyped += 1;
          continue;
        }

        if (role === 'paramId') {
          const paramName = typeof arg.paramName === 'string' && arg.paramName.length > 0 ? arg.paramName : undefined;
          relations.push({
            relationKind: 'emevd_param_arg',
            certainty: 'confirmed',
            from: fromIdentity,
            to: makeParamIdentity(workspaceId, numeric, paramName),
            evidence: {
              ...evidence,
              ruleName: paramName ? `emevd_typed_arg:paramId->${paramName}` : 'emevd_typed_arg:paramId',
              fieldFacts: {
                ...evidence.fieldFacts,
                ...(paramName ? { metadataRule: `paramId:${paramName}` } : {}),
                targetStatus: paramName ? 'unverified' : 'ambiguous'
              }
            },
            ...(paramName
              ? {}
              : {
                  limitNote: 'paramId 未携带 paramName，目标表名不可从数值反推'
                })
          });
          confirmedTyped += 1;
          continue;
        }
      }

      // ── Event-call instruction signatures ──
      const callCandidates: Array<{
        bank?: number;
        id?: number;
        name?: string;
        index?: number;
        uri?: string;
        eventIdValue?: unknown;
        paramName?: string;
      }> = [];

      for (const instruction of instructions) {
        const bank = instruction.bank;
        const id = instruction.id;
        const nameLower = (instruction.name ?? '').toLowerCase();
        const signature = bank !== undefined && id !== undefined ? `${bank}:${id}` : undefined;
        const nameSuggestsCall = EVENT_CALL_NAME_HINTS.some((hint) => nameLower.includes(hint));

        // Prefer explicit callArgs entries for this instruction.
        const relatedCallArgs = callArgs.filter((ca) => {
          if (ca.instructionIndex !== undefined && instruction.index !== undefined) {
            return ca.instructionIndex === instruction.index;
          }
          if (ca.instructionName && instruction.name) {
            return ca.instructionName === instruction.name;
          }
          return false;
        });

        if (relatedCallArgs.length > 0) {
          for (const ca of relatedCallArgs) {
            callCandidates.push({
              ...(ca.bank !== undefined ? { bank: ca.bank } : bank !== undefined ? { bank } : {}),
              ...(ca.id !== undefined ? { id: ca.id } : id !== undefined ? { id } : {}),
              ...(ca.instructionName ? { name: ca.instructionName } : instruction.name ? { name: instruction.name } : {}),
              ...(instruction.index !== undefined ? { index: instruction.index } : ca.instructionIndex !== undefined ? { index: ca.instructionIndex } : {}),
              ...(instruction.uri ? { uri: instruction.uri } : {}),
              eventIdValue: ca.eventId ?? ca.parameterValue,
              ...(ca.paramName ?? ca.paramNameHint ? { paramName: (ca.paramName ?? ca.paramNameHint) as string } : {})
            });
          }
          continue;
        }

        if (nameSuggestsCall || (signature && KNOWN_EVENT_CALL_SIGNATURES.has(signature))) {
          // Extract eventId from typed args when available.
          const eventIdArg = (instruction.args ?? []).find((a) => normalizeRole(a.role) === 'eventId');
          callCandidates.push({
            ...(bank !== undefined ? { bank } : {}),
            ...(id !== undefined ? { id } : {}),
            ...(instruction.name ? { name: instruction.name } : {}),
            ...(instruction.index !== undefined ? { index: instruction.index } : {}),
            ...(instruction.uri ? { uri: instruction.uri } : {}),
            ...(eventIdArg ? { eventIdValue: eventIdArg.value } : {})
          });
          continue;
        }

        // Unknown bank/id with payload: must not become a silent zero-ref claim.
        // Inventory unknown signatures; args-bearing ones become call candidates
        // so the unknown-signature diagnostic path below can run.
        const hasArgs = (instruction.args ?? []).length > 0;
        if (signature !== undefined && !signatureKnown(signature)) {
          unknownSignatureInventory.push(signature);
        }
        if (signature !== undefined && !signatureKnown(signature) && hasArgs) {
          const eventIdArg = (instruction.args ?? []).find((a) => normalizeRole(a.role) === 'eventId');
          callCandidates.push({
            ...(bank !== undefined ? { bank } : {}),
            ...(id !== undefined ? { id } : {}),
            ...(instruction.name ? { name: instruction.name } : {}),
            ...(instruction.index !== undefined ? { index: instruction.index } : {}),
            ...(instruction.uri ? { uri: instruction.uri } : {}),
            ...(eventIdArg ? { eventIdValue: eventIdArg.value } : {})
          });
        }
      }

      // callArgs without matching instruction still participate in signature checks.
      if (callArgs.length > 0 && instructions.length === 0) {
        for (const ca of callArgs) {
          callCandidates.push({
            ...(ca.bank !== undefined ? { bank: ca.bank } : {}),
            ...(ca.id !== undefined ? { id: ca.id } : {}),
            ...(ca.instructionName ? { name: ca.instructionName } : {}),
            ...(ca.instructionIndex !== undefined ? { index: ca.instructionIndex } : {}),
            eventIdValue: ca.eventId ?? ca.parameterValue,
            ...(ca.paramName ?? ca.paramNameHint ? { paramName: (ca.paramName ?? ca.paramNameHint) as string } : {})
          });
        }
      }

      for (const candidate of callCandidates) {
        const signature =
          candidate.bank !== undefined && candidate.id !== undefined
            ? `${candidate.bank}:${candidate.id}`
            : undefined;
        const nameLower = (candidate.name ?? '').toLowerCase();
        const nameKnownCall = EVENT_CALL_NAME_HINTS.some((hint) => nameLower.includes(hint));
        const signatureKnown = signature !== undefined && KNOWN_EVENT_CALL_SIGNATURES.has(signature);

        if (!signatureKnown && !nameKnownCall) {
          callUnknown += 1;
          if (!(signature && unknownSignatureInventory.includes(signature))) {
            diagnostics.push({
              code: 'EVENT_CALL_SIGNATURE_UNKNOWN',
              message: `事件调用指令签名未知（bank=${candidate.bank ?? '?'} id=${candidate.id ?? '?'} name=${candidate.name ?? '?'}），不得当作零引用。`,
              severity: 'warning'
            });
          }
          continue;
        }

        const numericEventId = toSafeInteger(candidate.eventIdValue);
        if (numericEventId === null) {
          callUnknown += 1;
          diagnostics.push({
            code: 'EVENT_CALL_TARGET_UNRESOLVED',
            message: `已知调用签名 ${signature ?? candidate.name ?? '?'} 未能解析目标 eventId。`,
            severity: 'warning'
          });
          continue;
        }

        callKnown += 1;
        relations.push({
          relationKind: 'emevd_event_call',
          certainty: 'confirmed',
          from: fromIdentity,
          to: makeEventIdentity(workspaceId, sourceUri, numericEventId),
          evidence: {
            ruleName: `emevd_event_call:${signature ?? candidate.name}`,
            fieldFacts: {
              fieldId: 'eventId',
              value: numericEventId,
              metadataRule: signature ?? candidate.name ?? '',
              targetStatus: 'unverified'
            },
            location: {
              sourceUri,
              domain: 'emevd',
              locator: `event#${eventId}.call#${candidate.index ?? '?'}`,
              ...(candidate.index !== undefined ? { instructionIndex: candidate.index } : {})
            }
          },
          limitNote: '调用指令签名已知；目标事件存在性与 bank 语义另核'
        });
      }

      // Inventory diagnostics for unknown bank/id signatures (never zero-ref claim).
      if (unknownSignatureInventory.length > 0) {
        for (const sig of unknownSignatureInventory) {
          diagnostics.push({
            code: 'EVENT_CALL_SIGNATURE_UNKNOWN',
            message: `事件指令签名未知（bank:id=${sig}），不得当作零引用。`,
            severity: 'warning'
          });
        }
        callUnknown += unknownSignatureInventory.length;
      }

      // Name-similarity hypotheses only when includeHypotheses=true.
      if (input.includeHypotheses) {
        for (const instruction of instructions) {
          const name = instruction.name;
          if (!name || typeof name !== 'string') continue;
          const lower = name.toLowerCase();
          if (!EVENT_CALL_NAME_HINTS.some((hint) => lower.includes(hint))) continue;
          // Already handled as known/unknown call; do not duplicate as name-similarity.
          const already = relations.some(
            (rel) =>
              rel.relationKind === 'emevd_event_call' &&
              (rel.evidence as { location?: { instructionIndex?: number } }).location?.instructionIndex === instruction.index
          );
          if (already) continue;
          relations.push({
            relationKind: 'emevd_event_call',
            certainty: 'hypothesis',
            from: fromIdentity,
            to: {
              domain: 'emevd',
              sourceUri,
              workspaceId,
              outerId: sourceUri,
              childChain: ['event', 'unknown'],
              namespace: 'event',
              objectKey: `event#unknown_name:${name}`,
              unresolved: true,
              instructionName: name
            },
            evidence: {
              ruleName: 'emevd_call_name_similarity',
              fieldFacts: {
                fieldId: 'instructionName',
                value: name,
                metadataRule: 'name-similarity',
                targetStatus: 'unverified'
              },
              location: {
                sourceUri,
                domain: 'emevd',
                locator: `event#${eventId}.i${instruction.index ?? '?'}`,
                ...(instruction.index !== undefined ? { instructionIndex: instruction.index } : {})
              },
              diagnostics: ['name_similarity_only']
            },
            limitNote: '仅名称相似；includeHypotheses=true 时可见，不构成 confirmed 控制关系'
          });
        }
      }

      // ── Parameter-pass paths (indirect) ──
      const callArgsForParams = callArgs.length > 0 ? callArgs : buildCallArgsFromInstructions(instructions);
      if (callArgsForParams.length > 0 && parameters.length > 0) {
        for (const param of parameters) {
          const matchedCall = callArgsForParams.find((ca) => {
            if (ca.instructionIndex !== undefined) return ca.instructionIndex === param.instructionIndex;
            return false;
          });
          if (!matchedCall) {
            parameterUnresolved += 1;
            diagnostics.push({
              code: 'EVENT_PARAMETER_MAPPING_UNRESOLVED',
              message: `parameter map 指向 instructionIndex=${param.instructionIndex}，但 callArgs 未提供对应映射。`,
              severity: 'warning'
            });
            continue;
          }

          const passValue = toSafeInteger(matchedCall.parameterValue ?? matchedCall.eventId);
          if (passValue === null) {
            parameterUnresolved += 1;
            diagnostics.push({
              code: 'EVENT_PARAMETER_VALUE_UNRESOLVED',
              message: `instructionIndex=${param.instructionIndex} 的参数传递值无法解析为安全整数。`,
              severity: 'warning'
            });
            continue;
          }

          parameterResolved += 1;
          const paramTable = matchedCall.paramName ?? matchedCall.paramNameHint;
          relations.push({
            relationKind: 'emevd_param_arg',
            certainty: 'indirect',
            from: fromIdentity,
            to: makeParamIdentity(workspaceId, passValue, paramTable),
            evidence: {
              ruleName: `emevd_parameter_pass:${param.unkId}`,
              fieldFacts: {
                fieldId: `param.${param.instructionIndex}`,
                value: passValue,
                metadataRule: `byteMap:${param.sourceStartByte}+${param.byteCount}->${param.targetStartByte}`,
                targetStatus: 'unverified'
              },
              location: {
                sourceUri,
                domain: 'emevd',
                locator: `event#${eventId}.param#${param.instructionIndex}:${param.sourceStartByte}`,
                instructionIndex: param.instructionIndex
              },
              diagnostics: ['parameter_byte_map']
            },
            path: [
              fromIdentity,
              {
                domain: 'emevd',
                sourceUri,
                workspaceId,
                outerId: sourceUri,
                childChain: ['event', String(eventId), 'param', String(param.instructionIndex)],
                namespace: 'emevd_param_pass',
                objectKey: `param-pass#${param.instructionIndex}:${param.unkId}`,
                eventId,
                instructionIndex: param.instructionIndex
              } as typeof fromIdentity,
              makeParamIdentity(workspaceId, passValue, paramTable)
            ],
            limitNote: '经 parameter byte map 的间接路径；非指令内直接 typed arg'
          });
        }
      } else if (callArgsForParams.length > 0 && parameters.length === 0 && target.parameterBytesHex) {
        parameterUnresolved += 1;
        diagnostics.push({
          code: 'EVENT_PARAMETER_MAP_MISSING',
          message: '存在 callArgs/parameterBytesHex 但缺少 parameter byte map，参数传递路径无法确认。',
          severity: 'warning'
        });
      }

      if (input.detail === 'context' && input.depth > 1 && input.ports.readEmevdDocument) {
        // Context depth does not invent edges; coverage note only.
        coverageNotes.push({
          domain: 'emevd',
          status: 'partial',
          notes: [`context_depth:${input.depth}`]
        });
      }

      // Always return coverageNotes for emevd domain.
      const notes: string[] = [
        `typed_confirmed:${confirmedTyped}`,
        `typed_unresolved:${unknownTyped}`,
        `call_known:${callKnown}`,
        `call_unknown:${callUnknown}`,
        `param_path_resolved:${parameterResolved}`,
        `param_path_unresolved:${parameterUnresolved}`
      ];
      let status: 'complete' | 'partial' | 'unsupported' | 'failed' = 'complete';
      if (callUnknown > 0 || parameterUnresolved > 0 || unknownTyped > 0) {
        status = 'partial';
        notes.push('unknown_signature_or_mapping_blocks_complete_coverage');
      }
      if (instructions.length === 0 && typedArgs.length === 0 && callArgs.length === 0) {
        notes.push('no_instruction_payload_on_target');
      }
      if (unknownSignatureInventory.length > 0) {
        notes.push(`unknown_instruction_signatures:${unknownSignatureInventory.join('|')}`);
      }
      coverageNotes.push({ domain: 'emevd', status, notes });

      return { relations, coverageNotes, diagnostics };
    }
  };
}

function normalizeRole(role: unknown): TypedRole | undefined {
  if (typeof role !== 'string') return undefined;
  if (
    role === 'flag' ||
    role === 'eventId' ||
    role === 'entityId' ||
    role === 'regionId' ||
    role === 'paramId' ||
    role === 'textId' ||
    role === 'unknown'
  ) {
    return role;
  }
  return undefined;
}

function toSafeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function signatureKnown(signature: string): boolean {
  return KNOWN_EVENT_CALL_SIGNATURES.has(signature);
}

function makeEventIdentity(workspaceId: string, sourceUri: string, eventId: number, outerId?: string) {
  return {
    workspaceId,
    domain: 'emevd' as const,
    sourceUri,
    outerId: outerId ?? sourceUri,
    childChain: ['event', String(eventId)],
    namespace: 'event',
    objectKey: `event#${eventId}`,
    eventId
  };
}

function makeEntityIdentity(workspaceId: string, sourceUri: string, entityId: number, isRegion: boolean) {
  return {
    workspaceId,
    domain: 'map' as const,
    sourceUri,
    outerId: sourceUri,
    childChain: ['map', isRegion ? 'region' : 'entity', String(entityId)],
    namespace: isRegion ? 'map_region' : 'map_entity',
    objectKey: `${isRegion ? 'region' : 'entity'}#${entityId}`,
    rowId: entityId,
    label: `${isRegion ? 'region' : 'entity'}#${entityId}`
  };
}

function makeParamIdentity(workspaceId: string, rowId: number, paramName?: string) {
  return {
    workspaceId,
    domain: 'param' as const,
    sourceUri: paramName ? `param/${paramName}` : 'param/unknown',
    outerId: paramName ?? 'unknown',
    childChain: paramName ? [paramName] : ['unknown'],
    namespace: paramName ?? 'unknown',
    objectKey: paramName ? `${paramName}#${rowId}` : `param#unknown#${rowId}`,
    rowId,
    ...(paramName ? { entryName: paramName } : {})
  };
}

function buildCallArgsFromInstructions(instructions: EventInstructionLike[]): EventCallArgLike[] {
  const out: EventCallArgLike[] = [];
  for (const instruction of instructions) {
    const args = instruction.args ?? [];
    const eventIdArg = args.find((a) => normalizeRole(a.role) === 'eventId');
    const paramArg = args.find((a) => normalizeRole(a.role) === 'paramId');
    if (!eventIdArg && !paramArg) continue;
    out.push({
      ...(instruction.index !== undefined ? { instructionIndex: instruction.index } : {}),
      ...(instruction.name ? { instructionName: instruction.name } : {}),
      ...(instruction.bank !== undefined ? { bank: instruction.bank } : {}),
      ...(instruction.id !== undefined ? { id: instruction.id } : {}),
      ...(eventIdArg ? { eventId: eventIdArg.value } : {}),
      ...(paramArg ? { parameterValue: paramArg.value } : {}),
      ...(paramArg?.paramName ? { paramName: paramArg.paramName } : {})
    });
  }
  return out;
}
