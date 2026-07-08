# SoulForge 项目状态快照（Checkpoint）

生成时间：2026-07-04

## 一、项目本质

SoulForge 是一个“AI-native FromSoftware Mod 超级编辑器”，目标不是传统 Mod 工具，而是：

> 让 AI 能像 Cursor 一样理解、编辑、验证、回滚魂系 Mod 数据结构。

核心不是 UI，而是 **语义桥（Bridge）+ 证据链解析器（Parser）+ Patch Engine**。

---

## 二、核心数据链

当前统一资源理解链：

```
event → map → param → msg
           ↑
         BND 容器入口
```

关键原则：

- 所有解析必须基于“证据”，不能直接假设语义
- synthetic fixture 用于验证 pipeline，不代表真实 FromSoftware 格式
- low-confidence candidate 永远保留 fallback

---

## 三、当前技术栈

- Electron + React + TypeScript（前端超级编辑器 UI）
- C# Bridge（SoulForge.Bridge，负责二进制/语义解析）
- Node.js monorepo
- PowerShell / dotnet CLI（本地验证）

---

## 四、当前完成的关键能力

### 1. Bridge 语义分层

- inspect：只输出 evidence，不输出“假语义结构”
- export-msg / export-event / export-param / export-map
- DCX / BND 容器边界识别
- raw fallback + candidate scan + synthetic fixture 三层结构

### 2. Synthetic Fixture 系统（已接入）

已完成并接入 router：

- MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED
- EMEVD_SYNTHETIC_FIXTURE_CONFIRMED
- PARAM_SYNTHETIC_FIXTURE_CONFIRMED
- MSB_SYNTHETIC_FIXTURE_CONFIRMED

### 3. Event / Param / Map 路由升级

执行顺序统一为：

```
Container boundary → Synthetic fixture → Low-confidence fallback
```

### 4. BND（未完成接线）

- SyntheticBinderFixtureExports 已存在
- 但尚未接入 export / inspect 路由
- binderChildCandidate 仍为 low-confidence evidence

---

## 五、当前已知问题

### 1. Build 环境问题

- npm run build 报 Rollup optional dependency 缺失（@rollup/rollup-linux-x64-gnu）
- 属于 node_modules / optional deps 环境问题，不是代码逻辑问题

### 2. CodexPro 执行限制

- safe bash 不允许直接运行 dotnet / PowerShell
- Bridge smoke 需要本地终端执行

---

## 六、当前开发阶段（v0.3）

### v0.3 目标

从：

> low-confidence candidate parser

升级为：

> fixture-confirmed parser + evidence-first semantic bridge

重点不是扩功能，而是“可信度升级”。

---

## 七、下一步优先级

### P0：本地验证（issue #1）

运行：

```powershell
npm run bridge:build
npm run bridge:verify:synthetic
```

目标：确认 4 大 synthetic fixture 全部通过。

---

### P1：BND 子资源系统（issue #2）

目标：

- BND child inventory fixture confirmed
- child table listing
- offset / size / kind / name

---

### P2：稳定性

- 修复 npm optional dependency
- 稳定 CI / build pipeline

---

## 八、核心设计哲学

### 1. 证据优先

任何结构必须满足：

> 有证据 → 才能提升置信度

### 2. 不伪造语义

- 禁止从 binary 猜“这是敌人/区域/事件”
- 只能输出 candidate + confidence

### 3. fixture vs native

- fixture = pipeline correctness proof
- native = 未证明领域

---

## 九、当前系统真实状态一句话总结

> Bridge 已经能“看见结构”，但还不能“宣称理解结构”。
