# SoulForge v0.5 第三批架构分叉裁定

本文记录 v0.5 的架构级隐藏分叉裁定。它们约束资源图、协议、Patch Engine、Bridge、AI 工具、插件、安全和恢复系统。

排序规则沿用前文：

- A：最低完成度 / 最保守实现
- B：可用级
- C：产品级
- D：终局级 / 最大完成度

用户裁定：101–160 全部按建议方案执行。

## 101–110：资源图、URI、Parser / Writer / Patch 基础

### 101. Resource Graph

选择：D。

采用 temporal property graph：每次索引、patch、回滚都有版本和时间线。

### 102. Resource URI

选择：D。

URI 包含 overlay layer、version、hash、symbol path。资源引用不得只靠文件路径。

### 103. Resource Kind

选择：D。

resource kind 插件化，支持继承、别名和版本兼容。

### 104. Field Identity

选择：D。

字段具备 stable field URI，跨版本 schema diff 后仍可追踪。

### 105. Provenance

选择：D。

每个字段、引用、诊断、patch 都必须能挂 provenance chain。

### 106. Confidence

选择：D。

采用多证据融合：parser、schema、profile、用户确认、validator 都参与评分。

### 107. Parser Pipeline

选择：D。

完整 pipeline：inspect、decompress、container、semantic、schema bind、reference、diagnostics、provenance。

### 108. Writer Pipeline

选择：D。

writer contract 包含 input schema、precondition、write plan、staged output、post-validate、rollback metadata。

### 109. Validator

选择：D。

多层 validator：文件、容器、语义、引用图、profile、游戏风险策略。

### 110. Patch IR

选择：D。

graph patch：节点、边、字段、容器 child、raw byte range 统一表达。

## 111–120：Patch Operation、事务、备份、索引、Bridge 协议

### 111. Patch Operation

选择：D。

declarative operation：前置条件、目标、影响范围、验证器、回滚策略一起描述。

### 112. Transaction

选择：D。

workspace transaction：跨 overlay、容器、资源图、索引、日志统一提交或回滚。

### 113. Staging

选择：D。

content-addressed staging：hash 去重、可恢复、可审计。

### 114. Backup

选择：D。

restore point：文件、DB、patch history、resource graph 快照一起保存。

### 115. Rollback Validation

选择：D。

回滚本身也是 transaction。若回滚失败，必须能恢复到回滚前状态。

### 116. Conflict Detection

选择：D。

全流程持续检测：计划、staging、验证、提交、重新索引都检查冲突。

### 117. Index Invalidation

选择：D。

dependency-aware incremental index：只更新受影响子图。

### 118. SQLite Schema Version

选择：D。

workspace DB 必须 versioned，可迁移、可回滚、可检测不兼容版本。

### 119. Bridge Protocol

选择：D。

Bridge protocol versioned：capability negotiation、backward compatibility、deprecated field 管理。

### 120. Bridge Communication

选择：D。

Bridge daemon + streaming + cancellation + progress + structured errors。

## 121–130：Bridge 错误、Capability、权限、AI 工具和 Agent 状态机

### 121. Bridge Error Model

选择：D。

typed failure：unsupported、failed、partial、timeout、cancelled、unsafe、schemaMismatch 全部区分。

### 122. Bridge Capability Discovery

选择：D。

Bridge 返回 resource kind、command、schema、validator、writer capability matrix。

### 123. Parser / Writer 所属语言

选择：C 起步，D 终局。

起步阶段：binary parser / writer 在 C#，resource graph / AI / Patch Engine 在 TypeScript。

终局方向：多语言插件，但核心协议统一。

### 124. Renderer 权限

选择：D。

renderer 永远不直接接触真实路径写入，所有文件操作经 main / Patch Engine policy。

### 125. Main Process 职责

选择：D。

Main 是 policy gate：权限、路径、staging、backup、Bridge、AI tool execution 都在这里受控。

### 126. AI Tool 权限域

选择：D。

AI tool 分级：read、analyze、propose、stage、validate、commit、rollback，每级受 policy 控制。

### 127. AI Tool Result Schema

选择：D。

typed result + evidence refs + confidence + provenance + display hints。

### 128. AI Evidence Pack

选择：D。

normalized evidence pack：resource URI、fields、references、diagnostics、confidence、provenance、patch history、user notes。

### 129. AI Plan

选择：D。

executable-but-gated plan：每步工具、前置条件、预期证据、失败策略、用户确认点。

### 130. Agent Loop

选择：D。

observe -> plan -> tool -> verify -> revise -> patch -> validate -> commit / rollback。

## 131–140：Agent 策略、诊断、日志、恢复、VFS

### 131. Agent Retry

选择：D。

retry budget 按风险、资源类型、验证失败原因动态分配。

### 132. Full-permission Policy Gate

选择：D。

综合策略：工具、资源、影响范围、confidence、validator coverage、用户历史授权。

### 133. 用户确认数据结构

选择：D。

confirmation receipt：确认项、时间、用户、风险、证据、policy gate 结果全部记录。

### 134. Diagnostics 生命周期

选择：D。

diagnostics 可被 patch 消除、抑制、引用、进入 AI context 和历史趋势。

### 135. 日志分层

选择：D。

audit log：用户动作、AI 动作、tool calls、patch、验证、commit、rollback 全链。

### 136. 隐私与遥测

选择：C。

用户手动导出脱敏报告。早期不做默认遥测。

### 137. Crash Recovery

选择：D。

crash recovery wizard：恢复 staging、回滚、重建索引、导出错误报告。

### 138. File Watcher

选择：D。

监听外部修改、检测冲突、更新 overlay / resource graph、保护未提交 patch。

### 139. 并发编辑锁

选择：D。

transaction lock：资源、容器、overlay、patch operation 统一锁定。

### 140. Virtual File System

选择：D。

完整 VFS：真实文件、overlay、container child、semantic symbols、generated views 统一浏览。

## 141–150：Container、Cache、Schema、Profile、Plugin、外部工具

### 141. Container Child 写入路径

选择：D。

container graph patch：多个 child、nested container、semantic refs 一起事务化。

### 142. Nested Container

选择：D。

nested VFS path + recursive validation + partial extraction cache。

### 143. Cache

选择：D。

content-addressed cache：envelope、decompressed payload、child inventory、semantic export、reference graph 分层缓存。

### 144. Cache 清理

选择：D。

workspace cache manager：可视化占用、按资源清理、保留关键 restore point。

### 145. Schema Diff

选择：D。

schema diff 参与迁移、patch compatibility、AI 解释和 validator。

### 146. Profile 继承

选择：D。

profile inheritance graph：engine family、game、version、mod override 多层继承。

### 147. Profile Package

选择：C 起步，D 终局。

起步：manifest + schemas + icons + parser hints。

终局：signed / verified profile package，包含版本、依赖、迁移、测试 fixtures、capabilities。

### 148. Plugin Sandbox

选择：D 作为目标，B / C 作为实现阶段。

终局：插件沙箱，权限声明、tool API、UI extension、validator extension，禁用裸文件写。

实现阶段：先从 profile 数据和 viewer / parser hints 开始。

### 149. 外部工具 Adapter

选择：C 起步，D 远期。

起步：可手动调用外部工具做对照。

远期：adapter sandbox，声明输入输出、只读 / 写入权限、结果进入 provenance。

核心实现仍必须重写，不复制外部工具代码。

### 150. Smithbox 参考范围

选择：D。

建立行为对照测试，但不复制代码和视觉风格。Smithbox 可参考资源组织、workflow、profile/base/overlay 思路。

## 151–160：UI 架构、编辑器、图、事件、脚本、AI Code Action

### 151. UI Layout State

选择：D。

每个工程保存布局、打开资源、AI 会话、patch review 状态。

### 152. Editor Tab Model

选择：D。

tab 绑定 resource URI、patch state、preview mode、AI context。

### 153. Resource Editor Component Architecture

选择：D。

schema-driven + custom editor 插件 + patch binding。

### 154. Table Editor

选择：D。

大表虚拟滚动、公式 / 规则、批量 patch、AI 生成变更。

### 155. Graph UI

选择：D。

graph rendering abstraction，支持 patch graph、reference graph、event graph 多图复用。

### 156. Event Graph

选择：D。

event graph：event calls、flags、conditions、regions、params、text 全链可视化。

### 157. Param 批量编辑表达式

选择：D。

typed formula + preview + constraints + AI explain + rollback。

### 158. Script Language Service

选择：D。

LSP-style service：diagnostics、rename、refactor、AI code action。

### 159. AI Code Action

选择：D。

在 editor 中直接出现“修复 / 重构 / 解释 / 生成 patch”按钮。

### 160. 帮助系统

选择：D。

AI help：根据当前资源、diagnostics、profile schema 解释字段和风险。

## 关键硬边界

1. D 级目标是架构方向，不等于 Codex 现在可以跨越 v0.3 直接实现。
2. 所有写入必须经 Patch Engine、staging、validation、backup、audit log、rollback。
3. renderer 不能直接写真实文件。
4. 插件和外部工具 adapter 不能绕过 policy gate。
5. Smithbox 只作为行为、资源组织和 workflow 对照，不作为源码或视觉模板。
6. AI tool 的 commit / rollback 权限必须受 policy gate 控制。
7. Parser 的 confirmed 结果必须有 provenance；synthetic fixture 不能冒充 native format authority。
