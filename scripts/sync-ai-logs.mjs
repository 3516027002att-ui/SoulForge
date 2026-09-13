#!/usr/bin/env node
/**
 * scripts/sync-ai-logs.mjs
 *
 * 自动同步 SoulForge 软件内侧边栏 AI Agent 的全部会话记录（Rollout Sessions）
 * 到项目的 docs/ai-logs/ 目录，同时生成便于阅读的 Markdown 格式与索引总览 README.md。
 *
 * 支持多数据源扫描：
 * 1. %APPDATA%/@soulforge/desktop/agent/sessions
 * 2. %APPDATA%/Electron/agent/sessions
 * 3. %APPDATA%/SoulForge/agent/sessions
 * 4. 自定义参数目录
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, basename, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const TARGET_BASE = join(REPO_ROOT, 'docs', 'ai-logs');
const SESSIONS_TARGET = join(TARGET_BASE, 'sessions');
const MARKDOWN_TARGET = join(TARGET_BASE, 'markdown');

const appData = process.env.APPDATA || '';
const DEFAULT_SOURCE_DIRS = [
  join(appData, '@soulforge', 'desktop', 'agent', 'sessions'),
  join(appData, 'Electron', 'agent', 'sessions'),
  join(appData, 'SoulForge', 'agent', 'sessions')
];

function findJsonlFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  function scan(curr) {
    const entries = readdirSync(curr, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(curr, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  }
  scan(dir);
  return results;
}

export function parseSessionFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);

  let meta = null;
  const items = [];
  let userPrompts = [];
  let totalSteps = 0;
  let finishReason = null;
  let taskStatus = null;
  let terminalSource = null;
  let durableTerminalSeen = false;
  let parseErrors = 0;

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      items.push(item);

      if (item.type === 'session-meta' && item.meta) {
        meta = item.meta;
      } else if (item.type === 'message' && item.message) {
        if (item.step !== undefined && item.step > totalSteps) {
          totalSteps = item.step;
        }
        if (item.message.role === 'user') {
          const text = typeof item.message.content === 'string' ? item.message.content : JSON.stringify(item.message.content);
          userPrompts.push(text);
        }
      } else if (item.type === 'turn-complete') {
        durableTerminalSeen = true;
        finishReason = typeof item.finishReason === 'string' ? item.finishReason : null;
        taskStatus = typeof item.taskStatus === 'string' ? item.taskStatus : null;
        terminalSource = 'turn-complete';
        if (Number.isFinite(item.steps)) totalSteps = Math.max(totalSteps, item.steps);
      } else if (item.type === 'session-done' && !durableTerminalSeen) {
        // Legacy desktop exports used a session-done line. Keep reading them,
        // but a later durable turn-complete remains authoritative.
        finishReason = item.finishReason;
        taskStatus = typeof item.taskStatus === 'string' ? item.taskStatus : inferTaskStatus(item.finishReason);
        terminalSource = 'session-done';
        if (Number.isFinite(item.steps)) totalSteps = Math.max(totalSteps, item.steps);
      }
    } catch {
      // 容忍单行解析失败
      parseErrors += 1;
    }
  }

  // 提取或合成 metadata
  const fileName = basename(filePath);
  // 从文件名提取时间: rollout-2026-08-21T17-12-04-007Z-sessionId.jsonl
  let startedAt = meta?.startedAt;
  let sessionId = meta?.sessionId;

  if (!startedAt) {
    const match = fileName.match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.*)\.jsonl/);
    if (match) {
      startedAt = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
      if (!sessionId) sessionId = match[2];
    }
  }

  if (!startedAt) {
    const stat = statSync(filePath);
    startedAt = stat.birthtime.toISOString();
  }

  if (!sessionId) {
    sessionId = fileName.replace(/\.jsonl$/, '');
  }

  const primaryPrompt = userPrompts[0] || '（无用户输入）';
  const shortTitle = primaryPrompt.replace(/[\r\n\t]+/g, ' ').slice(0, 50) + (primaryPrompt.length > 50 ? '...' : '');

  return {
    filePath,
    fileName,
    sessionId,
    startedAt,
    meta,
    items,
    userPrompts,
    primaryPrompt,
    shortTitle,
    totalSteps,
    finishReason: finishReason || null,
    taskStatus: taskStatus || (terminalSource ? inferTaskStatus(finishReason) : 'in_progress'),
    terminalSource,
    terminalMissing: terminalSource === null,
    parseErrors,
    sizeBytes: statSync(filePath).size
  };
}

function inferTaskStatus(finishReason) {
  if (finishReason === 'stop') return 'completed';
  if (finishReason === 'cancelled') return 'cancelled';
  if (finishReason === 'error') return 'error';
  return 'partial';
}

export function generateMarkdown(session) {
  const d = new Date(session.startedAt);
  const dateStr = isNaN(d.getTime()) ? session.startedAt : d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const mdLines = [];
  mdLines.push(`# AI 会话记录: ${session.shortTitle}`);
  mdLines.push('');
  mdLines.push(`> 📅 **记录时间**: ${dateStr} (${session.startedAt})  `);
  mdLines.push(`> 🆔 **会话 ID**: \`${session.sessionId}\`  `);
  mdLines.push(`> 📊 **总步数**: ${session.totalSteps} 步 | **文件大小**: ${(session.sizeBytes / 1024).toFixed(1)} KB  `);
  mdLines.push(`> 🏁 **终态**: \`${session.taskStatus}\`${session.finishReason ? ` / finishReason=\`${session.finishReason}\`` : ''}  `);
  if (session.terminalMissing) {
    mdLines.push('> ⚠️ **终态缺失**：该 rollout 可能仍在进行、被截断或未完成 flush；不得解读为会话完成。  ');
  }
  mdLines.push('');
  mdLines.push('---');
  mdLines.push('');

  for (const item of session.items) {
    if (item.type === 'session-meta') {
      continue;
    }

    if (item.type === 'message' && item.message) {
      const msg = item.message;
      const step = item.step ?? 0;

      if (msg.role === 'user') {
        mdLines.push(`## 👤 用户输入 (User)`);
        mdLines.push('');
        const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        mdLines.push('```text');
        mdLines.push(contentStr);
        mdLines.push('```');
        mdLines.push('');
      } else if (msg.role === 'assistant') {
        mdLines.push(`### 🤖 助手响应 (Step ${step})`);
        mdLines.push('');
        if (msg.content) {
          mdLines.push(msg.content);
          mdLines.push('');
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          mdLines.push('#### 🛠️ 发起工具调用:');
          for (const call of msg.toolCalls) {
            mdLines.push(`- **工具名称**: \`${call.name}\` (ID: \`${call.id}\`)`);
            if (call.argumentsJson) {
              mdLines.push('  ```json');
              try {
                const parsed = JSON.parse(call.argumentsJson);
                mdLines.push(JSON.stringify(parsed, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
              } catch {
                mdLines.push('  ' + call.argumentsJson);
              }
              mdLines.push('  ```');
            }
          }
          mdLines.push('');
        }
      } else if (msg.role === 'tool') {
        mdLines.push(`> **🛠️ 工具返回** (ToolCall ID: \`${msg.toolCallId}\`)`);
        mdLines.push('```json');
        try {
          const parsed = JSON.parse(msg.content);
          mdLines.push(JSON.stringify(parsed, null, 2));
        } catch {
          mdLines.push(String(msg.content).slice(0, 2000) + (String(msg.content).length > 2000 ? '\n... (truncated)' : ''));
        }
        mdLines.push('```');
        mdLines.push('');
      }
    } else if (item.type === 'interrupted') {
      mdLines.push(`> ⚠️ **会话中断**: ${item.reason || '用户或系统中断'}`);
      mdLines.push('');
    } else if (item.type === 'turn-complete') {
      mdLines.push(`> **耐久终态**: 步数 ${item.steps ?? session.totalSteps}, taskStatus=\`${item.taskStatus ?? 'unknown'}\`, finishReason=\`${item.finishReason ?? 'unknown'}\``);
      mdLines.push('');
    } else if (item.type === 'session-done') {
      mdLines.push(`> **兼容终态**: 步数 ${item.steps ?? session.totalSteps}, finishReason=\`${item.finishReason ?? 'unknown'}\``);
      mdLines.push('');
    }
  }

  return mdLines.join('\n');
}

export function renderArchiveIndex(indexRows, sessionCount, updatedAt = new Date()) {
  return [
    '# SoulForge 本地 AI 助手会话归档 (AI Conversation Logs)',
    '',
    '本索引仅描述本目录已归档的会话快照，不是客户端实时会话列表、本机历史总数或 Agent 成功率统计。桌面会话与 `output/agent-real/*.rollout.jsonl` 自动化模拟记录分开统计。',
    '',
    '## 同步方式与隐私边界',
    '',
    '只重建已有归档的索引（不扫描客户端目录，不复制或改写会话原文）：',
    '',
    '```powershell',
    'npm run ai-logs:sync -- --index-only',
    '```',
    '',
    '完整同步命令 `npm run ai-logs:sync` 会扫描本机 Electron、SoulForge 和历史 @soulforge/desktop 的 Agent 会话目录，复制原始 JSONL 并生成 Markdown；它不会自动脱敏。只有明确需要导出时才运行，提交或分享前必须审查对话、工具返回中的私人路径、凭据及 Mod 内容。',
    '',
    '索引由 [生成脚本](../../scripts/sync-ai-logs.mjs) 维护。缺失终态不能解释为完成；`completed` 等终态也是记录中的状态，不替代任务结果或原生写回验收。',
    '',
    '## 会话历史索引（按开始时间倒序，北京时间）',
    '',
    '| 记录时间 | 会话摘要 | 记录终态 | 步数 | Markdown 详情 | 原始记录 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...indexRows,
    '',
    '---',
    `*本次索引收录 ${sessionCount} 个会话。索引生成时间：${updatedAt.toISOString()}。归档覆盖时间见表格，不因重建索引而变成当前全量会话。*`
  ].join('\n');
}

export function refreshArchiveIndex(targetBase = TARGET_BASE, updatedAt = new Date()) {
  // Deliberately read only the existing repository archive: never default
  // source directories. Refreshing documentation must not export private logs.
  const archived = findJsonlFiles(join(targetBase, 'sessions')).map(parseSessionFile);
  archived.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const rows = archived.map((session) => {
    const relJsonlPath = relative(targetBase, session.filePath).replace(/\\/g, '/');
    const relMdPath = `markdown/${relative(join(targetBase, 'sessions'), session.filePath).replace(/\\/g, '/').replace(/\.jsonl$/, '.md')}`;
    const mdLink = existsSync(join(targetBase, relMdPath)) ? `[查看 Markdown](${relMdPath})` : '未生成';
    const date = new Date(session.startedAt);
    const dateText = Number.isNaN(date.getTime()) ? session.startedAt : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const title = session.shortTitle.replace(/\|/g, '\\|');
    return `| ${dateText} | ${title} | ${session.taskStatus}${session.terminalMissing ? ' (terminal missing)' : ''} | ${session.totalSteps} | ${mdLink} | [原始 JSONL](${relJsonlPath}) |`;
  });
  mkdirSync(targetBase, { recursive: true });
  writeFileSync(join(targetBase, 'README.md'), renderArchiveIndex(rows, archived.length, updatedAt), 'utf8');
  return { mode: 'index-only', archiveFiles: archived.length, sourceScanned: false, sessionFilesWritten: 0 };
}

export function sync(inputDirs = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))) {
  const sourceDirs = [...inputDirs, ...DEFAULT_SOURCE_DIRS].filter((d) => existsSync(d));
  console.log('🔍 正在扫描本地 AI 侧边栏会话记录...');
  const allJsonlFiles = [];
  for (const dir of sourceDirs) {
    console.log(`  - 扫描目录: ${dir}`);
    const files = findJsonlFiles(dir);
    console.log(`    找到 ${files.length} 个 rollout 文件`);
    allJsonlFiles.push(...files);
  }

  if (allJsonlFiles.length === 0) {
    console.log('⚠️ 未找到任何会话记录。');
    return;
  }

  // 按 sessionId 去重（相同 sessionId 选取最新的或文件更大的）
  const sessionsMap = new Map();
  for (const f of allJsonlFiles) {
    const session = parseSessionFile(f);
    const existing = sessionsMap.get(session.sessionId);
    if (!existing || session.sizeBytes > existing.sizeBytes) {
      sessionsMap.set(session.sessionId, session);
    }
  }

  const uniqueSessions = Array.from(sessionsMap.values());
  // 按时间降序排序
  uniqueSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  console.log(`📦 正在同步 ${uniqueSessions.length} 个独立会话记录到 docs/ai-logs/...`);

  mkdirSync(SESSIONS_TARGET, { recursive: true });
  mkdirSync(MARKDOWN_TARGET, { recursive: true });

  const indexRows = [];

  for (const session of uniqueSessions) {
    // 确定子目录日期: YYYY/MM/DD
    let year = '2026';
    let month = '08';
    let day = '24';
    try {
      const d = new Date(session.startedAt);
      if (!isNaN(d.getTime())) {
        year = String(d.getUTCFullYear());
        month = String(d.getUTCMonth() + 1).padStart(2, '0');
        day = String(d.getUTCDate()).padStart(2, '0');
      }
    } catch {}

    const sessionRelDir = join(year, month, day);
    const targetSessionDir = join(SESSIONS_TARGET, sessionRelDir);
    const targetMdDir = join(MARKDOWN_TARGET, sessionRelDir);

    mkdirSync(targetSessionDir, { recursive: true });
    mkdirSync(targetMdDir, { recursive: true });

    const targetJsonlPath = join(targetSessionDir, session.fileName);
    const mdFileName = session.fileName.replace(/\.jsonl$/, '.md');
    const targetMdPath = join(targetMdDir, mdFileName);

    // 复制 JSONL
    copyFileSync(session.filePath, targetJsonlPath);

    // 生成并写入 Markdown
    const mdContent = generateMarkdown(session);
    writeFileSync(targetMdPath, mdContent, 'utf8');

    // 记录索引条目
    const relMdPath = relative(TARGET_BASE, targetMdPath).replace(/\\/g, '/');
    const relJsonlPath = relative(TARGET_BASE, targetJsonlPath).replace(/\\/g, '/');
    const safePrompt = session.shortTitle.replace(/\|/g, '\\|');
    const d = new Date(session.startedAt);
    const localTimeStr = isNaN(d.getTime()) ? session.startedAt : d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    indexRows.push(
      `| ${localTimeStr} | ${safePrompt} | ${session.taskStatus}${session.terminalMissing ? ' (terminal missing)' : ''} | ${session.totalSteps} | [📖 查看对话 Markdown](${relMdPath}) | [📦 原始 JSONL](${relJsonlPath}) |`
    );
  }

  // 生成 docs/ai-logs/README.md
  writeFileSync(join(TARGET_BASE, 'README.md'), renderArchiveIndex(indexRows, uniqueSessions.length), 'utf8');
  console.log(`✅ 同步完成！已生成 ${uniqueSessions.length} 篇 Markdown 对话记录及 README 索引。`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  if (process.argv.includes('--index-only')) console.log(JSON.stringify(refreshArchiveIndex()));
  else sync();
}
