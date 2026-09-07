# SoulForge Flash实施包：从这里进入

本包基于2026-09-06报告及固定提交`f9cb0cd76a11bfa2857b48acbc779bfac0355d96`。它是实施计划与算法参考，不是已应用到仓库的补丁。生产代码、本机游戏文件和仓库设置均未被本包修改。

## 给执行模型的入口

首次交给Flash：`prompt/flash-executor.md`、`chapters/00-执行总则.md`、`tasks/SF-00.md`以及原报告。完成SF-00的真实基线核对后，由集成者分配下一张依赖已满足的任务卡。不要一次让Flash修改全部30项。总文档用于理解完整合同；施工输入以一张卡及其必要共享合同为界。

执行资料放入仓库的`docs/audit-execution/`；`tools/check-verify-summary.mjs`是唯一需要在SF-00复制到`scripts/audit-execution/check-verify-summary.mjs`的辅助工具。`reference/`不复制到生产barrel，不发布进app.asar，不替代native实现。

## 文件索引

`SoulForge_Flash_Execution_Plan.md`为单文件总施工图；`SoulForge_Flash_Execution_Plan.html`为同内容阅读版。`tasks/`含30张执行卡及对应required-suites清单；`tasks.json`是依赖与文件权限表；`acceptance-map.json`保留原报告60项验收；`ADVERSARIAL_REVIEW.md`记录对抗复查和修订；`reference/`为可执行算法；`tools/`为验收摘要与交付包检查；`evidence/`为本次真实执行的参考测试和文档检查结果；`basis/`保留原报告及其依据。

## 运行本包自己的测试

在本包目录、Node.js 22.16或相容的Node22环境执行：

```bash
node --test reference/algorithms.test.mjs tools/check-verify-summary.test.mjs
node tools/check-delivery.mjs
```

这些测试不读取真实游戏数据，不调用SoulForge源码，不启动.NET/Electron/Blender，不调用付费模型。通过只证明参考算法与交付结构的对应断言。真实仓库的native/product验收仍按任务卡执行。

## 环境与安全边界

Flash不得修改renderer、清理用户脏树、删除恢复点、上传游戏数据或增大权限。输入里的源hash不等于授权；Wiki发布不等于事实已验证；读取摘要不等于完整源码；timeout不等于没有发生写入；unsupported与skipped不等于已完成。
