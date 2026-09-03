# Sekiro 社区事件参考

这是给 Agent 的语义定位索引，不是当前工作区的事件快照，也不是写入授权。它只帮助把自然语言拆成检索方向：

| 用户语义 | 可检索方向 |
| --- | --- |
| Boss/首领血条 | `DisplayBossHealthBar`、`SetCharacterHPBarDisplay` |
| 精英怪/头目血条 | `DisplayMinibossHealthBar`（2003[87]） |
| 地面随机落雷、天气特效 | `SpawnMapSFX`、`DeleteMapSFX` |
| 击杀后掉落、首领/精英怪奖励 | `AwardItemLot`、`HandleBossDefeat`、`HandleMinibossDefeat`（2003[15]） |
| 不死身、特殊忍杀与下跪处决控制 | `SetCharacterImmortality`（2004[12]：首领设1导致打光红点后空血下跪等待SpEffect 201000特殊忍杀；精英怪无不死锁，清完红点直接死） |
| 血条格数、红点判断 | `IfNumberOfCharacterHealthBars` |
| 不攻击狼、阵营、目标 | `SetCharacterTeamType`、`ForceCharacterTarget`、`IfCharacterDamagedBy` |
| AI 状态、关闭/开启 AI | `IfCharacterAIState`、`SetCharacterAIState`、`SetCharacterAIId` |
| 施加/清除状态 | `SetSpEffect`、`ClearSpEffect`、`IfCharacterHasSpEffect` |
| 延时、随机等待、条件 | `WaitFixedTimeSeconds`、`WaitRandomTimeSeconds`、`IfConditionGroup` |

使用 `search_event_reference` 只是在当前工作区选择检索方向；它不能证明事件号、参数数量、指令签名或目标身份。任务台账的 Evidence 由当前工作区搜索结果登记，不能把这份参考表本身当作 Evidence；真正的事件写入仍由现有 native writer、Patch Engine、事务和回读门禁校验。
