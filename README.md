# SoulForge

SoulForge 是面向 Sekiro 和 FromSoftware Mod 的 AI 原生、安全、可审查、可回滚工作台。

产品定位：

~~~text
魂游 Mod 的 Cursor
~~~

用户提出修改目标后，SoulForge 应从真实资源证据出发，建立引用关系，生成补丁，在暂存区验证，通过 Patch Engine 安全提交，并能可靠回滚。

## 当前里程碑

当前里程碑：**SoulForge V0.5**。

唯一完整实施规范：

- [V0.5 实施交接书](docs/V0_5_IMPLEMENTATION_HANDOFF.md)

接手实现的 Agent 必须先阅读根目录 [AGENTS.md](AGENTS.md)，再完整阅读交接书。旧版里程碑、分叉、任务和状态文档已经删除，避免多套口径互相冲突。

## V0.5 发布目标

- Windows 10/11 x64。
- Sekiro 为唯一 native 权威验收基线。
- DFLT、KRAK、BND4 原生容器闭环。
- EMEVD、MSB、PARAM、FMG 无损语义 CRUD、重排、类型转换、验证和回滚。
- 安全 Hex、EMEVD 四视图、PARAM、FMG 本地化、MSB 完整 3D 场景。
- glTF/GLB、PNG/TGA/DDS 自动转换与资产替换。
- OpenAI-compatible、Anthropic-compatible 双模型服务 Agent。
- SQLite 权威索引、诊断、补丁、历史、审计和恢复。

## 当前真实能力

已经具备：

- Electron/React/TypeScript 桌面壳。
- C# Bridge envelope inspection。
- Mod 覆盖层与原版只读层。
- PatchIR + WorkspaceTransaction 写入主干。
- 文本、原始字节区间和整文件安全补丁。
- 暂存、hash 前置条件、备份、原子替换、operation/file 回滚。
- bounded preview、VFS、资源关系图、证据包和补丁影响图骨架。
- synthetic DFLT/BND/FMG 与容器 child replace 测试链。

尚未完成：

- 真实 BND4/KRAK authority。
- 真实 EMEVD/MSB/PARAM/FMG parser/writer。
- SQLite runtime authority。
- Bridge daemon。
- resource entry 回滚。
- 专业编辑器、完整 3D 和资产转换。
- 真实模型服务 Agent。
- Windows 正式发行链。

测试名中的 `v0.5` / `v0.6` 只代表内部切片，不能当作产品版本完成证明。

## 安全写入

所有修改必须经过：

~~~text
修改请求
  -> PatchIR
  -> 暂存区
  -> 验证
  -> 备份
  -> 原子替换
  -> 重读/重解析
  -> 增量索引
  -> 审计
  -> 回滚
~~~

renderer、转换器、AI 完全权限和外部工具都不能绕过这条主干。

## 开发命令

~~~powershell
npm install
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
npm run dev
~~~

本机真实 Mod 验证：

~~~powershell
npm run test:native-preview
npm run test:real-mod -w @soulforge/core
~~~

## 保留文档

实施与约束：

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

真实游戏资产、用户 Mod、私有测试语料、Oodle DLL 和任何明文凭据都不得提交。
