# 逻辑层检查清单

这个文档用于检查 SoulForge 的早期逻辑层状态。它服务于“AI Mod 超级编辑器”的目标，而不是某个单独事件编辑器产品。

## 已完成范围

- Bridge 的 inspect / validate 使用有界前缀读取，避免启动时吞大文件。
- Bridge inspect 返回资源包络证据和诊断，不假装已经完成语义解析。
- Parser result 类型已经和 Program.cs 分离。
- Program.cs 已直接路由 export 命令，不再依赖 BridgeResult.Unsupported 的兼容分发副作用。
- export-msg 已路由到保守的 partial message export。
- export-event、export-param、export-map 已路由到低置信 native semantic candidate export。
- Envelope inspection 能通过 header magic 识别常见资源包络。
- Envelope inspection 会把可见路径线索记录为低置信证据。
- Envelope inspection 会把可见 BND child name 记录为低置信 binderChildCandidate evidence。
- Envelope inspection 会把可能的 nested native formats 记录为低置信 nestedMagicCandidate evidence。
- Bridge 已有可读 raw string 的 partial message export。
- Message export 在 DCX/BND 容器边界停止，直到解包能力存在。
- FMG-like 文件会先走 guarded table-candidate pass，再回落 raw string scan。
- Bridge 已有 EMEVD event ID、PARAM row ID、MSB entity name 的低置信候选导出。
- Event / map / param candidate export 会在 DCX/BND 容器边界停止。
- Workspace analysis 已有 native inspection pass，并且和 text / JSON semantic ingestion 分离。
- Workspace analysis 可以接收 partial native msg exports 和低置信 native semantic candidate exports。
- WorkspaceIndex 暴露稳定 stats 和多匹配 text lookup API。
- AI-safe tools 包括 workspace_stats、lookup_text_id、find_text_references、explain_text_entry。
- AI context builder 能生成 evidence-first 的 text explanation prompt。
- Native inspection diagnostics 会记录为 workspace diagnostics，不会被当成 semantic symbols。
- Electron IPC 会暴露 parsedFiles 和 inspectedFiles。
- FMG synthetic fixture path 已接入 export-msg。
- Event、PARAM、map synthetic fixture helpers 已写入，但还需要 Codex 完成 router wire-up。

## 硬边界

- 不复制外部 parser 代码。
- Inspect 只返回证据，不返回伪语义解析。
- Path hints 只是低置信证据，不是权威 BND child table。
- binderChildCandidate 只是 visible-string evidence，直到 BND table fixture 证明 offsets、sizes、names。
- nestedMagicCandidate 只是 bounded-prefix evidence，直到 DCX 解压和 BND 解包存在。
- Native msg export 仍是 partial；FMG table candidate 必须经过 fixture review 才能视为权威。
- EMEVD、PARAM、MSB candidate export 是低置信 bootstrap，不是最终 parser。
- Raw string fallback 使用 file offset 作为临时 text ID。
- AI 和 UI 不能直接解析 native binary resource。
- AI-safe read tools 可以查询 index 和 reference graph，但不能直接解析文件或写文件。
- 所有写入必须留在 Patch Engine 后面。

## Reviewer 命令

从仓库根目录运行：

```bash
npm install
npm run typecheck
npm run build
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
```

Bridge smoke checks：

```bash
dotnet run --project bridge/SoulForge.Bridge -- inspect README.md
dotnet run --project bridge/SoulForge.Bridge -- export-msg README.md
```

Native candidate smoke checks 可使用本地 fixture 或用户提供文件：

```bash
dotnet run --project bridge/SoulForge.Bridge -- export-event path/to/file.emevd
dotnet run --project bridge/SoulForge.Bridge -- export-param path/to/file.param
dotnet run --project bridge/SoulForge.Bridge -- export-map path/to/file.msb
```

## inspect 预期形态

- parseStatus 是 partial；
- diagnostics 非空；
- data.rootFormat 存在；
- data.evidence 存在；
- data.nextSteps 存在；
- 可见资源名可以作为低置信 pathHint evidence 出现；
- BND 文件可以出现低置信 binderChildCandidate evidence；
- packed/container 文件可以出现低置信 nestedMagicCandidate evidence。

## export 预期行为

- Program.cs 直接路由 export 命令，不通过 BridgeResult.Unsupported 副作用；
- 对可读 raw text，export-msg 的 parseStatus 可以是 partial，data.entries 应存在；
- 对自洽 FMG-like table candidate，diagnostics 应包含 MSG_FMG_TABLE_CANDIDATE；
- 对 synthetic FMG fixture，diagnostics 应包含 MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED；
- 对 packed DCX/BND container，semantic export 应保持 unsupported，并返回 container-boundary diagnostics；
- raw fallback text ID 是 offset，table-candidate text ID 来自 candidate rows；
- export-event / export-param / export-map candidate outputs 必须保持低置信，直到 fixture-confirmed。

## AI 工具预期行为

- workspace_stats 返回 WorkspaceIndex 中的 file、symbol、reference counts；
- lookup_text_id 接收 number 或 numeric string，可接收 category，并返回所有匹配文本；
- find_text_references 接收 number 或 numeric string，可接收 category，并返回匹配文本和 inbound references；
- explain_text_entry 返回结构化 text explanation context 和 prompt；
- lookup_text_id、find_text_references、explain_text_entry 不应直接扫描文件。

## 下一批 parser 里程碑

1. 用 fixture-confirmed FMG text ID table parsing 替换 FMG table candidate 逻辑。
2. 用 fixture-confirmed BND child table listing 替换 binderChildCandidate visible-string evidence。
3. 用 fixture-confirmed event / instruction table export 替换 EMEVD event ID candidates。
4. 用 fixture-confirmed row / field export 替换 PARAM row ID candidates。
5. 用 fixture-confirmed entity / region / transform / model export 替换 MSB visible-name candidates。

## Codex 当前入口

Codex 当前应优先阅读：

- docs/CODEX_NEXT_ACTIONS.md
- docs/CODEX_TASK_ROUTER_WIREUP.md

Codex 当前任务只应做 synthetic fixture router wire-up、类型小修、smoke script 和必要 build 修复。不要在这个任务中扩展到真实 native parser、UI 重构或 Patch Engine 改造。
