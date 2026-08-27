# Mission 1 handoff 入口

本目录用于继续 `report.md` 中尚未完成的 Mission 1 收口工作。

**执行 Agent 必须从 `00-MISSION1-WEAK-AGENT-EXECUTOR.md` 开始。**

固定读取顺序：

1. `00-MISSION1-WEAK-AGENT-EXECUTOR.md`：执行状态机、停止条件、report 欠项的无歧义算法；
2. `report.md`：上一位强 Agent 留下的未完成项与发现；
3. `mission1.md`：详细技术契约、数学、DTO、预算、golden fixture；
4. 当前源码、测试、真实运行产物：最终事实来源。

不要从 `mission1.md` 顶部关于历史路径/权威路径的旧说明自行推断当前 handoff 分支的执行入口；本 README 与 `00-MISSION1-WEAK-AGENT-EXECUTOR.md` 已明确本分支的读取顺序。

完成标准不是“代码已经写了”，而是 required gate 具有完整 source evidence、真实验收 artifact、negative/perturbation test，并通过独立 verifier。`sourceCompleteness=partial` 的 required gate 不得 PASS。
