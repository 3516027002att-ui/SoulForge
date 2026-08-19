# SoulForge

SoulForge 是给魂游（FromSoftware 的《只狼》《黑暗之魂》《艾尔登法环》等）modder 用的工作台。

一句话：像写代码时用 Cursor 一样，你用自然语言告诉它想怎么改游戏，它在独立的工作区里帮你改好、验证、提交，还能随时一键回滚

> 当前状态：仍在开发中（V0.5 里程碑），**尚未正式发布**。安装包未做代码签名，暂不适合当作稳定工具分发。

## 现在能改什么（V0.5 · 文本优先）

本阶段聚焦「文本与数值」，提供五个编辑器：

| 编辑器 | 通俗说法 | 你能拿它做什么 |
| --- | --- | --- |
| FMG | 改文本 / 做汉化 | 改菜单、物品名、对话、说明文字 |
| PARAM（gameparam） | 调数值 / 平衡 | 改攻击、防御、掉落等数值配置 |
| EMEVD | 改事件 / 剧情 | 改事件脚本：剧情流程、Boss 战阶段、机关触发 |
| BND4 | 打包 / 解包资源 | 增删改游戏资源包里的条目 |
| script | 改 AI / 行为（有限） | 查看 AI 与出招脚本；明文条目可改源码，字节码条目只能整文件替换 |

几点说明：

- PARAM 本版只覆盖 `gameparam`；`drawparam`、`gparam` 推迟到 V0.6。

## V0.6 计划（大饼）

地图/场景（MSB）、动画/动作事件（TAE）、状态机（ESD）、3D 模型（FLVER）、贴图（TPF）、材质（MTD）、碰撞、导航，都推迟到 V0.6。目前相关面板只能**只读预览**，不能写入。

## 卓越的安全

- **写入当前打开的工作区**：你打开哪个 Mod 文件夹，修改就写进哪里。工作区可以在游戏安装目录里（例如 `Sekiro\\mods`）。
- **三层回滚**：AI的每次修改都经过「暂存 → 验证 → 备份 → 原子替换 → 重读确认」，改坏了可以按操作 / 文件 / 资源条目逐层回滚。
- **没有旁门左道**：AI、渲染、格式转换等任何路径都不能绕过这条安全写入主干。

## 开发文档

不不不你不应该看这些，因为暂时没人来contribute，所以这些文档都是写给agents看的

## 快速开始（开发者 / 尝鲜）

当前没有面向普通玩家的正式安装包。想自己跑起来，需要 Node.js 与 .NET 10：

~~~powershell
npm install
npm run typecheck
npm test
npm run build
npm run dev
~~~
下载好各种依赖之后，双击SoulForge.exe就行了

## 支持的版本

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

