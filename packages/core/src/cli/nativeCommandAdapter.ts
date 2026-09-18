/**
 * Map legacy sf-edit syntax onto production tool names/args.
 * Does not bypass ToolRegistry validation.
 */
export type NativeCommandParseResult = {
  ok: true;
  tool: string;
  args: Record<string, unknown>;
  mode?: 'plan' | 'normal' | 'fullPermission';
  sessionName?: string;
  yes?: boolean;
} | {
  ok: false;
  code: string;
  message: string;
};

function flagMap(argv: string[]): { flags: Map<string, string | boolean | string[]>; rest: string[] } {
  const flags = new Map<string, string | boolean | string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags.set(key, true);
      else {
        const existing = flags.get(key);
        flags.set(key, existing === undefined ? next : ([] as string[]).concat(existing as string, next));
        i += 1;
      }
      continue;
    }
    rest.push(token);
  }
  return { flags, rest };
}

function str(flags: Map<string, string | boolean | string[]>, key: string): string | undefined {
  const value = flags.get(key);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function list(flags: Map<string, string | boolean | string[]>, key: string): string[] {
  const value = flags.get(key);
  if (value === undefined || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(',')).map((s) => s.trim()).filter(Boolean);
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

type NativeCommandBaseFields = {
  mode?: 'plan' | 'normal' | 'fullPermission';
  sessionName?: string;
  yes?: boolean;
};

function okResult(
  tool: string,
  args: Record<string, unknown>,
  base: NativeCommandBaseFields
): NativeCommandParseResult {
  return {
    ok: true,
    tool,
    args,
    ...(base.mode !== undefined ? { mode: base.mode } : {}),
    ...(base.sessionName !== undefined ? { sessionName: base.sessionName } : {}),
    ...(base.yes !== undefined ? { yes: base.yes } : {})
  };
}

/**
 * Parse CLI argv after the script name.
 * `--game` remains the game/base directory path (legacy). Game id uses `--game-id`.
 */
export function parseNativeCommand(argv: string[]): NativeCommandParseResult {
  const { flags, rest } = flagMap(argv);
  const domain = rest[0];
  const action = rest[1];
  const yes = flags.get('yes') === true || flags.get('yes') === 'true';
  const sessionName = str(flags, 'session');
  const modeFlag = str(flags, 'mode');
  const mode = modeFlag === 'plan' || modeFlag === 'normal' || modeFlag === 'fullPermission'
    ? modeFlag
    : undefined;

  const base: NativeCommandBaseFields = {
    ...(mode !== undefined ? { mode } : {}),
    ...(sessionName !== undefined ? { sessionName } : {}),
    ...(yes ? { yes: true } : {})
  };

  if (domain === 'tool') {
    const toolName = rest[2] ?? str(flags, 'name');
    const jsonRaw = str(flags, 'json');
    if (!toolName) return { ok: false, code: 'CLI_TOOL_NAME_REQUIRED', message: 'tool 子命令需要工具名。' };
    if (!jsonRaw) return { ok: false, code: 'CLI_TOOL_JSON_REQUIRED', message: 'tool 子命令需要 --json 参数。' };
    try {
      const args = JSON.parse(jsonRaw) as Record<string, unknown>;
      return okResult(toolName, args, base);
    } catch {
      return { ok: false, code: 'CLI_TOOL_JSON_INVALID', message: '--json 不是合法 JSON。' };
    }
  }

  if (domain === 'session') {
    // `session --stdio` is the durable local host entry; do not collapse it
    // into session_status (flags are stripped by flagMap).
    if (flags.get('stdio') === true || flags.get('stdio') === 'true') {
      return okResult('session_stdio', {}, base);
    }
    const sub = action ?? 'status';
    return okResult(`session_${sub}`, {}, base);
  }

  if (domain === 'batch') {
    const file = str(flags, 'file');
    if (!file) return { ok: false, code: 'CLI_BATCH_FILE_REQUIRED', message: 'batch 需要 --file。' };
    return okResult('batch_dispatch', {
      file,
      continueOnError: flags.get('continue-on-error') === true || flags.get('continue-on-error') === 'true'
    }, base);
  }

  if (domain === 'param' && action === 'read') {
    const table = str(flags, 'table');
    const rowIds = list(flags, 'row-id').map(Number).filter((n) => Number.isSafeInteger(n));
    const fieldIds = list(flags, 'field');
    if (!table || rowIds.length === 0 || fieldIds.length === 0) {
      return { ok: false, code: 'CLI_PARAM_READ_ARGS', message: 'param read 需要 --table --row-id --field。' };
    }
    const containerPath = str(flags, 'container');
    return okResult('read_param_fields', {
      table,
      rowIds,
      fieldIds,
      ...(containerPath ? { containerPath } : {})
    }, base);
  }

  if (domain === 'param' && action === 'set') {
    const sets = list(flags, 'set');
    const edits: Array<Record<string, unknown>> = [];
    for (const raw of sets) {
      const match = /^([^#]+)#(\d+)\.([A-Za-z0-9_]+)=(.*)$/u.exec(raw);
      if (!match) return { ok: false, code: 'CLI_PARAM_SET_PARSE', message: `无法解析 --set ${raw}` };
      const valueRaw = match[4]!;
      const value = valueRaw === 'true' ? true : valueRaw === 'false' ? false
        : valueRaw !== '' && Number.isFinite(Number(valueRaw)) ? Number(valueRaw) : valueRaw;
      edits.push({ table: match[1], rowId: Number(match[2]), fieldId: match[3], value });
    }
    if (edits.length === 0) return { ok: false, code: 'CLI_PARAM_SET_EMPTY', message: 'param set 需要至少一个 --set。' };
    const containerPath = str(flags, 'container');
    return okResult('mutate_param_fields', {
      edits,
      ...(containerPath ? { containerPath } : {})
    }, base);
  }

  if (domain === 'emevd' && action === 'read') {
    const file = str(flags, 'file');
    if (!file) return { ok: false, code: 'CLI_EMEVD_FILE_REQUIRED', message: 'emevd read 需要 --file。' };
    const eventId = str(flags, 'event-id');
    if (eventId !== undefined) {
      const id = Number(eventId);
      if (!Number.isSafeInteger(id)) return { ok: false, code: 'CLI_EMEVD_EVENT_ID', message: '--event-id 必须是安全整数。' };
      return okResult('read_emevd_event', {
        file,
        eventId: id,
        view: flags.get('view') === 'full-source' ? 'full-source' : 'default'
      }, base);
    }
    return okResult('read_emevd_outline', { file }, base);
  }

  if (domain === 'emevd' && action === 'apply-dsl') {
    const file = str(flags, 'file');
    const dslPath = str(flags, 'dsl') ?? str(flags, 'file-dsl');
    if (!file || !dslPath) return { ok: false, code: 'CLI_EMEVD_DSL_ARGS', message: 'emevd apply-dsl 需要 --file 与 --dsl。' };
    return okResult('apply_emevd_dsl', { file, dslPath }, base);
  }

  return { ok: false, code: 'CLI_COMMAND_UNKNOWN', message: `未知 CLI 命令：${argv.join(' ')}` };
}

/** Convert tool envelope to legacy-friendly stdout payload without dropping lifecycle. */
export function formatCliEnvelope(envelope: { ok: boolean; data?: unknown; error?: { code?: string; message?: string } }): unknown {
  return envelope;
}
