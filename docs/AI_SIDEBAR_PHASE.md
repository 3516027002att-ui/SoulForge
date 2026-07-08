# SoulForge AI 侧边栏阶段说明

生成时间：2026-07-04

## 阶段定位

AI 侧边栏不是简单聊天框，也不是直接接模型 API 的按钮。

它在 SoulForge 中的定位是：

> 证据上下文聚合器 + 安全工具调度台 + Patch Engine 前置计划层。

当前阶段目标是先把状态机和 UI 骨架搭起来，让后续接 OpenAI / Anthropic 时不会绕过证据链、权限模式和 Patch Engine。

## 已接入能力

### 1. Core AI Session 类型

新增：

```text
packages/core/src/ai/assistantSession.ts
```

包含：

- `AiProvider`: mock / openai / anthropic
- `AiThinkingLevel`: fast / normal / deep / extreme
- `AiPermissionMode`: plan / normal / fullPermission
- `AiSidebarSettings`
- `AiSidebarDraftRequest`
- `AiSidebarDraft`
- `buildAiSidebarDraft`

当前 `buildAiSidebarDraft` 是本地 deterministic planner，不联网，不调用真实模型。

### 2. IPC / preload 通道

新增主进程 IPC：

```text
ai.sidebarDraft
```

preload 暴露：

```ts
window.soulforge.buildAiSidebarDraft(request)
```

这意味着 renderer 不直接碰模型，也不直接碰文件系统。

### 3. Renderer AI 侧边栏升级

`apps/desktop/src/renderer/src/App.tsx` 已从简单工具台升级为 AI 工作台：

- Provider 选择：Mock / OpenAI / Anthropic
- Thinking 选择：fast / normal / deep / extreme
- Mode 选择：plan / normal / full permission
- 当前资源上下文
- reference stats
- diagnostics scope
- Goal 输入框
- 本地计划草稿生成
- Recommended tools
- Next actions
- Prompt preview
- Safe tools 按权限分组显示

### 4. 安全边界

当前 UI 明确表达：

- plan 模式只读证据和生成计划
- normal 模式可生成和验证 patch，但不能越过 Patch Engine
- full permission 仍必须经过备份、验证和 rollback
- OpenAI / Anthropic 目前显示 needs config，不进行真实 API 调用

## 验证结果

2026-07-04：

- `npm run typecheck`：通过
- `npm test`：通过

`npm run build` 仍受本地 Rollup optional dependency 缺失影响，问题是 `@rollup/rollup-linux-x64-gnu` 不存在，属于 node_modules / npm install 状态问题。

## 后续下一刀

### P0：Provider 配置层

需要新增安全配置结构：

- API key 来源：环境变量 / 本地安全存储 / 用户输入临时 session
- provider model id
- baseURL 可选
- request timeout
- no-send file content policy
- logging redaction

### P1：AI Request Planner

把当前 deterministic draft 升级为：

```text
context snapshot -> prompt package -> provider adapter -> model response -> tool call plan
```

但仍然不允许模型直接写文件。

### P2：Tool Call Loop

模型只能提出工具调用意图：

```text
read tools -> evidence summary -> patch proposal -> validation -> user approval
```

### P3：Patch Engine UI

AI 给出的修改必须显示：

- planned diff
- affected resources
- confidence
- validation result
- backup / rollback plan

## 硬边界

- 不把 API key 写入仓库
- 不让 renderer 直接访问 secret
- 不让模型直接写 Mod 文件
- 不把 low-confidence evidence 当 confirmed parser output
- 不把 synthetic fixture 当 native FromSoftware 格式权威
