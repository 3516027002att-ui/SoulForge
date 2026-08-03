# Anti-AI 审查 · 第二轮（去 AI 味细节）

审查角色：独立 reviewer。层：L1 + L2。截图：`output/renovation/r2-01-hex-readonly.png`、`r2-02-grayscale.png`。

## 五项测试

| 测试 | 结果 | 证据 |
|---|---|---|
| Swap | 通过：换 logo 后"待审查变更/证据/可逆性/只读标记"仍指向资源写入工作流，不等同任意 AI IDE | r2-01 |
| Squint | 通过：中央工作区最突出；Agent 320px 次之；主按钮唯一亮填充；无同权重边框矩形堆 | r2-01/02 |
| Grayscale | 通过：去色后层级靠表面微差+hairline+字重；active tab 靠顶线+亮底；op 徽章靠文字；状态不依赖颜色单通道 | r2-02 |
| Copy | 🟡：Hex 证据条"renderer 不暴露字节级写路径"为开发者语言 → 第三轮改用户语言 | r2-01 |
| Density | 通过：表格行 5px、高频操作（审查/批准/写入）一步可达；内部名在详情行折叠 | r1-02/r2-01 |

## 本轮修复

| # | 问题 | 修复 | 结果 |
|---|---|---|---|
| 1 | composer 上下文 chip 硬编码 | 跟随 activateTab，可清除，无 tab 时隐藏 | r2-01 chip=common.luabnd.dcx |
| 2 | 只读 tab 无标记 | tab 加锁形 role=img aria-label=只读 | r2-01 可见 |
| 3 | 欢迎页垂直留白 | place-items 上移 + 8vh 顶距 | r1-03 后确认 |
| 4 | ctx-chip 胶囊（999px） | 改 radius-s 矩形 | r2-01 |
| 5 | 状态栏与侧栏信息重复 | 中项改"当前：{file}（只读）" | r2-01 底部 |

## 遗留（第三轮）

- Hex 证据条文案用户语言化。
- 状态矩阵补全：loading / 解析失败 / 部分解析 / 长文件名 / 窄窗 1024 / 键盘焦点可见 / reduced-motion（已有）/ 写入失败。
- copy-audit.md 全量文案审查。
