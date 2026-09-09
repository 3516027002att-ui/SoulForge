# Sekiro 社区事件参考知识库

这是基于只狼社区 Modder 实战笔记（含《事件.txt》与《事件代码整合(1).txt》）全量整理的语义索引与实战指导。它帮助将自然语言意图映射到底层 EMEVD 指令、MSB 实体与关联机制。

> 注意：本参考是语义检索指引，不是当前工作区的事件快照，也不是写入授权。当前事件号、指令签名、参数和写入身份仍必须由本机 EMEVD/EMEDF 原生读取复核。

---

## 一、战斗、血条与击败结算

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| Boss / 首领全屏血条 | `DisplayBossHealthBar` | 显示屏幕下方的大首领专属全屏血条与顶端大架势条。通常配合开战事件调用。 |
| 精英怪 / 头目血条 | `DisplayMinibossHealthBar` | 显示精英怪（Miniboss）专用的全屏血条与架势条（包含红点生命槽）。 |
| 头顶血条控制 | `SetCharacterHPBarDisplay` | 控制指定角色头顶的悬浮血条显示或关闭（例如 `Disabled` 关闭）。注意：此指令仅控制头顶小血条，不等同于屏幕下方的 Boss/精英怪大血条。 |
| 血条格数 / 红点数判断 | `IfNumberOfCharacterHealthBars` | 判断指定角色当前剩余的血条格数（红点数）。 |
| 角色血量条件 | `IfCharacterHPValue` | 按角色当前 HP 数值建立条件分支（例如判断血量小于 1）。 |
| 生死状态判断 | `IfCharacterDeadalive` | 检测角色生死状态（`DeathState.Dead` 或 `Alive`）。 |
| 首领击败 / 忍杀字幕 | `HandleBossDefeat` | 处理首领击败结算，屏幕出现击破/忍杀字幕。 |
| 精英怪击败结算 | `HandleMinibossDefeat` | 处理精英怪/头目击败结算流程（区别于大首领不死斩横幅）。 |
| 特殊横幅字幕 | `HandleBossDefeatAndDisplayBanner` | 屏幕弹出大型文字横幅。参数可指定横幅类型：`TextBannerType.ImmortalitySevered`（不死斩）、`TextBannerType.TestMessage`（踏破）等。 |
| 不死身与处决控制 | `SetCharacterImmortality` | 设置角色不死身保护状态（`Enabled`/`Disabled`）。用于控制角色在空血时是否保留锁血状态或等待特定处决动画。 |
| 强制执行死亡 | `ForceCharacterDeath` | 强制请求指定角色死亡。参数布尔值可能影响死亡时是否正常掉落金钱或物品。 |
| 特殊处决请求 | `EzstateInstructionRequest` | 请求 EzState 状态机指令（如调用 `20200` 等特殊处决动画或状态请求）。 |

---

## 二、实体移动、传送与召唤流

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| 召唤流 / 拉人到身边 | `WarpCharacterAndCopyFloor` | **召唤流核心拉人代码**：将指定角色传送到玩家（狼）身边，并复制玩家当前的楼层与地面信息（TargetEntityType.Character）。若需远程拉取需配合参数调整。 |
| 点位传送 / 设楼层 | `WarpCharacterAndSetFloor` | 将角色传送到指定地图点位（Area 点位事件 ID）并设定其楼层高度。 |
| 短距离传送 | `IssueShortWarpRequest` | 发出短距离传送请求，适用于近距离位置微调或快速位移。 |
| 区域传送与镜头设置 | `WarpPlayerWithinAreaSettingCameraOrientation` | 在当前区域设置中传送玩家，同时强制指定传送后的摄像机朝向。 |
| 跨地图玩家传送 | `WarpPlayerNew` | 将玩家传送到目标地图的指定点位（需传入目标地图大号、小号与点位 ID）。 |
| 重置角色位置 | `ResetCharacterPosition` | 重置指定角色至其初始生成位置。 |

---

## 三、角色状态、动画与 AI 控制

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| 角色显示 / 加载开关 | `ChangeCharacterEnableState` | **控制角色在场景中的显示或消失**（`Enabled`/`Disabled`）。注意区分：此指令只管角色模型是否存在与渲染，不决定角色能否行动。 |
| 角色行动 / 动画开关 | `SetCharacterAnimationState` | **控制角色能否行动/动起来**（`Enabled`/`Disabled`）。让角色静止冻结或恢复自由行动使用此指令，与上述的显示/消失完全不同。 |
| 强制播放指定动作 | `ForceAnimationPlayback` | 强制角色播放指定的动作动画（需指定动画 ID、是否循环等）。 |
| 请求动作播放 | `RequestAnimationPlayback` | 向角色发送动画播放请求。 |
| 物体动画播放 | `ReproduceObjectAnimation` | 播放或重放地图静态物体（Object）的动画。 |
| 角色后台加载控制 | `SetCharacterDefaultBackreadState` | 控制角色的默认后台加载（Backread）状态。 |
| 角色阵营设置 | `SetCharacterTeamType` | 设置角色的阵营属性（如 `TeamType.WhitePhantom` 白灵友军、敌对阵营等）。 |
| 强制锁定目标 / 索敌 | `ForceCharacterTarget` | 强制指定角色锁定特定目标（如锁定玩家 10000）。 |
| 角色锁定点控制 | `SetLockOnPoint` | 开启或关闭玩家对该角色的锁定点（LockOnPoint 禁用后玩家无法对其使用锁定键）。 |
| 角色 AI 状态判断 | `IfCharacterAIState` | 条件判断角色当前所处的 AI 状态（如 `Combat` 战斗中、`Alert` 警惕、`Normal` 正常状态）。 |
| 开关角色 AI | `SetCharacterAIState` | 直接开启或关闭角色的整体 AI 逻辑。 |
| 切换角色 AI 参数 | `SetCharacterAIId` | 动态更改角色使用的 AI 参数模板 ID。 |
| 发送 AI 计划命令 | `RequestCharacterAICommand` | **向 AI 发送特定命令请求**。关键避坑：该指令必须与角色的 Lua AI 行为树配合，若角色的 AI 脚本中没有该命令 ID 对应的计划执行分支，则调用不会产生任何效果。 |
| 触发 AI 重新规划 | `RequestCharacterAIReplan` | 请求角色的 AI 行为树立即执行重新规划。 |
| 敌人复活 / 召唤出现 | `MakeEnemyAppearEvent` | 触发敌人出现或复活事件。通常需配合地图编辑器中的复活出生点和生成逻辑（参考孤影众召唤忍犬机制）。 |
| NPC 部位创建与音效 | `CreateNPCPart` / `SetNPCPartSEAndSFX` | 创建 NPC 的部位/肢体结构（Part），并为该部位绑定专属的音效与特效。 |

---

## 四、区域、距离与交互触发条件

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| 进入 / 离开区域触发 | `IfInoutsideArea` | 判断玩家或指定实体是否处于指定区域内部或外部（需配合 MSB 区域事件编号 AreaEntityID）。 |
| 两实体间距离判定 | `IfEntityInoutsideRadiusOfEntity` | **距离半径触发**：判断实体 A 与实体 B 之间的距离关系（例如“实体 A 离实体 B 超过 35 米”或“小于 20 米”触发）。 |
| 动作交互按键检测 | `IfActionButton` | 检测玩家是否在指定物体附近按下了动作交互键。 |
| 受到玩家伤害检测 | `IfCharacterDamagedBy` | 判断角色是否被指定来源（如玩家 10000）攻击或造成伤害。 |
| 玩家锁定状态检测 | `IfPlayerLockedOn` | 判断玩家当前是否锁定了指定目标角色。 |
| 实体注视检测 | `PlayerIsLookingAtEntity` | 检测玩家视线或摄像机是否正在注视目标实体。 |
| CG / 过场播放完毕 | `IfOngoingCutsceneFinished` | 检测当前正在播放的指定 CG/过场动画是否已播放完毕。 |
| 状态效果（SpEffect）判断 | `IfCharacterHasSpEffect` | 检测角色身上是否拥有指定的 SpEffect 特效/Buff/Debuff 状态。 |
| 施加 / 清除状态效果 | `SetSpEffect` / `ClearSpEffect` | 给指定角色施加或清除指定的 SpEffect 特效状态。 |
| 道具持有状态判断 | `IfPlayerHasdoesntHaveItem` | 检测玩家背包中是否拥有（或未拥有）指定 Goods 道具。 |
| 玩家游泳 / 潜水状态 | `IfPlayerSwimState` / `PlayerSwimState` | 检测或设置玩家当前的游泳（Swimming）或潜水（Diving）状态。 |

---

## 五、地图物体、雾门与场景交互制作

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| **制作与控制雾门** | `CreateObjectfollowingSFX`<br>`DeleteObjectfollowingSFX`<br>`DeactivateObject` | **实战全流程制作要点**：<br>1. 在地图编辑器中复制一个物体，将其 ModelName 设为 `o001402`（雾门模型）；<br>2. 分配地图中的 EntityID；<br>3. 在 EMEVD 中使用 `CreateObjectfollowingSFX(objectId, 101, 12)` 创建跟随物体的雾门特效；<br>4. 开门/消除雾门时，使用 `DeleteObjectfollowingSFX(objectId, false)` 关闭雾效，并用 `DeactivateObject(objectId, Disabled)` 禁用物体阻挡与碰撞。 |
| 地图部件开启 | `ActivateMapPart` | 启用指定的地图部件（MapPart），使其在世界中生效。 |
| 禁用鬼佛 / 物体互动 | `SetObjectInteraction` | 设置指定物体的交互属性与状态。例如设为 `ObjectInteractionType.Grapple, Disabled` 可禁用钩绳交互。 |
| 直接禁用鬼佛 | `DisableBonfire` | 禁用指定鬼佛/篝火的交互功能。 |
| 设置重生点与存档 | `SetPlayerRespawnPoint`<br>`SaveRequest` | 设置玩家当前的重生点位，并调用 `SaveRequest(0)` 触发底层即时存档。 |

---

## 六、环境、昼夜天气与声效表现

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| 场景昼夜与天气切换 | `SetAreaEnvmap` | 改变场景的环境图与昼夜天气效果。参数传入 0~10 的不同预设编号可切换晴天、黄昏、夜晚等全局环境光照。 |
| 区域光照时间设置 | `SetLightingUnknown` | 设置区域光照时间段（如 `TimeofDay.Morning` 早晨、`TimeofDay.Noon` 中午、`TimeofDay.Evening` 黄昏）。 |
| 地图仪式控制 | `SetMapCeremony` | 控制地图仪式状态（改变整体场景阶段与氛围）。 |
| 地图特效 / 天气特效 | `SpawnMapSFX` / `DeleteMapSFX` | 开启或关闭地图范围特效（如落雷、战场风沙特效等）。例如剑圣战场中的特效可通过 `SpawnMapSFX(1124800)` / `DeleteMapSFX(1124801, true)` 等调用。 |
| 区域镜头参数调整 | `SetAreaCamerasetparamSubid` | 调整当前区域的摄像机参数预设。 |
| 播放动作音效 | `PlaySE` | 播放指定角色的动作音效（需指定 `SoundType.cCharacterMotion` 与音效编号）。 |
| 屏幕黑屏淡入淡出 | `SetMenuFade` | 屏幕淡入或淡出至黑屏（常用于过场衔接、地图传送等场景，如 `FadeType.FadeOut, 0.5`）。 |
| 过场动画播放与传送 | `PlayCutsceneAndWarpPlayer` | 播放指定 CG/过场动画并在结束后将玩家传送到目标点位。可设置是否允许跳过（Skippable）。 |
| 带光照过场动画 | `PlayCutsceneAndWarpPlayerWithLighting200213` | 播放带有特定区域光照时间预设的过场动画并传送玩家。 |

---

## 七、物品、变量、技能与界面提示

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| 掉落奖励组赋予 | `AwardItemLot` | 直接触发并判定玩家获得指定 ItemLot 奖励组/掉落组的物品。 |
| 移除玩家物品 | `RemoveItemFromPlayer` | 从玩家背包中移除指定数量的道具（指定 Goods ID 与扣除数量）。 |
| 物品持有量存入变量 | `StoreItemAmountHeldInEventValue` | 读取玩家持有的指定道具数量，并将其保存在事件变量寄存器中。 |
| 事件变量 / 计数器递增 | `IncrementEventValue` | 对指定的事件数值寄存器执行递增步长操作。 |
| 赋予玩家技能 | `GrantSkill` | 直接向玩家解锁并赋予指定的技能（Skill ID）。 |
| 教程提示文本弹窗 | `ShowTutorialText` | 弹出大型教程说明窗口，显示指定的文本条目。 |
| 提示框 / 交互提示 | `ShowHintBox` | 弹出常规提示框，显示多段说明文本。 |
| 左侧小型提示字 | `ShowSmallHintBox` | 在屏幕左侧弹出小型提示行（通常用于拾取重要物品或简短状态提醒）。 |
| 区域欢迎横幅 | `DisplayAreaWelcomeMessage` | 玩家进入新区域时弹出区域名称欢迎横幅。 |
| 全局确认/取消对话框 | `DisplayGenericDialogGloballyAndSetEventFlags` | 弹出带 OK/CANCEL 选项的全局确认对话框，并根据玩家选择自动设置对应的 EventFlag。 |
| 延时等待控制 | `WaitFixedTimeSeconds`<br>`WaitFixedTimeFrames`<br>`WaitRandomTimeSeconds` | 事件脚本中的流程等待控制：按秒等待、按游戏帧等待、或在时间范围内随机等待。 |

---

## 八、事件流控、跳转与函数架构

| 用户语义 / 意图 | EMEVD 核心指令 | 实战说明与避坑要点 |
| --- | --- | --- |
| 注册公共事件函数 | `InitializeCommonEvent` | 注册并初始化通用公共事件（定义函数 ID、传入通用参数槽位与初始值）。 |
| 本地事件定义与入口 | `Event` / `InitializeEvent` | 定义本地事件函数入口（`Event(eventId, Restart, function(...) { ... })`）或显式初始化本地事件。 |
| 复合条件组判定 | `IfConditionGroup` | 复合条件组判定（例如 `MAIN, PASS, OR01`，表示当 OR01 条件组内任意一个条件满足时主流程通过）。 |
| 条件流转与标签跳转 | `GotoIfEventFlag` / `Label0` | 当指定 EventFlag 满足条件时，跳转到指定的脚本标签（Label）位置执行。 |
| 事件标记（Flag）开关 | `SetEventFlag` | 开启（`ON`）或关闭（`OFF`）指定的事件标记 Flag。 |
| 范围内随机置 Flag | `RandomlySetEventFlagInRange` | 在指定的 Flag 范围区间内随机选择并开启事件标记。 |
| 地图内外分支跳转 | `GotoIfPlayerInoutMap` | 根据玩家当前是否处于指定地图（如判断是否在 m11_02_00_00），控制事件跳转到指定标签。 |
| 无条件结束事件 | `EndUnconditionally` | 立即无条件终止当前事件的执行（`EventEndType.End`）。 |
