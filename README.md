# SoulForge

SoulForge 是给魂游（FromSoftware 的《只狼》《黑暗之魂》《艾尔登法环》等）modder 用的工作台。

演示视频链接： https://b23.tv/S7rYdkn

像写代码时用 Cursor 一样，你用自然语言告诉它想怎么改游戏，它在独立的工作区里帮你改好、验证、提交，还能随时一键回滚

> 当前状态：工作区内所有文件均可读取、索引和诊断；文件能否编辑、写入方式和安全等级以当前治理登记、原生 authority、验证结果和工作区诊断为准。安装包未做代码签名，暂不适合作为稳定工具分发。

## 当前可用能力

项目支持对工作区内所有文件进行读取、索引和诊断，编辑器按格式对应的原生写入能力开放：

| 编辑器 | 通俗说法 | 你能拿它做什么 |
| --- | --- | --- |
| FMG | 改文本 / 做汉化 | 改菜单、物品名、对话、说明文字 |
| PARAM（gameparam） | 调数值 / 平衡 | 改攻击、防御、掉落等数值配置 |
| EMEVD | 改事件 / 剧情 | 改事件脚本：剧情流程、Boss 战阶段、机关触发 |
| BND4 | 打包 / 解包资源 | 增删改游戏资源包里的条目 |
| script | 改 AI / 行为（有限） | 查看 AI 与出招脚本；明文条目可改源码，字节码条目只能整文件替换 |

几点说明：

- PARAM 的具体表族、字段和写入状态以当前能力登记、原生读取结果及面板诊断为准。
- 工作区内所有文件均可读取；尚未具备原生写入能力的格式仍以只读、诊断或受限编辑方式呈现。
- 地图/场景（MSB）、动画/动作事件（TAE）、状态机（ESD）、3D 模型（FLVER）、贴图（TPF）、材质（MTD）、碰撞和导航按各自的原生读写能力独立推进；未验证的路径必须显示为只读、partial 或失败关闭。

## 卓越的安全

- **写入当前打开的工作区**：你打开哪个 Mod 文件夹，修改就写进哪里。工作区可以在游戏安装目录里（例如 `Sekiro\\mods`）。
- **三层回滚**：AI的每次修改都经过「暂存 → 验证 → 备份 → 原子替换 → 重读确认」，改坏了可以按操作 / 文件 / 资源条目逐层回滚。
- **没有旁门左道**：AI、渲染、格式转换等任何路径都不能绕过这条安全写入主干。

## 开发文档

开发与架构设计规范请参阅[实施交接书](docs/V0_5_IMPLEMENTATION_HANDOFF.md)。文档内容以当前治理登记与验证结果为准。

## 快速开始

### 方式一：V0.9 完整 Release 源码包（推荐）

请优先下载 GitHub Release 中的
[`SoulForge-v0.9.0-win-x64-source.zip`](https://github.com/3516027002att-ui/SoulForge/releases/download/v0.9.0/SoulForge-v0.9.0-win-x64-source.zip)。完整包已
附带当前编译后的 Electron `out`、workspace `dist`、SQLite native binding、
自包含 Bridge 和根目录 `SoulForge.exe`；它不是安装包，也不包含游戏文件、mods
或私有语料。

首次运行（Windows x64）：

1. 安装 Node.js 24，并确认 npm 11 可用；
2. 在解压后的根目录打开 PowerShell，执行：

   ```powershell
   npm ci
   node node_modules/electron/install.js
   ```

3. 双击根目录的 `SoulForge.exe`。完整包首次启动不需要 .NET SDK。

GitHub 自动生成的 Source code ZIP/tar.gz 与上述完整包不同：自动归档只含源码、
配置、许可证、构建脚本和根启动器，不含预编译 `out`、`dist`、SQLite native
binding 或自包含 Bridge。使用自动归档需 Node.js 24、npm 11 及 `global.json`
所要求的 .NET 10 SDK；先执行 `npm ci` 和
`node node_modules/electron/install.js`，再运行 `npm run build` 与
`npm run exe:build`。SQLite 原生绑定重建可能还需要 Windows C++ 构建工具。

本预发行范围已完成脱离原始仓库的首启与 Bridge 隔离验证，包括不读取根仓库
test 配置或预置模型，以及 preload、IPC、Bridge、隔离和 staging 路径检查；这
只说明该发布快照的启动边界可用，不代表 V1 已全部完成。

已知限制：仅支持 Windows x64；后台分析退出协调仍有已知问题；大型 MAP 前台、
跨机器与真实游戏完整验收尚未完成，不作完整通过声明。主动点击反馈会上传脱敏
会话，发送前请确认会话中没有敏感内容。生产依赖扫描仍报告 2 项高危节点
（`@huggingface/transformers` → `sharp` 依赖链，对应
GHSA-f88m-g3jw-g9cj 与 GHSA-rgj7-g3m4-5g8c）；本预发行版尚未修复，请避免
处理不可信输入。

> 提示：完整 Release 包默认按上面的四步启动；需要诊断时请保留终端中的完整报错与命令输出。

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

1. 打开 https://nodejs.org/zh-cn → 安装 **Node.js 24**，并确认 npm 11 可用，一路“下一步”安装（保持默认勾选即可）。
2. 装完**重新打开**一个 PowerShell 窗口，粘贴以下命令验证：

~~~powershell
node -v
npm -v
~~~

能看到类似 `v24.x.x` 和 `11.x.x` 的版本号即成功。若提示“不是内部命令”，说明没装好或没重启终端，重装一次并重启电脑再试。

#### 第 3 步：安装 .NET SDK

.NET SDK 是编译桌面端底层 Native Bridge 与启动器必需的工具。

1. 打开 https://dotnet.microsoft.com/download/dotnet → 下载 `global.json` 所要求的 **.NET 10 SDK**，一路“下一步”安装。
2. 装完同样**重新打开** PowerShell，验证：

~~~powershell
dotnet --version
~~~

> 注意：.NET Runtime（运行时）和 SDK 是两回事，必须装 **SDK**，否则 `dotnet build` 会失败。

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
# 1. 按锁文件安装依赖（第一次会比较慢，耐心等到完成）
npm ci

# 2. 下载锁定的 Electron 43 运行时
node node_modules/electron/install.js

# 3. 检查类型（确保代码没写错，没报错即通过）
npm run typecheck

# 4. 跑一遍测试（可选，新手可跳过）
npm test

# 5. 编译出桌面应用
npm run build

# 6. 刷新根启动器、自包含 Bridge 及相关 EXE
npm run exe:build
~~~

> 常见报错：
> - `npm : 无法加载文件 ... 因为在此系统上禁止运行脚本` → 以管理员身份打开 PowerShell 执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重试。
> - 网络超时/ `ECONNRESET` → 重试 `npm ci` 或 Electron 下载步骤，或切换网络/开代理。
> - `dotnet: command not found` → 没装好 .NET SDK，回到第 3 步。

#### 第 6 步：运行

编译成功后：

- **直接双击根目录的 `SoulForge.exe` 启动；如果缺少编译产物，root launcher 会回退到 `npm run dev`。**
- 或想边看前端控制台日志边跑（开发者常用）：

~~~powershell
npm run dev
~~~

首次启动若被 Windows Defender 拦截，点“更多信息”→“仍要运行”（因尚未做代码签名，属正常现象）。

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

会话记录：[桌面与自动模拟会话归档](docs/ai-logs/README.md)。本次收录 **195 份 rollout：77 份桌面会话、118 份自动模拟记录**，均提供 JSONL 快照和 Markdown 阅读版；模拟运行的 supervisor 日志不计入会话。记录中的完成、失败、中断或缺失终态不代表产品验收或成功率。

运行 `npm run ai-logs:sync` 会同步本机桌面会话及 `output/agent-real/*.rollout.jsonl`，保留旧归档并重建分类索引；仅更新已有索引用 `npm run ai-logs:sync -- --index-only`。公开追踪的是 `docs/ai-logs/` 中的快照，不是整个本机输出目录。同步会检查常见明文凭据，但不会自动脱敏；新增记录仍需审查后提交、推送，不会自动上传。

- [鬼型部修改 Markdown](docs/ai-logs/markdown/2026/08/23/rollout-2026-08-23T12-40-06-359Z-fdc9e1e0-62ee-4ac8-9168-e5966252fdde.md) · [原始 JSONL](docs/ai-logs/sessions/2026/08/23/rollout-2026-08-23T12-40-06-359Z-fdc9e1e0-62ee-4ac8-9168-e5966252fdde.jsonl)
- [道具/商店崩溃只读排查 Markdown](docs/ai-logs/markdown/2026/08/21/rollout-2026-08-21T02-37-13-611Z-27acb304-a895-4fe7-8701-07a2552340d7.md) · [原始 JSONL](docs/ai-logs/sessions/2026/08/21/rollout-2026-08-21T02-37-13-611Z-27acb304-a895-4fe7-8701-07a2552340d7.jsonl)

