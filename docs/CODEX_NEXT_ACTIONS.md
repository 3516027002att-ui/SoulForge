# Codex 下一步行动检查点

这是 Codex 的当前交接文档。

SoulForge 定位：**魂游 Mod 的 Cursor**。

## 当前阶段

```text
v0.3 fixture-confirmed Bridge  ✓ 已验证
v0.5 foundation                 ✓ 2026-07-09 起步切片已落地
v0.5 architecture scaffold      ✓ 2026-07-09 text/raw/synthetic 闭环
v0.5 完整超级编辑器闭环         → 进行中
```

## 已落地的 v0.5 foundation

| 能力 | 位置 | 说明 |
|------|------|------|
| Overlay + base session | `workspace/workspaceSession.ts` | base 只读，overlay 可写 |
| Graph patch IR | `patch/graphPatch.ts` | proposal → nodes/edges |
| Operation log | `patch/operationLog.ts` | commit 后记录（内存） |
| File-backed operation log | `patch/fileOperationLogStore.ts` | JSON 落盘，reopen 后仍可用 |
| File rollback | `patch/rollback.ts` | 从 backup 恢复 |
| AI permission ladder | `ai/toolPermissions.ts` | read→rollback |
| SQLite schema v2 | `storage/sqliteSchema.ts` | patch_history / diagnostics / agent_runs |
| Desktop history + rollback IPC | `apps/desktop` main/preload/renderer | `operation.list` / `operation.rollback` |
| Optional base open | `workspace.openBaseDialog` + scan | 打开 overlay 时可挂只读 base |
| Resource mode UI | `App.tsx` | Files + 各资源 kind 过滤 |
| Foundation smoke | `runV05FoundationSmoke.ts` + `runV05PersistSmoke.ts` | memory + disk reopen |
| Architecture scaffold | `packages/shared` + `packages/core` new modules | URI/VFS/Graph/PatchIR/Tx/AI/Bridge |
| Architecture smoke | `runV05ArchitectureScaffoldSmoke.ts` | text/raw/synthetic vertical slice |

## 验证命令

```powershell
npm run typecheck
npm run test
npm run bridge:verify:synthetic
npm run build
```

额外：

```powershell
npm run test:v05-foundation -w @soulforge/core
npm run test:v05-architecture -w @soulforge/core
```

## 下一优先级（仍守硬边界）

### P0（已完成 2026-07-09）

1. ~~Desktop 暴露 operation history + 一键 rollback UI~~（`operation.list` / `operation.rollback` IPC + AI 侧历史面板）。
2. ~~打开工作区时可选 base 游戏目录（只读）~~（`workspace.openBaseDialog` + scan 透传 `baseRoot`）。
3. ~~落盘 operation log~~（`FileOperationLogStore` JSON adapter；SQLite driver 接线仍可后续替换，schema 已就绪）。

### P1

1. AI 侧边栏展示 patch graph 摘要。
2. Files mode unsupported 风险确认流。
3. ~~structured writer contract 接口（先类型 + gate，再按资源实现）~~（metadata gate 已有；operational `WriterAdapterContract` + text/raw/synthetic scaffold 已落地，native structured writer 仍未实现）。
4. 可选：将 `FileOperationLogStore` 换为真正的 SQLite adapter（schema 已有）。
5. 将 architecture scaffold 的 ResourceGraph / AuditLog 接到现有 Patch Engine / desktop 只读展示（仍禁止伪 native writer）。

### P2（慢推，禁止伪完成）

- native DCX/BND/EMEVD/PARAM/MSB/FMG：继续 evidence-first，有 fixture 才升 confidence。
- 不碰：3D、Blender MCP、本地 LLM、vector DB、裸二进制重写。

## 硬边界

- 所有写入必须经 Patch Engine。
- 禁止写 base 游戏目录。
- 禁止 renderer 直接访问文件系统。
- 禁止复制外部 FromSoftware 工具源码。
- 禁止提交真实游戏资源 / 用户 Mod。
- 禁止把 synthetic fixture 说成 native parser 完成。
