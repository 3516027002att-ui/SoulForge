# SF-29 真实产品路径总验收记录

本文件是 Flash 总验收的交接记录，不把 core smoke、静态检查或合成 fixture 误写成 Electron 真实路径通过。

## 固定入口

- renderer 真实入口：`apps/desktop/package.json` 的 `test:renderer-playwright`，配置为 `apps/desktop/e2e/playwright/playwright.config.mjs`。
- core unit 汇总：`test:audit-sf-29-unit`，复用 SF-00..SF-28 已登记的生产 smoke，不复制第二套算法。
- native/product 汇总：`test:audit-sf-29-native`；只有实际产生的 Playwright trace、native reread 和回滚证据才能提升对应状态。

## 四类声明

| 路径 | 必须证明 | 当前声明规则 |
| --- | --- | --- |
| PARAM | UI 分页、非全量首屏、native 读回、回滚后 UI 同 revision | 没有真实 Electron trace 时保持 `not_run` |
| 地图 | MSB→model→mapbnd/FLVER→有效 mesh→GPU/rendered、事务与回滚 | 点云、盒子和占位数据不计通过 |
| 动作 | c0000/替代 fixture、bind pose、骨骼/权重、TAE 后置条件与回滚 | 未知 profile 保持 `blocked`/`not_run` |
| FMG | 正确语言/source/category 的词条 A→B→A，旧交易冲突保持 C | 交易与 UI trace 不完整时不报成功 |

## T01–T60 覆盖

SF-29 的 unit runner 读取 `SoulForge_Flash_Execution/acceptance-map.json`，逐项确认 T01–T60 都有执行归属；这只是覆盖完整性检查，不替代每项的实际后置条件。native/product 缺 fixture、Electron 启动失败、未接 renderer consumer 或没有独立 reread 时，证据必须保留为 `not_run`、`partial` 或 `blocked`。

## 性能与故障注入

冷/热、p50/p95、峰值 RSS、wire bytes、parse/decompress 计数和成功后置条件必须来自同一机器、同一 fixture、同一 provider 参数的真实运行。未执行 30 次冷/热样本时，不填写“快 N 倍”。取消、崩溃、journal、rename、native reread 和 UI 更新的故障点必须记录实际到达点。

## 结果分类

最终交接分别记录：`native read/write verified`、`game-load verified`、`interactive rendering verified`、`read-only/unsupported`。这些类别不能合并成无条件的“全功能可用”。

## 当前真实产品证据（只读）

2026-09-07 在本机真实只狼语料上执行了 `apps/desktop/e2e/playwright/tests/production-real-assets.spec.mjs`，通过生产 Electron 入口运行 5 个测试，结果为 `5 passed / 0 skipped / 0 failed`。证据报告为 `output/playwright/production-real-assets-report.json`，SHA-256 为 `EF6FD87C8218D406CE43E93CCCEA87AB1F065C28B63376AAEAECEE191E02A820`。

覆盖范围是：ACTION + MAP 读取与可视化、PARAM + FMG 工作台读取、c5400 按 FLVER MTD 身份绑定 c5409 纹理、C0000 动画绑定姿态与播放、多个真实动作及非 C0000 角色换帧。测试断言中记录的 page error 与 console error 均为空。

该证据只提升真实 Electron 交互读取/可视化到 `partial`：没有执行 Mod 写回、native reread/rollback、游戏实际加载、冷/热性能样本或分发验收，因此不能提升 `native read/write verified`、`game-load verified` 或发布状态。
