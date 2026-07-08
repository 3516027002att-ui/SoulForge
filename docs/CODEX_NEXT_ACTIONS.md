# Codex 下一步行动检查点

这是 Codex 的当前交接文档。

SoulForge 的对外目标是《只狼》和魂系 Mod 的 AI 超级编辑器：让 AI 像 Cursor 改代码一样，在证据、计划、补丁、验证和回滚保护下修改 Mod。

## 当前状态

v0.3 聚焦 fixture-confirmed parser plumbing。

核心链路：

```text
event -> map -> param -> msg
```

同时 BND child inventory 是很多资源的容器入口。

已存在：

- FMG synthetic fixture path 已通过 export-msg 接入；
- `SyntheticFixtureExports.cs` 已包含 event 和 PARAM synthetic fixture helper；
- `SyntheticMapFixtureExports.cs` 已包含 map synthetic fixture helper；
- `SemanticCandidateExports.cs` 已把 event / PARAM / map synthetic helper 接入 export-event / export-param / export-map；
- `SyntheticBinderFixtureExports.cs` 已包含 BND synthetic child inventory helper，并可供 export 与 inspect 复用；
- `bridge/SoulForge.Bridge/scripts/verify-synthetic-core-fixtures.ps1` 已覆盖 export-msg / export-event / export-param / export-map，并追加 synthetic DCX DFLT inspect 断言；
- `scripts/verify-synthetic-core-fixtures.mjs` 已新增为跨 Windows / WSL 的 Node smoke wrapper，生成同一批 synthetic fixtures；
- `DcxPayloadProbe.cs` 已接入 inspect，能输出 DCX payload boundary evidence，对 DFLT/zlib payload 做 bounded decompressed preview，并在 synthetic BND preview 上追加 nested binder evidence；
- KRAK / EDGE / ZSTD 当前只做边界识别和 unsupported decompression diagnostic，不尝试伪解压；
- `CODEX_TASK_BND_FIXTURE_WIREUP.md` 记录 issue #2 的后续任务；
- param / map Bridge exports 现在已在结构化预览中可见；下一目标是 BND child row table 渲染和 writer contract 规划；
- GitHub issue #1：event / param / map router wire-up，代码侧已完成，仍需本地 dotnet smoke 验证；
- GitHub issue #2：BND synthetic child inventory wire-up。

重要 caveat：

- Event、PARAM、map synthetic helpers 已接入 router，但当前 CodexPro 运行壳无法稳定执行 Bridge dotnet smoke，所以 Bridge smoke 需要在本地终端或修复 .NET 环境后执行；
- DCX payload boundary / DFLT preview 代码已接入，但不要在 `bridge:verify:synthetic` 通过前声称 DCX 验证完成；
- BND synthetic helper 已接入 inspect/export 复用入口，但不要在 Bridge smoke 通过前声称 BND 验证完成；
- 不要在 dotnet build 和 smoke script 证明前声称 issue #1 完全验证通过；
- 不要在 BND smoke 通过前声称 v0.3 BND child inventory 已完成。

## 当前优先级

### 第一优先级：本地验证 issue #1 + DCX inspect

在本地终端执行：

```powershell
npm run bridge:build
npm run bridge:verify:synthetic
```

`bridge:verify:synthetic` 当前走 Node wrapper；保留 PowerShell fixture 脚本作为 Windows 手动诊断入口。

必须断言：

- MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED；
- EMEVD_SYNTHETIC_FIXTURE_CONFIRMED；
- PARAM_SYNTHETIC_FIXTURE_CONFIRMED；
- MSB_SYNTHETIC_FIXTURE_CONFIRMED；
- DCX_PAYLOAD_BOUNDARY_CONFIRMED；
- DCX_DFLT_DECOMPRESSED_PREVIEW_READY。

不要提交二进制 fixture。

### 第二优先级：issue #2，BND synthetic fixture wire-up

阅读：

- `docs/CODEX_TASK_BND_FIXTURE_WIREUP.md`；
- `docs/V0_3_SYNTHETIC_BND_FIXTURE.md`。

BND 任务要谨慎决策接线路径：

- 可以接入 inspect confirmed branch；
- 可以新增内部 helper path；
- 只有非常清晰时才新增公开 export-binder / export-file command。

必须保留 visible-string binderChildCandidate 作为 low-confidence fallback。

### 第三优先级：build / typecheck

运行：

```bash
npm run typecheck
npm run build
```

当前 CodexPro 记录：

- `npm run typecheck` 已通过；
- `npm run build` 失败于本地 Rollup optional dependency 缺失：`@rollup/rollup-linux-x64-gnu`，需要刷新 node_modules / npm install 状态后再跑。

如果失败，只修当前任务所需的最小 compile/type 问题。

### 第四优先级：状态文档更新

issue #1 本地 dotnet smoke 通过后，继续更新：

- `docs/V0_3_FORMAT_PARSER_MILESTONE.md`；
- `docs/LOGIC_LAYER_REVIEW.md`。

当前文档已记录 router wire-up 代码完成、smoke 脚本已添加、CodexPro safe bash 未能执行 dotnet / PowerShell 验证。

不要声称 native FMG、EMEVD、PARAM、MSB、BND parser 已完成。

## 硬边界

Codex 不得：

- 复制外部 parser 实现；
- 提交真实游戏资源或用户 Mod 文件；
- 从 synthetic fixture 推导并声称 native parser 权威完成；
- 移除低置信 fallback；
- 让 renderer 直接解析 native binary；
- 改 UI scope；
- 改 Patch Engine；
- 在当前任务里实现 native BND、EMEVD、PARAM、MSB parser；
- 开始 Blender、MCP、本地 LLM、vector database 工作。

## issue #1 完成定义

1. export-msg 能对 generated synthetic FMG fixture 返回 MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED；
2. export-event 能对 generated synthetic event fixture 返回 EMEVD_SYNTHETIC_FIXTURE_CONFIRMED；
3. export-param 能对 generated synthetic PARAM fixture 返回 PARAM_SYNTHETIC_FIXTURE_CONFIRMED；
4. export-map 能对 generated synthetic map fixture 返回 MSB_SYNTHETIC_FIXTURE_CONFIRMED；
5. 非 synthetic 输入仍回落到低置信 candidates 或 structured unsupported；
6. build 和 typecheck 通过，或精确记录失败原因。

## issue #2 完成定义

1. synthetic BND fixture 能通过 Bridge 命令路径返回 confirmed child inventory；
2. diagnostic code 包含 BND_SYNTHETIC_FIXTURE_CONFIRMED；
3. children 包含 id、name、resourceKind、offset、packedSize、unpackedSize；
4. visible-string binderChildCandidate fallback 仍保持 low confidence；
5. build 和 typecheck 通过，或精确记录失败原因。
