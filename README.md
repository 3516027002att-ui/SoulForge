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

当前工作树已经由本地回归证实（最近一次完整回归见交接书第 43 节）：

- Electron/React/TypeScript 桌面壳。
- .NET 10 Bridge daemon、协议 1.0 长连接、取消/超时/崩溃失败关闭。
- Mod 覆盖层与原版只读层。
- PatchIR + WorkspaceTransaction 写入主干。
- SQLite 两库 migration、utility process、文件索引/FTS、事务、恢复点、审计和任务基础 repository。
- 文本、原始字节区间、整文件及 DFLT-BND4 子项安全补丁。
- 暂存、hash 前置条件、备份、原子替换、operation/file/resource-entry 回滚主干。
- 本机私有样本中的 144 个 DFLT 与 75 个 DFLT-BND4 容器已通过当前断言；BND4 公共 authority 仍保持 `candidate`。
- FMG `item.msgbnd` 18/18 子项闭环；raw FMG 的已有文本、槽位删除/追加/重排已走 typed PatchIR，并验证重复 ID occurrence 隔离、完整顺序重读、resource-entry 语义回滚与 operation 字节回滚。10 个已登记 DFLT-wrapped EMEVD（9696 events / 126562 instructions）可直接从 `.emevd.dcx` 读取、暂存、重读，并通过当前 rest/args、事件增删/复制/重排断言；`restBehavior`、`instruction args`、空事件新增、既有非空事件删除/复制、完整事件顺序重排，以及 instruction 新增/复制/删除/重排已有 typed entry rollback。新增 instruction 使用 Bridge 权威生成的零参数、`layerOffset=-1` 版本化快照；事件和 instruction inverse 同样使用 Bridge 权威、版本化且有 256 KiB 上限的完整快照。真实 `common.emevd.dcx` 已验证事件恢复 7 条指令/6 条参数替换、instruction 恢复目标的 2 条参数替换，operation rollback 恢复外层字节。
- PARAM 已对当前 `gameparam.parambnd` 的 138/138 子项完成无修改字节/语义往返，并覆盖长偏移与两种 header-embedded type name 布局；用户派生字段与 MSB part 位置已有 typed entry rollback，但二者均未完成完整 P3，MSB authority 仍为 `candidate`。
- OpenAI-compatible / Anthropic-compatible core adapter fake-server tool loop，以及桌面 main 中基于 app.db grant、safeStorage、Context Broker、唯一生产 ToolRegistry 和历史/出站审计的 production caller。

仍未完成，且不得从测试退出码或界面演示推断为完成：

- KRAK 重压和完整发布 corpus；当前已有 1 个 registry/hash 绑定的真实 Oodle/KRAK 解压正向样本及登记 DCX 的嵌套 BND4 识别证据。
- 四类语义资源在 Sekiro 私有发布语料上的完整 CRUD、类型转换和三层回滚；EMEVD instruction 当前只完成 raw args 的零参数新增与既有指令复制/删除/重排，不具备 EMEDF 类型校验，当前只有上列子能力具备 resource-entry 证据，完整发布 corpus 的三层闭环仍未完成。
- 原生 paramdef、完整 MSB 实体语义、FLVER 几何/材质/纹理 writer。
- 专业 Hex、完整 EMEVD 四视图、PARAM、FMG、MSB 3D 产品体验；当前 UI 含演示或代理数据路径。
- 真实双模型服务正向 smoke、流式/取消、人机授权与历史管理 UI；桌面生产接线、持久 grant、Context Broker、AI retention 和出站审计后端已接。
- Playwright Electron E2E、完整性能门槛、实际打包、代码签名、更新器和真实 Sekiro 启动门禁。

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
npm run test:progress-integrity
npm run bridge:verify:synthetic
npm run build
npm run dev
~~~

本机真实 Mod 验证：

~~~powershell
$env:SOULFORGE_NATIVE_FIXTURE_ROOT = 'D:\path\to\private-fixtures'
$env:SOULFORGE_NATIVE_FIXTURE_REGISTRY = 'D:\path\to\native-fixture-registry.json'
npm run test:native-preview
$env:SOULFORGE_REAL_MOD_ROOT = 'D:\path\to\mod-workspace'
npm run test:real-mod -w @soulforge/core
~~~

所有 native corpus/primary runner 都必须先设置私有语料目录和仓库外 registry；显式文件路径也只有在 registry 中完成 SHA-256 绑定后才接受，不再静默使用仓库 `mods`。真实 Oodle/KRAK 总门禁还要求合法游戏目录。registry 必须符合 `schemas/native-fixture-registry.schema.json`；KRAK 成功路径只使用带 `dcx-document` 断言的已登记 fixture，不扫描目录挑选文件。严格总门禁缺少任一环境变量都会以退出码 2 失败，而不是把失败关闭测试当作成功路径：

~~~powershell
$env:SOULFORGE_SEKIRO_GAME_ROOT = 'D:\path\to\Sekiro'
$env:SOULFORGE_NATIVE_FIXTURE_ROOT = 'D:\path\to\private-fixtures'
$env:SOULFORGE_NATIVE_FIXTURE_REGISTRY = 'D:\path\to\native-fixture-registry.json'
npm run test:native-fixture-registry
npm run bridge:verify:oodle:real
npm run test:private-native-gate
~~~

严格私有门禁还要求 registry 提供 BND4/FMG/PARAM/EMEVD/MSB 五个 primary role，以及 DFLT/KRAK 两类 `dcx-document` fixture。测试输出只保留 fixture id、hash、variant、断言和诊断，不输出本地资产路径或内容。公开 CI 只能在三项私有环境变量全部未设置时，通过 `test:private-native-gate:allow-skip` 留下明确的 `skipped` 记录；部分配置仍失败，该命令也不是 release pass。

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
