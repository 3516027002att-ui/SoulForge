# SoulForge Agent 强制规则

本文件对所有在本仓库工作的 AI Agent 和工程师生效。一切回答使用中文。

## 唯一实施规范

当前长期里程碑是 **SoulForge V0.5**。

唯一完整实施规范与当前技术地图：

- `docs/V0_5_IMPLEMENTATION_HANDOFF.md`

`docs/PRODUCT_VISION.md` 只描述长期产品愿景。synthetic fixture 文档只定义构造样本，不构成 native 完成声明。

不要创建新的 milestone、fork、next-actions、project-state、task、status 或 development-log 文档。稳定格式规格可以单独建立，但必须由交接书引用，且不能另立产品范围和进度口径。

## 工作方式

交接书是一张依赖驱动的技术线路图，不是强制工单。

接手者应当：

1. 检查 `git status`、`HEAD`、本机环境和相关测试。
2. 阅读交接书的全局线路图、当前技术前沿和相关区域地图。
3. 根据依赖、真实证据、风险与可用环境自主选择推进路径。
4. 不跳过对应写能力真正依赖的 parser、writer、validator、恢复和 authority 门槛。
5. 完成后更新交接书中的路线状态、当前前沿和实施证据记录。
6. 不编造未运行、未读取或未验证的结果。

不再使用旧的 P0 → P7 固定阶段顺序。阶段名可以用于历史追溯，但不能覆盖当前线路图。

## 最高优先级

1. 正确性、可验证性和无损性。
2. 安全、凭据和用户资产合规。
3. Patch Engine 与恢复边界。
4. 架构长期可替换，不新增隐性技术债。
5. 开发速度和改动体量。

项目不急于上线。不能为了赶版本降低 native authority、验证、回滚、真实场景性能或生态集成标准。

## 硬约束

1. renderer 不得直接访问文件系统，也不得获得真实绝对路径。
2. 原版游戏目录永远只读。
3. 不得在 Mod 工作区写入数据库、缓存、日志、恢复元数据或其他旁路文件。
4. 所有 Mod 资源写入必须经过 Patch Engine；writer 和 converter 只能写暂存区。
5. 禁止在 Patch Engine 外直接使用 `fs.writeFile` 修改 Mod 资源。
6. 未有真实 parser 时不得声称格式已解析。
7. `unsupported`、`candidate`、`fixture-confirmed`、`partial`、`native-verified`、`blocked`、`unverified` 必须严格区分。
8. unsupported、failed、partial 和 blocked 必须返回结构化诊断，不能吞异常。
9. 所有资源输出必须包含 `sourceUri`、`sourcePath`、`game`、`resourceKind` 和 `diagnostics`。
10. AI 没有充分证据时必须返回 `insufficient_evidence`。
11. 完全权限不能绕过证据、Patch Engine、验证、备份、审计和回滚。
12. 外部 FromSoftware 工具可用于行为、格式家族和工作流对照；不得复制不兼容许可证源码。
13. 引入第三方库前必须裁定许可证、维护状态和分发影响。
14. 不提交真实游戏资产、用户 Mod、私有测试语料、Oodle DLL、API key 或签名私钥。
15. synthetic 数据必须微小、合法构造且明确标记。
16. 长任务必须异步、可报告进度、可取消并有超时。
17. 大文件、大表格和 3D 场景必须懒加载、分页、虚拟化、分块或流式传输。
18. `THREE.Object3D`、其他 renderer object 和 React 状态不能成为权威场景文档。
19. SoulForge 不自行实现 Mod loader 取代 me3；运行能力通过可替换 `GameRuntimeAdapter` 集成。

## 架构边界

- C# Bridge 是 FromSoftware 原生二进制格式的 production authority。
- TypeScript 负责工作区、索引、资源图、PatchIR、事务、AI、场景投影和 UI 编排。
- TypeScript 不维护第二套 production native parser。
- 索引投影、语义投影、渲染投影和无损可写文档必须分离。
- 未知字段无法无损保留时，不得开放 writer。
- EMEVD DSL 最终通过 AST、EMEDF typecheck、typed mutation、native document 和 PatchIR 写入，不能直接覆盖二进制。
- 场景通过 renderer-independent semantic scene 和 render projection 驱动；Three.js WebGPU 是首选实现，WebGL2 是兼容 fallback，未来可按真实基准增加 native backend。
- Param 重点是 Paramdex-compatible metadata authority、严格匹配和安全字段写入，不把原生 `.paramdef` 二进制解析当作唯一正确路线。

## 辅助 Agent 与代码生成

主 Agent 负责复杂推理、架构、安全、native authority、数据库迁移、Patch Engine、回滚、恢复和复杂 bug。

简单、机械、低风险、边界清晰的代码任务可以交给 Codex，例如：

- 重复 DTO 和测试样板；
- 机械重命名；
- 已确定 schema 的序列化代码；
- 小范围脚本和显然的胶水代码。

前端视觉、交互和布局保留给专门的前端 Agent；主 Agent 负责定义数据契约、安全边界和验收，不代替前端 Agent 决定视觉方案。

任何辅助输出都必须由主 Agent 审查、集成并运行真实验证。

## 验证

最低公开回归：

~~~powershell
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
~~~

涉及本机真实资源时，根据根 `package.json` 运行对应 native smoke。`skipped`、`candidate`、fixture 通过和失败关闭测试都不能被写成完整 native authority。

## CodexPro

CodexPro 仅是开发期本地桥，不属于 SoulForge 产品运行时：

~~~powershell
cd D:\Repository\SoulForge
npm run codexpro:start
~~~

只规划不编辑时：

~~~powershell
npm run codexpro:start:handoff
~~~

运行时 URL 和 token 是临时凭据，不得提交。详细方式见 `docs/CODEXPRO_QUICKSTART.md`。