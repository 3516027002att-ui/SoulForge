# Codex Task — BND Synthetic Fixture Wire-up

这个任务是 Codex 的第二阶段任务。

优先级低于 `docs/CODEX_TASK_ROUTER_WIREUP.md` 和 GitHub issue #1。

## 目标

把已经存在的 `SyntheticBinderFixtureExports.cs` 接入 Bridge 的可验证路径，让 synthetic BND fixture 能产生 confirmed child inventory。

注意：这不是实现原生 BND3/BND4 parser。

## 当前状态

已经存在：

- `bridge/SoulForge.Bridge/SyntheticBinderFixtureExports.cs`
- `docs/V0_3_SYNTHETIC_BND_FIXTURE.md`

当前 helper 能识别 SoulForge synthetic BND fixture：

- magic: BND4 或 BND3
- marker: SFBN
- child table
- string pool
- child id/name/resourceKind/offset/packedSize/unpackedSize

预期 diagnostic code：

- `BND_SYNTHETIC_FIXTURE_CONFIRMED`

## 需要 Codex 决策的接线路径

BND 不一定应该立刻新增公开 `export-binder` 命令。

Codex 应优先选择最小、安全、符合当前架构的方案：

1. 如果现有 inspect pipeline 最适合承载 BND child inventory，则把 synthetic BND fixture 作为 inspect 的 confirmed data 分支。
2. 如果 inspect 不适合承载 structured child inventory，则新增内部 helper 路径，先不暴露 UI 写入能力。
3. 只有在确实清晰时，才考虑新增 `export-binder` 或 `export-file` 命令。

无论采用哪种方案，都必须保留现有低置信 visible-string `binderChildCandidate` fallback。

## 需要完成的内容

- 让 synthetic BND fixture 可以从 Bridge 命令路径触发；
- 输出 child inventory；
- 标注 `BND_SYNTHETIC_FIXTURE_CONFIRMED`；
- 保留 `nativeFormatAuthority = false`；
- 不把 visible-string fallback 升级成 confirmed；
- 加 smoke script 或扩展 existing synthetic smoke script；
- 更新 `docs/V0_3_FORMAT_PARSER_MILESTONE.md` 和 `docs/LOGIC_LAYER_REVIEW.md`。

## 禁止事项

Codex 不得：

- 实现原生 BND parser；
- 复制 Smithbox、SoulsFormats、WitchyBND 或其他项目代码；
- 解压真实 DCX；
- 提取或重打包真实游戏资源；
- 提交二进制 fixture；
- 绕过 Bridge；
- 改 Patch Engine；
- 改 UI。

## 验收标准

任务完成时：

1. synthetic BND fixture 能通过 Bridge 命令返回 confirmed child inventory；
2. diagnostic code 包含 `BND_SYNTHETIC_FIXTURE_CONFIRMED`；
3. child entries 包含 id、name、resourceKind、offset、packedSize、unpackedSize；
4. visible-string binderChildCandidate fallback 仍然是 low confidence；
5. build/typecheck 通过，或精确记录失败原因。
