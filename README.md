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

接手实现的 Agent 必须先阅读根目录 [AGENTS.md](AGENTS.md)，再阅读交接书的全局地图、当前技术前沿和相关区域。

## 长期技术主线

- 工作区、VFS、安全写入、SQLite、审计与三层回滚。
- DFLT、KRAK、BND4 native 容器。
- FMG、PARAM、EMEVD、MSB 核心语义资源。
- TAE、ESD、动画与脚本等行为主线，具体 Sekiro 格式以真实 corpus 为准。
- MSB 场景、FLVER、TPF、DDS、MTD、碰撞与开放格式资产转换。
- Safe Hex、EMEVD 四视图与可编译 DSL、PARAM、FMG、本地化、3D 场景和运维面板。
- OpenAI-compatible、Anthropic-compatible 双模型服务 Agent。
- me3 runtime adapter、真实 Sekiro 启动、日志、回滚后再次验证。
- renderer-independent semantic scene；Three.js WebGPU 首选、WebGL2 fallback，必要时增加 native renderer backend。

## 当前真实能力

已经具备的主要底座：

- Electron + React + TypeScript 桌面壳。
- .NET 10 `win-x64` Bridge daemon 和协议 1.0 长连接客户端。
- Mod 覆盖层可写、原版目录只读、路径和 reparse 边界校验。
- PatchIR + `WorkspaceTransaction` 唯一 production commit 主干。
- 暂存、hash 前置条件、备份、原子替换、重读和 operation/file/resource-entry 回滚基础。
- SQLite 两库、migration、journal、文件索引、FTS、诊断、任务、恢复点和审计基础。
- DFLT 真实 corpus 往返；DFLT 外层 BND4 读取、五类 mutation、repack、提交和回滚。
- FMG 真实语义闭环；PARAM、EMEVD、MSB 的部分 native 文档与 mutation。
- EMEVD 四视图、PARAM/FMG/MSB 实时桌面接线。
- Three.js 代理场景、资产暂存、最小 RGBA8 -> DDS 写回。
- OpenAI Responses / Chat Completions compatible 与 Anthropic Messages fake-server tool loop。
- safeStorage 凭据库和权限门控基础。
- Windows CI、内容扫描、portable/NSIS 配置和诚实 private gate。

当前主要前沿：

- KRAK 成功路径受合法 Sekiro Oodle runtime 环境阻塞。
- PARAM 需要旧布局与 Paramdex-compatible metadata authority。
- EMEVD 需要 layer 变体、完整 EMEDF、全 corpus 和可写 DSL compiler。
- MSB 需要全实体 CRUD、引用修复和完整 scene projection。
- 行为与动画主线尚待真实 Sekiro corpus 研究。
- FLVER/TPF/MTD 与完整资产转换仍处于 partial/candidate。
- Three.js 需要真实大地图 WebGPU 基准；场景架构必须保持后端可替换。
- 真实模型服务、me3 运行适配器、签名发行和真实 Sekiro 启动门禁尚未完成。

测试名中的 `v0.5`、`v0.6`、`native` 或 `section28` 不能单独作为产品完成证明。

## 安全写入

所有修改必须经过：

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
- [产品愿景](docs/PRODUCT_VISION.md)
- [Parser 研究边界](docs/PARSER_RESEARCH.md)

Synthetic 技术规格：

- [FMG 测试样本](docs/V0_3_FMG_SYNTHETIC_FIXTURE.md)
- [Event/PARAM 测试样本](docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md)
- [MSB 测试样本](docs/V0_3_SYNTHETIC_MAP_FIXTURE.md)
- [BND 测试样本](docs/V0_3_SYNTHETIC_BND_FIXTURE.md)

开发桥：

- [CodexPro 快速启动](docs/CODEXPRO_QUICKSTART.md)
- [CodexPro 接入说明](docs/CODEXPRO_INTEGRATION.md)

旧 milestone、fork、task、project-state、next-actions 和 development-log 文档不再作为当前口径，也不应恢复。

真实游戏资产、用户 Mod、私有测试语料、Oodle DLL 和任何明文凭据都不得提交。