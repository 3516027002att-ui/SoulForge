# SoulForge

SoulForge 是给魂游（FromSoftware 的《只狼》《黑暗之魂》《艾尔登法环》等）modder 用的工作台。

演示视频链接： https://b23.tv/S7rYdkn

像写代码时用 Cursor 一样，你用自然语言告诉它想怎么改游戏，它在独立的工作区里帮你改好、验证、提交，还能随时一键回滚

> 当前状态：正在进行 V1 功能收尾，尚未宣称 V1 验收或发布完成。工作区文件发现、原生解析、界面预览与安全写入是不同层级；未知格式可显示为候选或诊断，不等于已经解析。具体能力以当前源码、原生读取结果、治理登记和对应验证为准。未签名产物不应当作稳定发行版。

## 当前可用能力

下表列出当前源码已接入的工作台与操作入口，不是各格式、布局或全部游戏语料的验收通过清单。编辑和保存仍受原生读取、字段校验、工作区权限与 Patch Engine 约束：

| 编辑器 | 通俗说法 | 你能拿它做什么 |
| --- | --- | --- |
| FMG | 改文本 / 做汉化 | 改菜单、物品名、对话、说明文字 |
| PARAM（gameparam） | 调数值 / 平衡 | 改攻击、防御、掉落等数值配置 |
| EMEVD | 改事件 / 剧情 | 改事件脚本：剧情流程、Boss 战阶段、机关触发 |
| BND4 | 打包 / 解包资源 | 增删改游戏资源包里的条目 |
| script | 改 AI / 行为（有限） | 查看 AI 与出招脚本；明文条目可改源码，字节码条目只能整文件替换 |
| MSB / MAP | 地图与场景 | 查看实体、模型与空间关系，渐进加载场景；已接入受控场景修改和取消链路，加载完成不等于响应性验收通过 |
| ACTION / TAE | 动作预览与事件时间轴 | 按动作容器定位动画、预览角色与骨骼；编辑已支持的事件时间和模板事件，不等于任意 HKX 动画重编码 |
| ESD | 对话 / 行为状态机 | 查看状态、条件和转移；受控修改转移目标，不等于任意表达式或指令体可编辑 |
| FLVER | 3D 模型 | 模型与骨骼预览，提供已支持的模型字段编辑；不是通用建模软件 |
| TPF | 贴图库 | 浏览贴图，以工作区中的 DDS 替换符合格式、尺寸等校验条件的条目 |
| MTD / GPARAM / FXR | 材质、画面参数与特效 | 各有格式化读取与受控字段写入入口；未知字段、布局和未实现操作保留诊断或失败关闭 |

几点说明：

- PARAM 的具体表族、字段和写入状态以当前能力登记、原生读取结果及面板诊断为准。
- 文件出现在资源树、搜索结果或编辑器中，不代表已原生解析或可安全写入；具体状态以面板诊断为准。
- Agent 已接入工作区索引、RAG 检索、原生读取、受控修改、结果重读与回滚；一次模拟通过不代表任意自然语言任务都能完成。中断、超时、partial 和缺失终态必须保留。
- MAP 的功能加载、测量完整性、前台响应性与原生取消分别判定；`test:map-streaming-native` 的退出码 0 仅表示功能加载成功，仍需查看报告的 `status`。碰撞、导航及其他未验证路径不能外推为已完成。

## 卓越的安全

- **写入当前打开的工作区**：你打开哪个 Mod 文件夹，修改就写进哪里。工作区可以在游戏安装目录里（例如 `Sekiro\\mods`）。
- **三层回滚**：AI的每次修改都经过「暂存 → 验证 → 备份 → 原子替换 → 重读确认」，改坏了可以按操作 / 文件 / 资源条目逐层回滚。
- **没有旁门左道**：AI、渲染、格式转换等任何路径都不能绕过这条安全写入主干。

## 开发文档

先读[实施交接书 §0](docs/V0_5_IMPLEMENTATION_HANDOFF.md)，再运行 `node scripts/gov.mjs next`、`help` 和 `status`。交接书文件名及开头的历史基线不代表当前发布版本；机器可读治理数据是范围、状态与封存证据的权威。

| 想找什么 | 当前入口 |
| --- | --- |
| 范围、切片、Gate 与证据 | [治理说明](docs/governance/README.md)、[切片与实现入口](docs/governance/slices.json)、[验证登记](docs/governance/validation.json) |
| 开发方法与安全边界 | [执行手册](docs/AGENT_EXECUTION_PLAYBOOK.md)（仓库公开说明与当前工作区治理数据共同约束实施边界） |
| 文件识别与编辑器分派 | [工作区编辑器目录](packages/core/src/workspace/editorCatalog.ts)、[编辑器选择](apps/desktop/src/renderer/src/workbench/selectEditor.ts) |
| 原生格式读写与 Bridge 协议 | [Bridge 说明](bridge/SoulForge.Bridge/README.md)、[原生命令分派](bridge/SoulForge.Bridge/BridgeCommandService.cs) |
| Agent 工具与真实链路模拟 | [工具登记](packages/core/src/ai/toolRegistry.ts)、[模拟入口](scripts/run-real-agent-gyoubu.mjs) |
| 验证命令与分层调度 | [package.json](package.json)、[验证调度表](scripts/verify/tiers.mjs) |
| 产品愿景与专题规格 | [长期愿景](docs/PRODUCT_VISION.md)、[格式研究](docs/PARSER_RESEARCH.md)、[EMEVD 编译链](docs/EMEVD_DSL_COMPILER_SLICE_AB.md) |
| 已归档的会话示例 | [会话归档索引](docs/ai-logs/README.md)（不是本机全部会话或成功率统计） |

本地验证产物位于 `output/validation/`、`output/playwright/`、`output/agent-real/`，不保证随源码分发。核对时检查报告的源码/产物身份、实际退出码、具体断言和未验证项；旧 PASS 不自动覆盖后续改动，`GATE_EVIDENCE_STALE` 也不能用文档改成通过。

### 按改动选择验证

优先使用统一入口组合本次所需验证；层级是选择工具，不表示每次修改都需要全跑。先用 `--list` 查看具体操作和环境需求：

```powershell
node scripts/verify.mjs --tier governance --list
node scripts/verify.mjs --suite typecheck,test:agent-tool-envelope
node scripts/verify.mjs --slice W-REL-V09-PUBLIC-PREVIEW-01 --list
```

`--suite` 保留给定顺序；`--slice` 只执行结构化 `requiredValidation` 的自动步骤，人工检查单独显示为 `manual-pending`，历史自由文本不能自动执行。单项调试仍可直接用 `npm run <名称>`。

同一计划按工作目录、命令参数和显式环境复用已通过的操作，共享重复的 TypeScript 编译；JSON 报告的 `steps.execution` 区分执行与复用。构建、npm 生命周期和无法安全展开的 shell 命令会清除复用结果。复用不跨运行保存，也不用于把 skip/partial 改成 passed。需要全部实际通过时用 `--require-executed`；混合层级可用 `--require-tier governance,unit` 或 `--require-suite test:renderer-e2e` 指定严格范围。

Windows CI 对文档和治理数据变更只跑治理检查；代码变更共用一次公开验证计划，renderer e2e 只执行一次。打包输入变化或手动选择安装验收时，独立运行 NSIS、内容完整性和安装生命周期。真实游戏语料、签名和跨机验收仍按各自前置执行。Agent 模拟和数据库 smoke 在源文件与产物 SHA-256 都匹配时复用生产构建；缺少所需 smoke 入口或指纹变化时重建。

## 快速开始

### 方式一：使用已构建的启动器

如果你拿到的目录已经包含完整构建产物（仅下载源码 ZIP 不保证包含）：

1. **直接双击根目录下的 `SoulForge.Launcher.exe`**；
2. 启动器会自动扫描并检测：
   - 🎮 **《只狼》安装路径**（自动扫描 Steam 库、注册表与常见盘符）
   - 🧩 **Oodle 解压运行库 (`oo2core_6_win64.dll`)**（检查本机合法游戏目录中的运行库与兼容性，不随源码提供）
   - ⚙️ **Mod 工作区**（自动初始化标准 `mods/` 文件夹与 `project.json`）
   - 💻 **系统运行库**（VC++ 2015-2022 x64）
3. 体检通过后启动编辑器；缺少游戏、运行库、依赖或应用产物时，按启动器诊断处理，不保证所有环境都能自动修复。

> 提示：如果你只想进行环境体检，可在终端中执行 `.\SoulForge.Launcher.exe --check`。

---

### 方式二：从源码编译（开发者模式）

> 本节假设你**没用过 PowerShell、Node.js、.NET**。跟着一步步点鼠标就行，不懂原理也能跑起来。

#### 第 0 步：确认你的电脑

- 系统：Windows 10 或 Windows 11（其他系统暂不支持）。
- 磁盘：至少预留 5 GB 空闲（用来放依赖和编译产物）。
- 网络：能正常访问互联网（安装过程要下载东西）。

#### 第 1 步：打开 PowerShell

PowerShell 就是 Windows 自带的“黑窗口”，用来敲命令，不用怕：

1. 按键盘 `Win + S` 搜索 `PowerShell`，打开 **Windows PowerShell** 或 **Terminal（终端）**。
2. 如果看到蓝底或黑底、能打字的窗口，就对了。后续所有命令都在这里粘贴、按回车执行。

> 小技巧：粘贴时用 `Ctrl + V`，复制时用 `Ctrl + C`；卡住了按 `Ctrl + C` 可中断。

#### 第 2 步：安装 Node.js（含 npm）

Node.js 是运行本项目前端/构建脚本的环境，`npm` 是它自带的包管理器。

1. 打开 https://nodejs.org/zh-cn → 下载 **LTS（长期支持版）**，一路“下一步”安装（保持默认勾选即可）。
2. 装完**重新打开**一个 PowerShell 窗口，粘贴以下命令验证：

~~~powershell
node -v
npm -v
~~~

能看到类似 `v22.x.x` 和 `10.x.x` 的版本号即成功。若提示“不是内部命令”，说明没装好或没重启终端，重装一次并重启电脑再试。

#### 第 3 步：安装 .NET SDK

.NET SDK 是编译桌面端底层 Native Bridge 与启动器必需的工具。

1. Bridge 当前目标为 **`net10.0`，需要 .NET 10 SDK**；只有 .NET 6 或 8 SDK 不足以构建 Bridge。可从 https://dotnet.microsoft.com/download/dotnet 安装，或在下载源码后运行 `./scripts/install-dotnet-sdk.ps1` 安装到用户本地目录。
2. 装完同样**重新打开** PowerShell，验证：

~~~powershell
dotnet --version
~~~

> 注意：.NET Runtime（运行时）和 SDK 是两回事，必须装 **SDK**，否则 `dotnet build` 会失败。
> Doctor/Launcher 当前目标为 `net6.0`；`launcher:build` 使用 PATH 中的 `dotnet`。Bridge 脚本还会依次检查 `SOULFORGE_DOTNET`、`%LOCALAPPDATA%\SoulForge\dotnet\dotnet.exe`，见 [SDK 选择脚本](scripts/run-dotnet.mjs)。本地 SDK 安装不等于已经配置全局 PATH。

#### 第 4 步：下载 SoulForge 源码

二选一（推荐前者）：

**方式 A - 用 Git（会用 Git 的人）：**
~~~powershell
git clone https://github.com/3516027002att-ui/SoulForge.git
cd SoulForge
~~~

**方式 B - 直接下载 ZIP（不会 Git 也行）：**
1. 打开本仓库首页 → 绿色按钮 `Code` → `Download ZIP`。
2. 解压到任意**不含中文和空格**的路径，例如 `D:\SoulForge`。
3. 在该文件夹空白处右键 → `在终端中打开`。

#### 第 5 步：安装依赖并编译

在 SoulForge 根目录（能看到 `package.json` 的那层）依次执行，每行粘贴后按回车，等上一条跑完再跑下一条：

~~~powershell
# 1. 安装依赖（第一次会比较慢，耐心等到出现 done / completed）
npm install

# 2. 检查类型（确保代码没写错，没报错即通过）
npm run typecheck

# 3. 跑公开测试与 Bridge 合成验证（不能以此宣称真实游戏语料验收）
npm test
npm run bridge:verify:synthetic

# 4. 编译出桌面应用
npm run build

# 5. 更新 Bridge、Doctor、Launcher 和根目录 SoulForge.exe 四个可执行产物
npm run exe:build
~~~

> 常见报错：
> - `npm : 无法加载文件 ... 因为在此系统上禁止运行脚本` → 将命令中的 `npm` 换为 `npm.cmd` 后重试，无需为运行 npm 修改系统策略。
> - 网络超时/ `ECONNRESET` → 多试几次 `npm install`，或切换网络/开代理。
> - `dotnet: command not found` → 没装好 .NET SDK，回到第 3 步。

#### 第 6 步：运行

编译成功后：

- **双击根目录的 `SoulForge.Launcher.exe`，根据环境体检结果启动或处理诊断。**
- 或想边看前端控制台日志边跑（开发者常用）：

~~~powershell
npm run dev
~~~

未签名产物可能触发 Windows 安全提示；先核对来源与构建产物，不要把所有拦截都当作误报，也不要为此关闭防护。

### 还跑不起来？

1. 把 PowerShell 里的**完整报错信息**复制下来。
2. 发邮件到 `3516027002att@gmail.com`（见文末），附上你的系统版本与三条验证命令的输出（`node -v` / `npm -v` / `dotnet --version`）。

## 支持范围

- 目标：《只狼》1.6.x 版本族。
- 未登记的版本或其他游戏一律 fail-closed。
- 等我以后有钱买了别的游戏或许就会支持吧


## 许可证

SoulForge 按 [Apache License 2.0](LICENSE) 授权，归属与第三方声明见 [NOTICE](NOTICE)。

## 想说的话

我用我的skill做了一版符合我口味的，我觉得超好看的ui，但是感觉和项目名称不太搭，有没有大手子帮我做一版沾边的

I made a version of the UI with my skill that suits my taste — I think it looks great, but it doesn't quite match the project name. Is there an expert out there who can help me make a version that actually fits the theme?

如果你发现了bug或是有其他想说的话，请不要在项目下面评论，因为我目前很少逛GitHub，你写的啥我看不到，也不会有通知。
可以直接发邮件给我： 3516027002att@gmail.com 虽然仓库里有很多机器群发的垃圾邮件，但只要有真人给我发邮件，我就会收到。
不过说实话，这个邮箱平时除了其他仓库的维护者的评论，基本不会有真人给我发邮件，哪怕我已经开始到处投简历了。
因此只要我限制你只能给我发邮件，我就永远不会收到任何反馈邮件。
这样我的项目就理所应当没有任何bug了233333

If you find a bug or have something else to say, please don't leave a comment under the project — I rarely browse GitHub these days, so I won't see what you wrote and won't get any notification.
You can email me directly at: 3516027002att@gmail.com. Even though the repo gets a lot of machine-generated spam, as long as a real person emails me, I'll receive it.
To be honest, apart from comments from other repos' maintainers, this inbox rarely gets a real human email — even though I've already started sending out résumés everywhere.
So, as long as I restrict you to only emailing me, I'll never receive any feedback.
That way, my project naturally has zero bugs looooooolllll


我决定提供我的测试题和agent的测试脚本，调用会话记录，以供大家参考（如果你有这个能力的话2333）
魂游mod的编辑不像普通的RAG知识问答库那般有容错，为了保证模型在模糊需求下也能做到准确的查找并可靠的修改，我需要更多真实生产环境下的真实任务来尽量全面的测试agent的能力。
我在项目中设置了一个一键发送会话记录的按钮，点击这个按钮就能贡献你宝贵的会话记录以供我分析并改进SoulForge。
我计划创建LLM Wiki功能，使得部署在各个电脑并执行各个任务的agent能够记录其宝贵的真实开发经验，可以通过点击按钮汇总到这里，同时我将提供一个查询接口，使得别人也能够调用这个知识库。
这并不是空穴来风，事实上，你可以很清楚的从源码中发现这个功能已经初具雏形，不过我需要继续完善测试才能上线。
为了更好的优化项目，我将为积极的用户提供充足的额度，如果你愿意积极向我分享你的经验，请点击一下star之后联系我，联系方式你懂的。

I have decided to share my test prompts, Agent test scripts, and session logs for everyone to use as references (assuming you have the ability to make sense of them, lol).
Editing Souls game mods is far less forgiving than querying an ordinary RAG knowledge base. To ensure that the model can still find the right data and make reliable changes from vague requests, I need many more real tasks from actual production environments to test the Agent's capabilities as thoroughly as possible.
I have added a one-click session-log submission button to the project. By clicking it, you can contribute your valuable session logs for me to analyze and use to improve SoulForge.
I also plan to build an LLM Wiki, where Agents deployed across different computers and working on different tasks can preserve the valuable experience they gain from real-world work. That experience could then be collected here with the click of a button, and I would provide a query interface so others could use this knowledge base as well.
This is not just wishful thinking. In fact, you can already see from the source code that the feature is beginning to take shape, though I still need to improve and test it further before it can go live.
To help improve the project, I will provide generous usage credits to active users. If you are willing to share your experience with me, please star the repository and then get in touch — you know how to reach me.

会话记录：[已归档会话](docs/ai-logs/README.md)（静态归档，不是本机现存会话总数）。只刷新已有归档索引可运行 `npm run ai-logs:sync -- --index-only`；完整同步会复制本机对话与工具返回，提交或分享前必须审查敏感内容。

- [鬼型部修改 Markdown](docs/ai-logs/markdown/2026/08/23/rollout-2026-08-23T12-40-06-359Z-fdc9e1e0-62ee-4ac8-9168-e5966252fdde.md) · [原始 JSONL](docs/ai-logs/sessions/2026/08/23/rollout-2026-08-23T12-40-06-359Z-fdc9e1e0-62ee-4ac8-9168-e5966252fdde.jsonl)
- [道具/商店崩溃只读排查 Markdown](docs/ai-logs/markdown/2026/08/21/rollout-2026-08-21T02-37-13-611Z-27acb304-a895-4fe7-8701-07a2552340d7.md) · [原始 JSONL](docs/ai-logs/sessions/2026/08/21/rollout-2026-08-21T02-37-13-611Z-27acb304-a895-4fe7-8701-07a2552340d7.jsonl)

