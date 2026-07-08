# SoulForge 产品愿景

SoulForge 的最终愿景是：

```text
魂游 Mod 的 Cursor
```

它面向《只狼》和 FromSoftware 魂系游戏 Mod，目标不是再做一个传统资源编辑器，而是建立一个 AI 原生、安全、可审查、可回滚的 Mod 工程工作台。

## 1. 为什么需要 SoulForge

传统魂游 Mod 工作流经常是：

```text
解包 -> 猜 ID -> 多工具切换 -> 手工修改 -> 重打包 -> 进游戏撞墙
```

问题不只在工具老旧，而在资源关系被文件、封包和数字 ID 切碎了。

一个事件可能关联：

```text
event
  -> flag
  -> map entity / region
  -> param row
  -> msg text
  -> script / action / sfx / chr / obj
```

传统工具通常只让用户看到单个文件或单张表。SoulForge 要看到的是资源之间的证据关系。

## 2. SoulForge 应该变成什么

SoulForge 应该让用户打开一个原生 ModEngine 风格目录，然后得到一个现代、轻松、清晰的工作台：

```text
打开 Mod 目录
  -> 建立虚拟资源树
  -> 渐进索引资源
  -> 提取证据和引用关系
  -> 用 AI 解释资源
  -> 生成修改计划
  -> 预览跨资源 patch graph
  -> staging 验证
  -> 备份
  -> 原子保存
  -> 记录日志
  -> 可回滚
```

AI 的角色不是“看着一堆数字硬猜”，而是在 SoulForge 提供的证据包、引用图、diagnostics 和 Patch Engine 约束下工作。

## 3. 产品气质

SoulForge 的视觉和交互气质应参考 Codex / Cursor 这类现代 coding agent：

- 简洁；
- 优美；
- 流畅；
- 轻松；
- 低压迫感；
- 低噪音；
- 不老旧；
- 不拥挤。

Smithbox、DSMapStudio、DarkScript、WitchyBND 等工具可以作为资源组织和领域知识参考，但不是视觉风格模板，也不是源码来源。

## 4. 资源范围

SoulForge 的目标不是只编辑 event / param / msg，而是覆盖 ModEngine 风格目录中的主要资源：

```text
action
chr
event
map
menu
msg
obj
other
param
script
sfx
```

除图片 / 纹理类内容外，主要资源都应逐步做到可打开、可查看、可编辑。

## 5. AI 原生

AI 侧边栏是核心功能。

它应参考 coding agent，而不是普通聊天机器人：

```text
理解用户目标
  -> 调用只读工具收集证据
  -> 生成计划
  -> 生成 patch proposal
  -> 展示影响范围
  -> 自检
  -> 等待用户确认或通过策略门控
  -> 通过 Patch Engine 执行
```

Provider 至少应支持 OpenAI-compatible 和 Anthropic-compatible。

## 6. 安全底线

SoulForge 的承诺不是“AI 可以随便改任何东西”。

真正的承诺是：

```text
任何修改都必须经过证据、计划、patch、staging、验证、备份、日志和回滚。
```

这就是 SoulForge 和 Mod 毁灭型幻觉机器的区别。

## 7. 最终回答能力

当用户问：

```text
这个事件为什么不触发？
这个 Boss 二阶段区域在哪里？
这个 Flag 被谁设置？
这个 Entity ID 到底是谁？
我能不能把这个触发区往门口挪一点？
这个道具奖励能不能换成另一个？
这一批文本能不能做双语对照？
```

SoulForge 应该能回答：

```text
我能确认什么。
我推测什么。
我不知道什么。
证据在哪里。
会影响哪些资源。
该生成什么 patch。
保存前如何验证。
坏了如何回滚。
```

这就是 SoulForge 的产品愿景。
