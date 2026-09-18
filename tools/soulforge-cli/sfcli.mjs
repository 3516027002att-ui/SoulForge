#!/usr/bin/env node
/**
 * SoulForge CLI — 在桌面应用之外调用生产 ToolRegistry 的全部 Agent 工具。
 *
 * 用法:
 *   node tools/soulforge-cli/sfcli.mjs --workspace <mods> [选项] list
 *   node tools/soulforge-cli/sfcli.mjs --workspace <mods> call <tool> '<json>'
 *   node tools/soulforge-cli/sfcli.mjs --workspace <mods> call --stdin <tool>
 *
 * 选项:
 *   --workspace <path>   Mod 工作区（overlay），必填
 *   --base <path>        游戏根目录（可选，用于 Oodle/EMEDF）
 *   --game <name>        默认 sekiro
 *   --mode <mode>        plan | normal | fullPermission（默认 normal）
 *   --analyze            打开后执行完整原生分析（慢，但无语义缓存时需要）
 *   --no-cache           跳过 workspace.db 语义缓存水合
 *   --json               以紧凑 JSON 输出结果
 *   --quiet              仅输出工具结果
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import process from 'node:process';

// Portable/local SDK hosts may omit ProgramFiles; NuGet restore (dotnet run
// fallback) and some path combinators require them.
if (!process.env.PROGRAMFILES) process.env.PROGRAMFILES = 'C:\\Program Files';
if (!process.env.ProgramW6432) process.env.ProgramW6432 = 'C:\\Program Files';
if (!process.env.CommonProgramFiles) {
  process.env.CommonProgramFiles = 'C:\\Program Files\\Common Files';
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js');
const SHARED_DIST = join(REPO_ROOT, 'packages/shared/dist/index.js');

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    workspace: process.env.SOULFORGE_WORKSPACE || process.env.SOULFORGE_SEKIRO_MOD_ROOT || null,
    base: process.env.SOULFORGE_SEKIRO_ROOT || null,
    game: process.env.SOULFORGE_GAME || 'sekiro',
    mode: process.env.SOULFORGE_MODE || 'normal',
    analyze: false,
    useCache: true,
    json: false,
    quiet: false,
    command: null,
    tool: null,
    argsJson: null,
    stdin: false
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`选项 ${arg} 缺少取值`);
      return argv[i];
    };
    switch (arg) {
      case '--workspace':
      case '-w':
        options.workspace = next();
        break;
      case '--base':
      case '-b':
        options.base = next();
        break;
      case '--game':
        options.game = next();
        break;
      case '--mode':
        options.mode = next();
        break;
      case '--analyze':
        options.analyze = true;
        break;
      case '--no-cache':
        options.useCache = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.command = 'help';
        break;
      default:
        rest.push(arg);
    }
  }
  if (!options.command) {
    options.command = rest.shift() ?? 'help';
  }
  if (options.command === 'call') {
    if (rest[0] === '--stdin') {
      options.stdin = true;
      rest.shift();
    }
    options.tool = rest.shift() ?? null;
    options.argsJson = rest.length > 0 ? rest.join(' ') : null;
  } else if (options.command === 'describe' || options.command === 'desc') {
    options.tool = rest.shift() ?? null;
  } else if (options.command === 'read-param') {
    // read-param <table> <rowId> <field1,field2,...>
    options.table = rest.shift() ?? null;
    options.rowId = rest.shift() ?? null;
    options.fieldList = rest.shift() ?? null;
  } else if (options.command === 'search-param') {
    options.query = rest.shift() ?? null;
    options.paramNames = rest.length > 0 ? rest : null;
  }
  return options;
}

function printUsage() {
  process.stdout.write(`SoulForge CLI — 外置调用生产 Agent 工具

命令:
  list                         列出全部工具
  describe <tool>              查看工具说明与输入 schema
  call <tool> ['{"k":v}']      调用任意工具
  call --stdin <tool>          从 stdin 读取 JSON 参数并调用
  search-param <query> [表...]  快捷：search_param_rows
  read-param <table> <rowId> <f1,f2>  快捷：read_param_fields

示例:
  node tools/soulforge-cli/sfcli.mjs \\
    --workspace "D:/mystream/Sekiro Shadows Die Twice/Sekiro/mods" \\
    --base "D:/mystream/Sekiro Shadows Die Twice/Sekiro" \\
    search-param 落雷 Bullet

  node tools/soulforge-cli/sfcli.mjs \\
    --workspace "D:/.../mods" \\
    call read_param_fields \\
    '{"table":"Bullet","rowIds":[12200404],"fieldIds":["atkId_Bullet","sfxId_Bullet","HitBulletID"]}'
`);
}

async function loadCore() {
  if (!existsSync(CORE_DIST) || !existsSync(SHARED_DIST)) {
    fail(
      '未找到 packages/core/dist 或 packages/shared/dist。\n' +
      '请先构建: npm run build -w @soulforge/shared && npm run build -w @soulforge/core\n' +
      `期望路径: ${CORE_DIST}`
    );
  }
  return import(pathToFileURL(CORE_DIST).href);
}

function abs(path) {
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printUsage();
    return;
  }

  const log = (message) => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };

  const core = await loadCore();
  const {
    mapCliArgumentsToToolInput,
    openLocalCliSession
  } = core;

  if (!options.workspace) fail('必须通过 --workspace 指定 Mod 工作区路径');
  const workspaceRoot = abs(options.workspace);
  const baseRoot = abs(options.base);
  if (!existsSync(workspaceRoot)) fail(`工作区不存在: ${workspaceRoot}`);
  if (baseRoot && !existsSync(baseRoot)) fail(`--base 路径不存在: ${baseRoot}`);

  const metadataOnly = options.command === 'list' || options.command === 'ls'
    || options.command === 'describe' || options.command === 'desc';
  log(`打开工作区: ${workspaceRoot}`);
  const cliSession = await openLocalCliSession({
    overlayRoot: workspaceRoot,
    ...(baseRoot ? { baseRoot } : {}),
    game: options.game,
    mode: options.mode === 'plan' || options.mode === 'fullPermission' ? options.mode : 'normal',
    principal: 'local-cli',
    analyze: options.analyze || !metadataOnly,
    useCache: options.useCache,
    requireDurableLog: false,
    onFallbackWarning: (message) => log(message),
    onProgress: (progress) => log(`  [${progress.phase}] ${progress.current}/${progress.total ?? '?'} ${progress.message ?? ''}`)
  });
  const { bridge, registry } = cliSession;
  log(`扫描/索引完成: files=${cliSession.workspaceIndex.getFiles().length}`);

  const finish = async (code = 0) => {
    try { await cliSession.dispose(); } catch { /* ignore */ }
    process.exit(code);
  };

  try {
    if (options.command === 'list' || options.command === 'ls') {
      const tools = registry.list();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      } else {
        process.stdout.write(`${tools.length} tools:\n`);
        for (const t of tools) {
          process.stdout.write(`  ${t.permissionLevel?.padEnd(6) ?? 'read  '}  ${t.name}\n`);
        }
      }
      await finish(0);
      return;
    }

    if (options.command === 'describe' || options.command === 'desc') {
      if (!options.tool) fail('describe 需要工具名');
      const tool = registry.list().find((t) => t.name === options.tool);
      if (!tool) fail(`未知工具: ${options.tool}`);
      process.stdout.write(`${JSON.stringify(tool, null, 2)}\n`);
      await finish(0);
      return;
    }

    let toolName = null;
    let args = {};

    if (options.command === 'call') {
      if (!options.tool) fail('call 需要工具名');
      toolName = options.tool;
      if (options.stdin) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        args = raw.trim() ? JSON.parse(raw) : {};
      } else if (options.argsJson && options.argsJson.trim()) {
        args = JSON.parse(options.argsJson);
      }
    } else if (options.command === 'search-param') {
      if (!options.query) fail('search-param 需要查询词');
      toolName = 'search_param_rows';
      args = {
        query: options.query,
        ...(options.paramNames && options.paramNames.length > 0
          ? { paramNames: options.paramNames }
          : {})
      };
    } else if (options.command === 'read-param') {
      if (!options.table || !options.rowId || !options.fieldList) {
        fail('用法: read-param <table> <rowId> <field1,field2,...>');
      }
      toolName = 'read_param_fields';
      args = {
        table: options.table,
        rowIds: [Number(options.rowId)],
        fieldIds: String(options.fieldList)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      };
    } else {
      fail(`未知命令: ${options.command}（使用 --help）`);
    }

    log(`调用 ${toolName}`);
    const mapped = mapCliArgumentsToToolInput(toolName, args);
    if (!mapped.ok) {
      fail(`${mapped.code}: ${mapped.message}`, 2);
    }
    const result = await bridge.executeTool({
      id: `cli-${Date.now()}`,
      name: toolName,
      argumentsJson: JSON.stringify(mapped.input)
    });

    if (options.json || options.quiet) {
      // bridge returns { ok, content, code? } where content is envelope JSON string
      if (typeof result.content === 'string') {
        process.stdout.write(`${result.content}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    } else {
      process.stdout.write(`ok=${result.ok}${result.code ? ` code=${result.code}` : ''}\n`);
      process.stdout.write(`${typeof result.content === 'string' ? result.content : JSON.stringify(result, null, 2)}\n`);
    }
    await finish(result.ok ? 0 : 2);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
    await finish(1);
  }
}

await main();
