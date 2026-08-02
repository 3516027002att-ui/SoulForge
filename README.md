# SoulForge

SoulForge 是面向 Sekiro 和 FromSoftware Mod 的 AI 原生、安全、可审查、可回滚工程工作台。

产品定位：

~~~text
魂游 Mod 的 Cursor
~~~

用户提出修改目标后，SoulForge 应从真实资源证据出发，建立跨资源关系，生成 typed mutation 与 PatchIR，在暂存区验证，通过 Patch Engine 安全提交，并能把运行结果、审计和回滚关联起来。

## 当前里程碑

当前长期里程碑：**SoulForge V0.5**。

项目不急于上线。V0.5 允许沿多条技术主线长期推进，但不能用 scaffold、代理几何、fake server、少量样本或诚实 skip 冒充完整能力。

唯一实施规范与当前技术线路图：

- [V0.5 实施交接书](docs/V0_5_IMPLEMENTATION_HANDOFF.md)

接手实现的 Agent 必须直接阅读交接书的全局地图、当前技术前沿、执行面板和相关区域；需要机械化选点与沉淀流程时，再配合执行手册使用。

## 长期技术主线

- 工作区、VFS、安全写入、SQLite、审计与三层回滚。
- DFLT、KRAK、BND4 native 容器。
- FMG、PARAM、EMEVD、MSB 核心语义资源。
- TAE、ESD、动画与脚本等行为主线，具体 Sekiro 格式以真实 corpus 为准。
- MSB 场景、FLVER、TPF、DDS、MTD、碰撞与开放格式资产转换。
- 只读 Hex 证据视图、EMEVD 四视图与可编译 DSL、PARAM、FMG、本地化、3D 场景和运维面板。
- OpenAI-compatible、Anthropic-compatible 双模型服务 Agent。
- me3 runtime adapter、真实 Sekiro 启动、日志、回滚后再次验证。
- renderer-independent semantic scene；Three.js WebGPU 首选、WebGL2 fallback，必要时增加 native renderer backend。

以上是长期主线，不等于当前里程碑范围。

## 当前里程碑范围（V0.5 文本优先）

V0.5 已收窄为文本优先的五个编辑器：

- `BND4`、`FMG`、`PARAM`（仅 gameparam）、`EMEVD` 四项为 typed mutation。
- `script`（luabnd / action `*.hks`）为只读 + 整内层文件替换：内层是 `\x1bLuaQ` 编译字节码，本版不反编译、不重编译。

MSB、TAE、ESD、FLVER/资产线与 3D 渲染线已延期 V0.6。既有面板保留为**标记只读预览**，不计入本版发布编辑器，写入路径在 capability contract、shared 清单和主进程 IPC 三层失败关闭。延期不等于完成，也不清偿任何技术缺口；范围与 Gate 口径以交接书 §18.3 为准。

## 当前真实能力

已经具备的主要底座：

- Electron + React + TypeScript 桌面壳。
- .NET 10 `win-x64` Bridge daemon 和协议 1.0 长连接客户端。
- Mod 覆盖层可写、原版目录只读、路径和 reparse 边界校验。
- PatchIR + `WorkspaceTransaction` 唯一 production commit 主干。
- 暂存、hash 前置条件、备份、原子替换、重读和 operation/file/resource-entry 回滚基础。
- SQLite 两库、migration、journal、文件索引、FTS、诊断、任务、恢复点和审计基础。
- DFLT 真实 corpus 往返；BND4 读取、五类 mutation、repack、提交和回滚；合法 Oodle 下一个登记 KRAK writer roundtrip。
- FMG 真实语义闭环；PARAM、EMEVD、MSB 的部分 native 文档与 mutation；固定 Smithbox metadata 与 135/138 登记 PARAM 严格匹配。
- EMEVD 四视图、PARAM/FMG 实时桌面接线；MSB/TAE/ESD 登记样本 native document 与只读工作台（V0.6 延期预览）。
- FLVER/TPF 登记样本只读 native document、FLVER 查看/GLB 导出和 TPF 开放格式导出；Three.js WebGPU-first / WebGL2 fallback 骨架（均为 V0.6 延期预览）。
- OpenAI Responses / Chat Completions compatible 与 Anthropic Messages fake-server tool loop。
- 双协议错误、取消、超时和限额离线 conformance。
- safeStorage 凭据库和权限门控基础。
- Windows CI、内容扫描、NSIS 配置和诚实 private gate；代码签名不属于 V0.5 验收。

当前主要前沿（V0.5 文本优先范围内）：

- KRAK 需要组合 mutation/repack、未知字段保持、恢复与完整 corpus 写回矩阵。
- PARAM 需要 3 个旧布局、完整字段级 writer、引用和全 gameparam corpus 验证。
- EMEVD 需要 layer 真实变体、完整 EMEDF 与 control-flow validation、全 corpus。
- script 需要容器 magic/reference inventory，以及整内层文件替换的真实写/重读/回滚与游戏加载。
- 五个编辑器需要真实文档完整有界访问与 Electron 真实文档功能验收。
- NSIS 安装/升级/卸载 lifecycle 与真实 Sekiro 会话仍待验证。

已延期 V0.6（本版不判定，不作为前沿）：MSB 全实体 CRUD 与 scene projection、TAE/ESD 完整语义与 writer、MTD/collision/navigation 与完整资产引用/导出、WebGPU/WebGL2 功能闭环。场景架构仍须保持后端可替换。
- AI 真实工作区 typed mutation、NSIS lifecycle、me3 capability probe 和真实 Sekiro 启动尚未完成。

测试名中的 `v0.5`、`v0.6`、`native` 或 `section28` 不能单独作为产品完成证明。

## 安全写入

所有用户 Mod 资源写入必须经过：

~~~text
修改意图
  -> typed mutation / PatchIR
  -> 暂存区
  -> 验证
  -> 备份与恢复点
  -> 原子替换
  -> 重读 / 重解析
  -> 增量索引
  -> 审计
  -> operation / file / resource-entry 回滚
~~~

renderer、AI 完全权限、converter、native writer 和外部工具都不能绕过这条主干。

## 开发命令

~~~powershell
npm install
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
npm run dev
~~~

Bridge 与本机 native smoke 见根 `package.json`。真实游戏或私有 corpus 不存在时，相关命令必须诚实返回 skipped / unverified，不能用 synthetic 结果替代。

## 保留文档

实施与边界：

- [V0.5 实施交接书](docs/V0_5_IMPLEMENTATION_HANDOFF.md)
- [Agent 执行手册](docs/AGENT_EXECUTION_PLAYBOOK.md)
- [产品愿景](docs/PRODUCT_VISION.md)
- [Parser 研究边界](docs/PARSER_RESEARCH.md)

一次性任务清单（用完即弃，不属于保留文档）：

- [高难度档 HARD.md](docs/plan/HARD.md)：需要判断与权衡的任务
- [机械档 MECH.md](docs/plan/MECH.md)：判据固定、不易出错的任务

两档任务全部完成后删除 `docs/plan/` 整个目录，并同时移除本节——链接门禁会因目录消失而
报 `DEAD_LINK`，这是预期行为，退场步骤见 `docs/plan/HARD.md` 的 T-H4。

Synthetic 技术规格：

以下 synthetic 规格文档在文档同步基线 `2002076` 中受 Git 跟踪，但在当前工作树中处于删除状态，删除意图尚未确认并形成提交（见交接书第 19 节）：

- `docs/V0_3_FMG_SYNTHETIC_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md`
- `docs/V0_3_SYNTHETIC_MAP_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_BND_FIXTURE.md`

在删除意图被裁定前，不恢复、不覆盖这些路径，也不将其描述为当前可读文档。synthetic authority 以实际 fixture 生成器、Bridge 代码和 `npm run bridge:verify:synthetic` 断言为准，而非上述文档。

开发桥：

- [CodexPro 快速启动](docs/CODEXPRO_QUICKSTART.md)
- [CodexPro 接入说明](docs/CODEXPRO_INTEGRATION.md)

旧 milestone、fork、task、project-state、next-actions 和 development-log 文档不再作为当前口径，也不应恢复。

真实游戏资产、用户 Mod、私有测试语料、Oodle DLL 和任何明文凭据都不得提交。
