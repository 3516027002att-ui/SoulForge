# SoulForge Agent 强制规则

本文件对所有在本仓库工作的 AI Agent 和工程师生效。一切回答使用中文。

## 唯一实施规范

当前产品里程碑是 **SoulForge V0.5**。

唯一完整实施规范：

- `docs/V0_5_IMPLEMENTATION_HANDOFF.md`

开始工作前必须完整阅读该文档。不要再创建新的愿景、分叉、里程碑、任务或状态文档；范围、接口、阶段、测试与完成定义均在交接书中维护。

`docs/PRODUCT_VISION.md` 仅描述长期产品愿景，不是版本验收标准。synthetic fixture 文档仅定义测试格式，不是 native 完成声明。

## 最高优先级

1. 不新增技术债。
2. 正确性与可验证性。
3. 安全、凭据和用户资产合规。
4. 与既定架构和写入边界一致。
5. 交付速度与改动体量。

## 当前 V0.5 范围

- 正式平台：Windows 10/11 x64。
- 权威游戏基线：Sekiro。
- 原生容器：DFLT、KRAK、BND4。
- 核心语义资源：EMEVD、MSB、PARAM、FMG。
- 专业桌面：安全 Hex、EMEVD 四视图、PARAM/参数结构定义、FMG 本地化、MSB 完整 3D 场景。
- 资产导入：glTF/GLB、PNG、TGA、DDS，并安全转换为 Sekiro 原生资产。
- AI：OpenAI-compatible 与 Anthropic-compatible 两类真实模型服务。
- 所有写入：PatchIR → 暂存区 → 验证 → 备份 → 原子替换 → 重读 → 索引 → 审计 → 回滚。

完整 3D 场景和资产替换已经明确纳入 V0.5；不要引用旧的“不做 3D”约束。内置 mesh 建模、贴图绘制、材质创作和动画制作仍不在 V0.5。

## 硬约束

1. renderer 不得直接访问文件系统，也不得获得真实绝对路径。
2. 原版游戏目录永远只读。
3. 不得在 Mod 工作区写入 SoulForge 数据库、缓存、日志、恢复元数据或其他旁路文件。
4. 所有 Mod 资源写入必须经过 Patch Engine；writer 和 converter 只能写暂存区。
5. 禁止在 Patch Engine 外直接使用 `fs.writeFile` 修改 Mod 资源。
6. 未有真实 parser 时不得声称格式已解析。
7. unsupported、candidate、fixture-confirmed、native-verified 必须严格区分。
8. unsupported/failed/partial 必须返回结构化诊断，不能吞异常。
9. 所有资源输出必须包含 `sourceUri`、`sourcePath`、`game`、`resourceKind` 和 `diagnostics`。
10. AI 没有充分证据时必须返回 `insufficient_evidence`。
11. 完全权限不能绕过证据、Patch Engine、验证、备份、审计和回滚。
12. 外部 FromSoftware Mod 工具只能用于行为对照，不复制源码，不作为核心 parser/writer 运行依赖。
13. 不提交真实游戏资产、用户 Mod、私有测试语料、Oodle DLL、API key 或签名私钥。
14. synthetic 测试数据必须微小、合法构造且明确标记。
15. 长任务必须异步、可报告进度、可取消并有超时。
16. 大文件、大表格和 3D 场景必须懒加载、分页、虚拟化或分块。

## 实施顺序

严格按交接书 P0 → P7 推进。优先解决高风险根因：

1. 文档口径和 Electron/路径/权限/恢复安全。
2. SQLite 权威存储、工作区会话和 Bridge daemon。
3. DFLT/KRAK/BND4 原生容器。
4. FMG、PARAM、EMEVD、MSB 无损语义闭环。
5. 3D 与资产转换。
6. 专业桌面。
7. 双模型服务 Agent。
8. 发行和真实游戏门禁。

一个阶段的 required tests、真实验证或恢复路径未通过时，不得标记完成或跳到依赖它的写能力。

## 编码与接口

- 内部代码标识保持英文。
- 面向用户的非 Mod 圈术语必须汉化；`Profile` 显示为“游戏适配包”，`Provider` 显示为“模型服务”。
- 优先小而明确的模块、typed schema 和结构化诊断。
- 索引投影与无损可写文档必须分离。
- C# Bridge 是 FromSoftware 原生二进制格式的唯一 production authority。
- TypeScript 负责工作区、索引、资源关系、PatchIR、事务、AI 和 UI 编排，不维护第二套 native parser。
- 非必要不引入依赖；交接书已经裁定的依赖按其用途使用，并完成许可证/维护审查。

## 辅助代码生成

本项目只允许把 Grok 作为快速代码助手；不要调用 Claude Code。Grok 也只限简单、机械、低风险、边界清晰的子任务，例如：

- 重复 DTO/测试样板；
- 机械重命名；
- 明确 schema 的序列化代码；
- 无安全决策的 UI 样板。

以下任务不得交给辅助模型决策：

- 架构设计；
- 安全敏感代码；
- 复杂 bug 定位；
- 大规模跨文件重构；
- 数据库迁移；
- native parser/writer；
- Patch Engine、回滚和恢复；
- 影响核心业务正确性的逻辑。

辅助模型输出必须由主 Agent 审查、集成并运行真实验证。

## 文档纪律

- `docs/V0_5_IMPLEMENTATION_HANDOFF.md` 是唯一可执行规划和进度来源。
- 不新建平行的 milestone、fork、next-actions、project-state 或 task 文档。
- 新的稳定格式规格可以单独建技术文档，但必须由交接书引用，并且不能改变产品范围。
- 每个阶段的已完成/已验证/未验证/非声明直接更新交接书的“实施进度记录”。
- 不编造未运行、未读取、未验证的结果。
- 进度检查表中的 `[x]` 只允许表示该条目按交接书定义完整通过；只要仍含 `partial`、`candidate`、`fixture-confirmed`、`blocked`、`skipped`、`unverified`、`unsupported`、未完或未验证内容，就必须保持 `[ ]`。
- 测试命令退出码为 0 不自动等于发布条件通过；必须同时检查结构化结果中的 `status`、`authority`、`skipped`、`failed` 和 corpus 覆盖数。
- 声明某项能力可用的门禁必须包含该能力的真实正向成功路径；失败关闭、缺失诊断和 synthetic 测试只能证明边界，不能替代正向证据。
- 严格私有语料门禁必须同时设置 `SOULFORGE_NATIVE_FIXTURE_ROOT`、`SOULFORGE_NATIVE_FIXTURE_REGISTRY` 和 `SOULFORGE_SEKIRO_GAME_ROOT`；所有 native runner 必须从 registry 的 hash 绑定条目解析输入，不得扫描目录挑选文件或静默使用仓库固定 `mods/...` 路径。只有三项均未设置时，公开 CI 才可显式 `--allow-skip`。
- README、Bridge README、模块地图和“当前执行位置”不得长期保留与当前代码相反的能力描述；每次更新实施进度时必须运行 `npm run test:progress-integrity`。
- 公开 CI 可以显式使用 `--allow-skip` 记录私有环境缺失，但 release gate 默认必须在 `skipped` 或 `partial` 时失败。

## 验证

最低回归：

~~~powershell
npm run typecheck
npm test
npm run test:progress-integrity
npm run bridge:verify:synthetic
npm run build
~~~

涉及本机真实 Mod：

~~~powershell
npm run test:native-preview
npm run test:real-mod -w @soulforge/core
~~~

真实 Mod smoke 通过只证明对应断言，不代表全部 native semantic writer 完成。

## CodexPro

CodexPro 仅是开发期本地桥，不属于 SoulForge 产品运行时：

~~~powershell
cd D:\Repository\SoulForge
npm run codexpro:start
~~~

运行时 URL 和 token 是临时凭据，不得提交。只规划不编辑时使用：

~~~powershell
npm run codexpro:start:handoff
~~~

详细启动方式见 `docs/CODEXPRO_QUICKSTART.md`。
