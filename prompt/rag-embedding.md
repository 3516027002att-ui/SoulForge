# SoulForge RAG embedding 协议

这是给 Agent 的 RAG 运行约束。默认检索不依赖 embedding；embedding 由 SoulForge 内部自动管理，用户不需要也不应被要求单独配置模型、服务或索引。

## 用户与 Agent 的边界

- 未启用 RAG 时，不要要求用户填写 `embeddingModel`、选择向量模型、安装 Ollama 或手工生成向量索引。
- 不要把当前聊天模型名当成 embedding 模型名，也不要猜测某个服务支持 `/v1/embeddings`。
- Agent 只需正常调用工作区搜索工具；embedding 后端、模型版本、缓存和索引生命周期始终由 SoulForge 主进程负责。
- 不要因为语义向量暂时不可用就把用户重新引导到模型配置；系统应自动使用词法、结构化和原生索引路径。

## 后端选择顺序

SoulForge 按以下顺序选择后端：

1. 默认先用内存中的词法、结构化 ID 和引用索引；这条路径不要求 embedding 表、模型文件、网络或额外服务，是没有 embedding 时的主路径。
2. 工作区原生分析完成且内部资源可用时，由 SoulForge 自动使用内置 embedding 后端；模型资源和索引元数据放在应用数据目录，不放入 Mod 工作区。
3. embedding 未配置、未就绪、资源下载失败、运行时不可用、语料过大或任务被取消时，立即保留/回到词法 + 结构化检索；降级必须有可见诊断，不能伪装成语义命中。

建库和查询必须使用同一个后端身份：模型标识、模型 revision、向量维度、归一化方式和 chunker revision 任一不匹配，都必须丢弃旧向量并重新生成，不能混用不同模型的向量。

## 索引生命周期与资源限制

- 只有启用 RAG 后，工作区完成原生分析才可以在后台建立向量索引；首次查询不得等待向量建库、重新扫描工作区或执行 recovery cleanup。即使后台建库从未完成，搜索也必须立即使用词法/结构化路径。
- 只对 source hash/revision 发生变化的 chunk 增量生成向量；重复刷新必须合并，旧任务可取消。
- embedding 任务运行在受控 worker/队列中，单 worker、有限批次、有限并发，并在批次之间让出 CPU；禁止每个 Agent 步骤都生成一遍 query vector。
- 查询不得为了确认“有没有 embedding”读取整张向量表；向量由后台任务恢复到内存后才参加融合，未恢复时直接纯 lexical。
- 自动向量只覆盖 `event`、`map_entity`、`param_row`、`text_entry` 四类语义对象；`file`、`map_region`、`tae_event` 仍由词法/结构化检索覆盖。
- 可向量化对象超过上限时，不启动大规模推理，直接使用词法/结构化检索。
- 当前会话的 query vector 可以缓存；工作区切换、模型 revision 变化或 source revision 变化时必须失效。
- 向量写入失败、返回数量不完整、维度不一致或任务被取消时，不能把部分结果标记成完整索引。

## 可用性与证据边界

- RAG 语料生成后必须报告 `event`、`map_entity`、`param_row`、`text_entry` 等语义家族计数和诊断。
- 这四类语义家族全为零时，RAG 必须标记为不可用；空结果不能被 Agent 解读为“对象不存在”。
- 向量或词法命中都只是候选证据。Agent 仍须沿稳定的 `sourceUri`、原生身份、`sourceHash/sourceRevision` 和任务记录继续确认。
- RAG 不能替代任务记录、C# Bridge 原生读取、Patch Engine、审批、事务、回读和回滚门禁。
