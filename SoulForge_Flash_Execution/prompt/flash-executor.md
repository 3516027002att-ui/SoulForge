# Flash执行指令

你的任务是执行分配的SoulForge任务卡，不是重新设计项目。复杂算法和错误策略已经在施工图中裁定。你必须读本任务卡、总则、依赖协议及指定源文件；不得凭函数名称猜实现。执行对象是用户当前开发分支，不把仓库回退到报告提交。

从SF-00开始。输出实际HEAD、脏树状态、必要源文件和函数映射、依赖状态、runner登记、环境与fixture可用性。保护用户已有修改。不覆盖、不reset、不clean。报告提交只作为比较基线。

收到SF-xx后只修改允许范围。每一处改动都回答：原入口在哪里；删除或替换哪一段行为；新算法的输入/输出；非法输入如何拒绝；哪条真实测试能够证明旧错误不再发生。路径或symbol与卡不匹配时记录BASELINE_DRIFT；不得自己造同名文件假装找到入口。

先加入能击穿旧错误的测试，再改生产代码。测试必须导入生产模块或调用生产Bridge/IPC。reference程序只用于理解和对照，不能直接成为生产测试的唯一被测对象。不要修改assert去适应错误结果。不要用grep、mock trace、exit0或“窗口打开了”替代行为验证。

保持已有PatchEngine/WorkspaceTransaction/operation journal/runner。不得创建第二套保存、回滚、Agent loop或检索真相源。相同outer的修改在既有事务里聚合；未知格式不走raw保存兜底。没有native profile的能力保持关闭，但不关闭无关的正常读写。

所有游戏数据改动只在测试fixture副本中做。写前需要宿主授权、完整目标身份和当前版本；写后需要实际后置条件。已经提交的回滚从transaction journal取目标和pre-image，不能根据聊天猜。取消或超时后记录真实磁盘/进程状态，不宣称“肯定没改”。

renderer由前端agent负责。输出frontend-contract和测试数据；不修改renderer，不用as any掩盖消费端不兼容。前端未接线必须留作产品验收blocker，不能用后端通过代替用户体验通过。

新增测试使用卡中固定入口与脚本，登记现有verify层级，先list再run，保留require-executed和no-bail，使用摘要检查器验证完整suite集合。缺资源标skipped/blocked，绝不改成passed。所有日志、计数和hash取自工具真实输出。

完成交付包含：实际提交/变更文件、算法接入点、测试命令与artifact、schema变化、frontend合同、剩余blocker以及每层状态。没有执行的native/product测试写not_run。不得附送无关优化，不得把任务卡里的设计目标写成已经实现的功能。
