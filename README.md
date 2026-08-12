# SoulForge

SoulForge 是给魂游（FromSoftware 的《只狼》《黑暗之魂》《艾尔登法环》等）modder 用的工作台。

一句话：像写代码时用 Cursor 一样，你用自然语言告诉它想怎么改游戏，它在独立的工作区里帮你改好、验证、提交，还能随时一键回滚——**原版游戏文件永远不被动**。

> 当前状态：仍在开发中（V0.5 里程碑），**尚未正式发布**。安装包未做代码签名，也**不包含任何游戏文件**。适合想尝鲜或一起开发的玩家与作者，暂不适合当作稳定工具分发。

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
- script 里大多数条目是编译后的字节码（LuaQ / LuaP），本版**不反编译、不重编译**；只有少数纯文本条目（如 `goal_list.lua`、`eventnameid.txt` 等）支持直接改源码。

## 暂时还不能做（V0.6 计划）

地图/场景（MSB）、动画/动作事件（TAE）、状态机（ESD）、3D 模型（FLVER）、贴图（TPF）、材质（MTD）、碰撞、导航，以及 3D 预览渲染，都推迟到 V0.6。目前相关面板只能**只读预览**，不能写入。

## 安全：改不坏、能回滚

- **原版目录永远只读**：你的修改只写进独立的 Mod 覆盖层，游戏本体一个字节都不会被碰。
- **三层回滚**：每次修改都经过「暂存 → 验证 → 备份 → 原子替换 → 重读确认」，改坏了可以按操作 / 文件 / 资源条目逐层回滚。
- **没有旁门左道**：AI、渲染、格式转换等任何路径都不能绕过这条安全写入主干。

## 快速开始（开发者 / 尝鲜）

当前没有面向普通玩家的正式安装包。想自己跑起来，需要 Node.js 与 .NET 10：

~~~powershell
npm install
npm run typecheck
npm test
npm run build
npm run dev
~~~

Bridge（.NET 原生解析桥）相关的验证命令见根目录 `package.json`。如果你没有真实游戏文件或私有测试样本，相关命令会诚实地返回 `skipped / unverified`，不会用假数据冒充通过。

## 支持的版本

- 目标：《只狼》1.6.x 版本族。
- 未登记的版本或其他游戏一律 fail-closed（不支持就直接拒绝，不做猜测）。


## 许可证

SoulForge 按 [Apache License 2.0](LICENSE) 授权，归属与第三方声明见 [NOTICE](NOTICE)。

SoulForge 不附带任何游戏资产、专有压缩库或 FromSoftware 代码。

## 想说的话

这个ui太丑了，有没有大手子帮我做一版好看的
This UI is hideous. Is there an expert who can help me create a better-looking version?
