from pathlib import Path

path = Path("docs/V0_5_IMPLEMENTATION_HANDOFF.md")
text = path.read_text(encoding="utf-8")

start = text.index("## 11. H 线：运行、验证与发行")
end = text.index("\n---\n\n## 12. I 线：渲染架构", start)
replacement = """## 11. H 线：运行、验证与发行

### me3 runtime adapter

状态：`unverified foundation`

SoulForge 不实现自己的 Mod loader 或注入器。Sekiro 首选正式集成 me3，并抽象通用运行接口：

~~~ts
interface GameRuntimeAdapter {
  detect(): Promise<RuntimeCapability>;
  prepareProfile(
    workspace: WorkspaceSession,
    options?: PrepareRuntimeProfileOptions
  ): Promise<RuntimeProfile>;
  launch(profile: RuntimeProfile, options?: LaunchRuntimeOptions): Promise<LaunchSession>;
  collectDiagnostics(session: LaunchSession): Promise<RuntimeDiagnostics>;
  terminate(session: LaunchSession): Promise<void>;
}
~~~

当前 core foundation 已具备：

- 通用 runtime capability、profile、launch session、process snapshot 和 diagnostics 契约；
- 公开 `TrustedMe3RuntimeAdapter` 强制由 main 提供用户确认过的 me3 可执行路径，PATH 不参与选择启动 authority；
- 在应用数据目录创建或更新按 workspace 稳定命名的 `.me3` profile，不向 Mod overlay 或原版目录写运行元数据；
- profile 目录逐级执行 physical path 与 junction / symlink 边界校验，拒绝重定向到应用数据目录外；
- 使用参数数组和 `shell: false` 执行 `me3 launch -p <profile>`，并阻止调用方覆盖保留参数；
- 限长捕获 stdout/stderr、退出码、信号、主动终止和启动失败状态；
- launch session 可关联 Patch operation ID；
- 零退出码只记录为进程正常退出，不冒充真实 Sekiro Mod 加载成功；
- fake process Windows smoke 覆盖 profile、参数、日志、operation 关联、终止和路径安全边界。

仍缺：

- Electron main IPC、设置持久化和 launch-session SQLite authority；
- 真实 me3 可执行文件与真实 Sekiro 启动；
- Patch operation 提交后启动验证；
- operation 回滚后再次启动与恢复判断；
- 游戏内 Mod 加载证据、崩溃信息和真实故障诊断。

me3 是可替换的运行适配器，不是工作区、Patch Engine 或语义模型的核心依赖。当前实现没有真实运行环境证据，因此不得提升为 `native-verified`。

### 发行状态：`partial / unverified`

已有：

- Windows CI 配置；
- 2026-07-23 H 线分支的公开 Windows CI 全绿证据；
- release content 扫描；
- electron-builder portable / NSIS 配置；
- private native gate 与 section-28 诚实 skip；
- 基础性能 smoke。

仍缺：

- 真正的安装包、升级和干净机验证；
- 代码签名和更新器；
- 安装包内 Bridge、自包含 .NET 和 native binding 验证；
- me3 真实启动链与桌面 IPC；
- 真实 Sekiro Mod 加载、回滚和再次启动；
- 真实模型服务循环；
- 完整性能门槛。

`skipped` 和 `unverified-no-local-sekiro-runtime` 不能算通过。
"""
text = text[:start] + replacement + text[end:]

old_frontier = "| H me3 运行 | `not-started` | runtime adapter、日志、operation-linked smoke |"
new_frontier = "| H me3 运行 | `unverified foundation` | desktop IPC、持久会话、真实 me3/Sekiro、提交后启动与回滚重启 |"
if text.count(old_frontier) != 1:
    raise RuntimeError("H frontier anchor mismatch")
text = text.replace(old_frontier, new_frontier)

old_module = "| model-services | provider adapters、agent loop、permissions |"
new_module = old_module + "\n| runtime | 可信 me3 可执行路径、profile、launch session、日志和 operation 关联 |"
if text.count(old_module) != 1:
    raise RuntimeError("core module anchor mismatch")
text = text.replace(old_module, new_module)

old_commands = "npm run typecheck\nnpm test\nnpm run bridge:verify:synthetic\nnpm run build"
new_commands = "npm run typecheck\nnpm test\nnpm run test:me3-runtime-adapter\nnpm run bridge:verify:synthetic\nnpm run build"
if text.count(old_commands) != 1:
    raise RuntimeError("validation command anchor mismatch")
text = text.replace(old_commands, new_commands)

old_entry = """### 2026-07-20：交接书重构为长期技术线路图

- 起始：`7bd354d`
- 路线：全局文档架构
- 状态变化：固定 P0-P7 阶段计划 -> 依赖驱动技术线路图
- 已实现：将工作区、容器、核心语义、行为动画、场景资产、专业编辑器、AI、me3 运行和渲染后端拆为长期主线。
- 已实现：正式纳入行为与动画路线；明确 Paramdex-compatible metadata；明确 EMEVD DSL 终局编译链；明确 me3 runtime adapter；明确 renderer-independent semantic scene、Three.js WebGPU 首选、WebGL2 fallback 和未来 native backend 边界。
- 已保留：Patch Engine、native authority、路径安全、SQLite、三层回滚和诚实诊断等硬约束。
- 非声明：文档重构不改变任何代码能力，也不把现有 partial / candidate / skipped 提升为完成。
"""
new_entry = old_entry + """
### 2026-07-23：me3 runtime foundation 与 Windows 路径身份修复

- 起始：`2002076`
- 实现结束：`4388600`
- 路线：A / H-me3
- 状态变化：H-me3 `not-started -> unverified foundation`
- 已实现：新增通用 `GameRuntimeAdapter` 契约、可信 me3 可执行路径边界、稳定 `.me3` profile、无 shell 启动、限长日志、结构化进程状态、operation 关联和受控终止。
- 已实现：profile 目录只进入应用数据目录，并对每一级现有路径执行 physical path 与 junction / symlink 防逃逸检查；公开 adapter 不允许 PATH 决定启动 authority。
- 已实现：修复 Windows runner 上调用方选择路径与 `realpath()` 物理路径命名空间不一致的问题；workspace ID 继续以物理根目录为准，写入检查同时保留 lexical 与 physical 安全边界。
- 已验证：公开 Windows CI 在 `4388600` 全绿，覆盖 typecheck、全量 unit/integration smokes、Bridge synthetic/daemon、发行内容扫描和 build；独立 core smoke 覆盖 foundation、持久化、安全边界和 me3 runtime contract。
- 样本范围：临时 workspace、fake me3 executable 和注入式 fake process；未使用真实游戏资产、用户 Mod、私有 corpus 或 Oodle runtime。
- 未验证：Electron main IPC、SQLite launch-session persistence、真实 me3、真实 Sekiro、提交后启动、回滚后重启和游戏内加载判断。
- 非声明：fake process、`.me3` profile 生成或退出码 0 均不构成真实 Sekiro runtime / native authority 证据。
- 外部阻塞：当前执行环境没有可用于合法验证的 Sekiro 与 me3 运行环境。
"""
if text.count(old_entry) != 1:
    raise RuntimeError("evidence entry anchor mismatch")
text = text.replace(old_entry, new_entry)

if text.count("状态：`unverified foundation`") != 1:
    raise RuntimeError("unexpected runtime status count")
if "| H me3 运行 | `not-started`" in text:
    raise RuntimeError("stale H frontier status remains")

path.write_text(text, encoding="utf-8")
