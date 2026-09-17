import { decodeReferenceQueryInput } from '@soulforge/shared';

/** T11-A 旧 CLI 语法到已有工具参数的映射；只做映射，不直连底层 facade。 */
export interface MappedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type ToolInputMappingResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/**
 * Normalize arguments shared by the CLI and Agent paths.
 *
 * The CLI must not grow a second interpretation of the reference-query
 * contract.  Validate `find_references` with the shared decoder, but return
 * the original wire-shaped object: the decoder's internal
 * `cursorScopeCheckRequired` field is host state and must never be sent back
 * through the public tool boundary.
 */
export function mapCliArgumentsToToolInput(
  tool: string,
  args: Record<string, unknown>
): ToolInputMappingResult {
  if (typeof tool !== 'string' || tool.trim() === '') {
    return { ok: false, code: 'CLI_TOOL_NAME_REQUIRED', message: 'CLI 工具名不能为空。' };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'CLI_ARGUMENTS_INVALID', message: 'CLI 工具参数必须是 JSON 对象。' };
  }
  if (tool === 'find_references') {
    const normalized = { ...args };
    // Older CLI callers used `target: "param://..."`.  It is a logical URI,
    // not enough information to invent a physical PARAM entry/row selector;
    // preserve it as the decoder's `uri` target instead of guessing.
    if (typeof normalized.target === 'string') {
      if (normalized.uri !== undefined || normalized.query !== undefined) {
        return {
          ok: false,
          code: 'REFERENCE_TARGET_CONFLICT',
          message: '旧 target 字符串不能与 uri/query 同时提供。'
        };
      }
      normalized.uri = normalized.target;
      delete normalized.target;
    }
    const decoded = decodeReferenceQueryInput(normalized);
    if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
    return { ok: true, input: normalized };
  }
  return { ok: true, input: { ...args } };
}

export function mapLegacyCliCommand(command: string, options: Record<string, string>): MappedToolCall {
  const [area, action] = command.split(':');
  if (area === 'param' && action === 'read') {
    return { tool: 'read_param_fields', args: { table: options.table, rowIds: parseIdList(options.rows), fieldIds: parseIdList(options.fields) } };
  }
  if (area === 'param' && action === 'set') {
    return { tool: 'mutate_param_fields', args: { table: options.table, rowIds: parseIdList(options.rows), fields: options.fields } };
  }
  if (area === 'fmg' && action === 'read') {
    return { tool: 'read_fmg_entries', args: { table: options.table, textIds: parseIdList(options.ids) } };
  }
  if (area === 'fmg' && action === 'set') {
    return { tool: 'mutate_fmg_entries', args: { table: options.table, entries: options.entries } };
  }
  if (area === 'emevd' && action === 'read') {
    if (options['event-id'] !== undefined) return { tool: 'read_emevd_event', args: { sourceUri: options.source, eventId: Number(options['event-id']) } };
    return { tool: 'read_emevd_outline', args: { sourceUri: options.source } };
  }
  if (area === 'emevd' && action === 'apply-dsl') {
    return { tool: 'apply_emevd_dsl', args: { sourceUri: options.source, dsl: options.dsl } };
  }
  if (area === 'tool') {
    if (!options.name) throw new Error('CLI_TOOL_NAME_REQUIRED');
    return { tool: options.name, args: options.json ? JSON.parse(options.json) as Record<string, unknown> : {} };
  }
  throw new Error(`CLI_UNKNOWN_COMMAND:${command}`);
}

function parseIdList(raw: string | undefined): Array<string | number> | undefined {
  if (raw === undefined) return undefined;
  return raw.split(',').map((piece) => {
    const trimmed = piece.trim();
    const numeric = Number(trimmed);
    return Number.isSafeInteger(numeric) && trimmed !== '' ? numeric : trimmed;
  });
}
