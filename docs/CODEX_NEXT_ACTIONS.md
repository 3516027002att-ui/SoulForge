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
- `SyntheticBinderFixtureExports.cs` 已包含 BND synthetic child inventory helper；
- `CODEX_TASK_ROUTER_WIREUP.md` 记录 issue #1 的窄任务；
- `CODEX_TASK_BND_FIXTURE_WIREUP.md` 记录 issue #2 的后续任务；
- GitHub issue #1：event / param / map router wire-up；
- GitHub issue #2：BND synthetic child inventory wire-up。

重要 caveat：

- Event、PARAM、map synthetic helpers 已写入，但还没接入 SemanticCandidateExports 或 Program.cs；
- BND synthetic helper 已写入，但还没接入 inspect/export 路径；
- 不要在 build 和 smoke script 证明前声称这些路径已完成。

## 当前优先级

### 第一优先级：issue #1

先完成 event / PARAM / map synthetic fixture router wire-up。

在 `SemanticCandidateExports.cs`：

- TryExportEvent 保留 packed-container boundary handling first；
- 然后调用 SyntheticFixtureExports.TryExport for event；
- 然后保留现有 low-confidence event ID candidate scan；
- TryExportParam 同理，先 boundary，再 synthetic PARAM，再低置信 row ID candidate；
- TryExportMap 同理，先 boundary，再 SyntheticMapFixtureExports，再 visible-name fallback。

不要移除现有 fallback。

### 第二优先级：PARAM 类型小修

检查 `SyntheticFixtureExports.cs`。

如果 synthetic PARAM field value 在一个条件表达式里混用 bool 和 int，就改成先赋给 object，再输出 value。

不要改变 JSON shape。

### 第三优先级：core synthetic smoke script

添加或更新：

```text
bridge/SoulForge.Bridge/scripts/verify-synthetic-core-fixtures.ps1
```

覆盖：

- export-msg；
- export-event；
- export-param；
- export-map。

必须断言：

- MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED；
- EMEVD_SYNTHETIC_FIXTURE_CONFIRMED；
- PARAM_SYNTHETIC_FIXTURE_CONFIRMED；
- MSB_SYNTHETIC_FIXTURE_CONFIRMED。

不要提交二进制 fixture。

### 第四优先级：build / typecheck

运行：

```bash
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
npm run typecheck
npm run build
```

如果失败，只修当前任务所需的最小 compile/type 问题。

### 第五优先级：状态文档更新

issue #1 完成后，更新：

- `docs/V0_3_FORMAT_PARSER_MILESTONE.md`；
- `docs/LOGIC_LAYER_REVIEW.md`。

移除 event / PARAM / map synthetic helpers 仍待 router wire-up 的 caveat。

不要声称 native FMG、EMEVD、PARAM、MSB、BND parser 已完成。

## 后续任务：issue #2

issue #1 完成后，再处理 BND synthetic fixture wire-up。

阅读：

- `docs/CODEX_TASK_BND_FIXTURE_WIREUP.md`；
- `docs/V0_3_SYNTHETIC_BND_FIXTURE.md`。

BND 任务要谨慎决策接线路径：

- 可以接入 inspect confirmed branch；
- 可以新增内部 helper path；
- 只有非常清晰时才新增公开 export-binder / export-file command。

必须保留 visible-string binderChildCandidate 作为 low-confidence fallback。

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
