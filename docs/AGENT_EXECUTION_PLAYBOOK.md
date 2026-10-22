# SoulForge 执行手册：CLI 与真实 Agent 验证

工程入口是 [AGENTS.md](../AGENTS.md)：合并前运行 `npm run gate`，读取是否正确用 `node compare/run.mjs` 和成熟参考工具对比。模块归属见 [ARCHITECTURE.md](../ARCHITECTURE.md)；Agent 的共享 assembly、有限控制内核与 headless 路径见 [AGENT_RUNTIME.md](AGENT_RUNTIME.md)。

本文只保留实际工具调用、分页、隔离工作区、结果解读与排障说明；参数以当前 `--help` 和执行结果为准。旧执行流程（切片认领、gov seal、治理 JSON、Gate 与 Evidence freshness）已退役，原第 0–9 节随之删除，历史版本在冻结分支 `archive/pre-v2`。下文沿用原来的第 10 节编号。

<a id="agent-tool-validation"></a>

## 10. CLI 与真实 Agent 验证

本节是工具调用和模拟运行的操作入口，不记录某次任务进度。命令均从仓库根执行；不要把 `--help`、工具注册成功或 EXE 构建成功当作真实任务通过。真实 Agent 模型请求需要明确的凭据使用授权和费用预算；写入仍受当前工具权限、原生能力及事务边界约束。

### 10.1 先选正确入口

| 需要回答的问题 | 入口 | 不代表什么 |
|---|---|---|
| 某个生产工具的搜索、关联、读取或分页是否正常？ | `node tools/soulforge-cli/sfcli.mjs` | 不代表模型会正确调用它，也不是桌面 UI 验收 |
| 模型能否经生产宿主完成原始修改任务？ | `npm run agent:simulate`，默认 `unpacked` | 不代表已安装应用通过 |
| 已安装的 SoulForge 是否能跑通同一链路？ | 模拟脚本的 `--runtime installed --exe ...` | 不是仓库根启动器测试，也不等于签名、更新、安装生命周期验收 |

CLI 是 Node 脚本，不是独立测试 EXE。`unpacked` 使用仓库或显式生产产物快照中的 `production-main.mjs` 驱动 Electron；`installed` 使用指定的**实际安装版应用 EXE**。仓库根 `SoulForge.exe` 是开发启动器，`SoulForge.Doctor.exe` / `SoulForge.Launcher.exe` 是诊断、环境入口，均不能冒充 installed smoke 的应用 EXE。

开始前检查 `git status --short`、`git rev-parse HEAD`，确认运行目录、代码、依赖和编译产物一致；不要覆盖其他任务的未提交改动。工具链与依赖安装见 [README](../README.md)。CLI 加载 `packages/core/dist` 等编译产物：相关源码改变后构建受影响包，跨包改变运行 `npm run build`；需要刷新可执行产物时按项目规则运行 `npm run exe:build`。输入未变时复用有效构建，不为每次读取重复构建。

只查看帮助，不启动工作区、Electron 或模型任务：

```powershell
node tools/soulforge-cli/sfcli.mjs --help
node scripts/run-real-agent-gyoubu.mjs --help
```

`npm run agent:simulate -- --help` 仍会先触发 npm 的 `preagent:simulate` 构建检查。仅核对参数时使用上面的直接 Node 命令。当前参数以脚本帮助及实现为准，不把本文示例 ID、工具数量、时限写成全语料保证。

<a id="cli-validation"></a>

### 10.2 CLI：搜索 → 关联 → 原文 → 跨进程续页

以下示例使用 PowerShell 7.3+；`--stdin` 避免 JSON 的引号和中文被原生命令行转义破坏。先输入本机路径，不把私有 Mod 路径写进公共示例：

```powershell
Set-Location (git rev-parse --show-toplevel)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSNativeCommandArgumentPassing = 'Standard'
$Workspace = Read-Host 'Mod 工作区目录'
$GameRoot = Read-Host '游戏根目录（包含所需解包内容和原生依赖）'
if (!(Test-Path -LiteralPath $Workspace -PathType Container)) { throw '工作区不存在' }
if (!(Test-Path -LiteralPath $GameRoot -PathType Container)) { throw '游戏根目录不存在' }
$Cli = Join-Path (Get-Location) 'tools/soulforge-cli/sfcli.mjs'
$CliArgs = @('--workspace', $Workspace, '--base', $GameRoot, '--mode', 'plan', '--json', '--quiet')
node $Cli @CliArgs list
node $Cli @CliArgs describe search_param_rows
node $Cli @CliArgs describe find_references
```

- `--workspace` 必填；原生读取应提供正确的 `--base`。默认 CLI mode 是 `normal`，本节明确用 `plan` 进行只读/分析验证。
- `list` / `describe` 默认只做元数据入口准备；显式 `--analyze` 可请求分析。**`call` 及搜索、读取快捷命令默认会自动请求分析**，不应再理解为“只有加 `--analyze` 才分析”；对 `list_operations`、`rollback_operation` 等不依赖语义索引的维护调用，可显式加 `--no-analyze`，避免恢复操作被无关全量分析拖慢。请求分析不等于全量索引已完成；应检查工具结果中的覆盖与诊断。
- `--quiet` 隐藏进度，不隐藏缓存、审计降级等重要 stderr 警告；不要用 `2>$null` 丢掉它们。stdout 是工具 JSON，stderr 应单独保留。
- `search-param` / `read-param` 是快捷入口；复杂参数、游标和机器调用优先用 `call --stdin`。`read_param_fields` 的 `pageSize` 在 native 读取结果层生效，不是把完整结果返回后再截断；返回的 `fieldDefinitions`、`pagination`、`execution`、`scan`、`page`、`evidence` 必须一起保留。续页时只传原请求条件和 opaque `cursor`；cursor 绑定工作区、来源版本、表、物理行集合和字段集合。

CLI 回滚是显式宿主授权，不是模型参数：`fullPermission` 只允许工具进入回滚门禁，不能替代用户确认。启动 CLI 时必须额外提供绑定当前 workspace 和单个操作 ID 的一次性凭据：

```powershell
node $Cli --workspace $Workspace --base $GameRoot --mode fullPermission `
  --confirm-rollback $OperationId --json --quiet call rollback_operation `
  ('{"opId":"' + $OperationId + '"}')
```

`--confirm-rollback` 只在启动参数中接受，不能放进工具 JSON 伪造；缺少它返回 `EDIT_CONFIRMATION_REQUIRED`，操作 ID 或 workspace 不匹配返回 CLI 授权错误，成功消费后重放返回 `CLI_ROLLBACK_CONFIRMATION_REPLAYED`。长驻 `session` 或独立 session host 必须在启动宿主时提供同一参数；不要通过后续控制帧或模型消息补发确认。每个凭据只能消费一次，失败关闭也不得自动重试回滚。

事件搜索的全局索引候选不等于全部原生事件；检查 `coverage`，不要把 `indexed-event-candidates` 的命中或零命中当成完整结论。定位资源后可调用 `search_events {file, query, limit}`，在指定 EMEVD 源内按指令名或数字检索，续页保留相同 file/query 和 opaque cursor；此时完整性仅针对所选文件。传输层不能丢弃页内记录后继续使用原下一页游标；预算不足时应按错误中的动作缩小当前窗口重试。

`search_param_rows` / `search_text_entries` 也允许使用**当前页的原 cursor** 并减小 `limit` 重试；查询、表范围、工作区和快照版本仍须匹配。不要使用错误中的下一页 cursor 跳过未交付结果。旧游标先按原快照校验，续页转为与窗口大小无关的新快照游标。

PARAM 搜索候选中的 `fieldPreview` 只是有界预览，`fieldsComplete=false`，不是整行原生值。`readAction.scope=preview-fields` 只读取列出的真实字段；需要其他字段时，用同一 table/rowIds/containerPath 调用 `search_param_fields` 定位字段，再用 `read_param_fields` 读取。不要把预览字段缺失当作该参数没有相应能力。

`read_param_fields` 的游标使用固定长度请求范围摘要，不复制文件路径和全部 fieldIds；摘要仍绑定工作区、来源、请求及物理字段顺序。续页必须回传原始 table/rowIds/fieldIds/containerPath，可减小 pageSize；`fieldDefinitions` 只包含本页实际字段，后页定义随对应字段交付。旧的长范围游标在原请求与源哈希校验后转换为短游标；不要修改旧请求的字段或行顺序。

各工具的逻辑页大小与源码窗口限制仍独立存在。

EMEVD 写入回执保留 `opId`、输出哈希及原生读回结果。空计划为 `state=completed`、`transactionStatus=noop`，不是提交；事务已落盘但后续读回失败为 `state=verification_failed`、`transactionStatus=committed`，必须检查原生资源及操作记录，不能按普通未写入失败盲目重试。无变化的计划不应触发知识刷新或使读取凭据失效。

独立 `.hks` / `.lua` 源码可用 `read_hks_script {file, sourceLimit}` 分页读取；`search_hks_script {file, query, limit}` 提供区分大小写的精确文本定位和原文读取动作。字节码仅通过 Bridge 读取，游标绑定源版本；这些都是只读源码证据，不产生写入授权，也不证明游戏运行行为。二进制未知布局、容器、路径越界和超时均失败关闭。

定义一个每次都启动新 CLI 进程的只读调用函数：

```powershell
function Invoke-SoulForgeTool {
    param([string]$Tool, [object]$InputObject)
    $json = ConvertTo-Json -InputObject $InputObject -Depth 32 -Compress
    $raw = $json | node $Cli @CliArgs call --stdin $Tool
    if ($LASTEXITCODE -ne 0) { throw "工具失败：$Tool；检查 stdout 和 stderr：$raw" }
    $response = ($raw -join "`n") | ConvertFrom-Json
    if (!$response.ok) { throw ($response.error | ConvertTo-Json -Compress) }
    return $response
}

当同一工作区需要连续调用多个工具时，优先使用长驻 `session`，不要为每个工具重复打开 Node/Bridge/索引：

```powershell
$SessionArgs = @('--workspace', $Workspace, '--base', $GameRoot, '--mode', 'plan',
    '--json', '--quiet', '--diagnostics', 'session')
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = 'node'
$SessionArgs | ForEach-Object { [void]$psi.ArgumentList.Add($_) }
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$p = [Diagnostics.Process]::Start($psi)

$p.StandardInput.WriteLine((@{
    id = 'search-1'; tool = 'search_param_rows';
    args = @{ query = '鬼型部'; paramNames = @('NpcParam'); limit = 4 }
} | ConvertTo-Json -Compress))
$p.StandardInput.WriteLine((@{
    id = 'status-1'; tool = '__host_status'; args = @{}
} | ConvertTo-Json -Compress))
$p.StandardInput.WriteLine((@{
    id = 'close-1'; tool = '__host_close'; args = @{}
} | ConvertTo-Json -Compress))
$p.StandardInput.Close()
$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw "session failed: $stderr" }
($stdout -split "`r?`n" | Where-Object { $_ }) | ForEach-Object { $_ | ConvertFrom-Json }
($stderr -split "`r?`n" | Where-Object { $_ }) | ForEach-Object { $_ | ConvertFrom-Json }
```

`session` 每行读取一个 `{id,tool,args}` JSON 请求，并在 stdout 返回同一个 `id` 的 JSON 响应；工具执行在同一 `CoreToolSession` 内串行、去重，但状态/取消控制帧不会排在长 native 调用之后。`__host_status`、`__host_request_status`、`__host_cancel` 和 `__host_close` 仅是本地会话控制帧，不进入 ToolRegistry。取消状态必须按 `queued → running → cancel_requested → cancelled` 观察；发送取消请求不等于 native 工作已经停止，迟到结果会被丢弃。`--diagnostics` 将工作区打开、scan、缓存、分析、native read、关联内容扫描、关系页和工具耗时以 JSON Lines 写到 stderr；即使使用 `--quiet`，显式诊断也会保留。工具被取消时，tool 阶段诊断的公开 `code` 固定为 `CLI_REQUEST_CANCELLED`；若底层工具已经返回另一个失败码，该码仅保留在 `underlyingCode`，避免把工具内部失败误报成会话生命周期状态。stdout 与 stderr 必须分开保存，不能把诊断行当成工具结果。

对长调用可并发写入一条控制帧（`requestId` 是正在执行的请求 ID），再按返回的 `state` 决定是否继续等待：

```powershell
$p.StandardInput.WriteLine((@{ id = 'cancel-1'; tool = '__host_cancel'; args = @{ requestId = 'slow-1' } } | ConvertTo-Json -Compress))
$p.StandardInput.WriteLine((@{ id = 'status-1'; tool = '__host_request_status'; args = @{ requestId = 'slow-1' } } | ConvertTo-Json -Compress))
```

$search = Invoke-SoulForgeTool 'search_param_rows' @{
    query = '葫芦种子'; paramNames = @('EquipParamGoods'); limit = 4
}
$search.data.record.matches | ForEach-Object { $_.item } |
    Select-Object uri, sourceUri, entryIndex, paramName, rowId, rowName
$TargetUri = Read-Host '从结果中选择准确的 uri（保留完整 scheme，不根据同名自行拼接）'
$refs = Invoke-SoulForgeTool 'find_references' @{
    uri = $TargetUri; direction = 'both'; detail = 'context'; depth = 2; limit = 2
}
$refs.data.record.relations | Select-Object content, location, reason, certainty, readAction
```

查询词只是本机只狼语料示例；未命中时换成当前工作区的真实对象，不硬编码期待的行号。同名文本与参数不能自动视为直接引用。默认不包含低置信候选；确需查看同名、数字巧合等候选时加 `includeHypotheses = $true`，保留候选标记，不把它们当作确定调用。

从返回关系读取具体内容，再使用原关系游标续页：

```powershell
$relation = $refs.data.record.relations | Where-Object { $_.readAction } | Select-Object -First 1
if (!$relation) { throw '当前页没有可展开关系；检查 resolution、coverage、diagnostics 和 scan' }
$action = $relation.readAction
$ReadTools = @('read_param_fields', 'read_fmg_entries', 'read_emevd_event', 'read_luabnd_script', 'analyze_luabnd_script', 'analyze_tae_structure')
if ($action.tool -notin $ReadTools) { throw '先 describe 并确认这个读取入口，不盲目执行未知动作' }
$read = Invoke-SoulForgeTool $action.tool $action.args
$read.data.record

# 函数内重新启动 node；因此这里确实检验跨进程，而不是同进程缓存。
if ($refs.data.record.page.nextCursor) {
    $next = Invoke-SoulForgeTool 'find_references' @{ cursor = $refs.data.record.page.nextCursor }
    $next.data.record.relations
}

# 原文过长时，沿原文工具返回的 nextAction 读取下一窗口。
if ($read.data.record.nextCursor) {
    $sourceNext = $read.data.record.nextActions | Where-Object { $_.tool -eq $action.tool } | Select-Object -First 1
    if ($sourceNext) { $readNext = Invoke-SoulForgeTool $sourceNext.tool $sourceNext.args }
}
```

这只是演示下一页，不代表读完全文。需要全文时按该原文工具的续读动作读至结束，检查 offset/returned/total（若返回）、段落连续性和 complete 标志。事件按工具返回的指令窗口续读；不能用外层 `ok=true` 代替完整度检查。

三种续读游标：

字段定义和 Lua 结构也有独立分页边界：`search_param_fields` 保留原 `table/rowIds/query/containerPath`，沿返回的 `nextActions` 续读；`analyze_luabnd_script` 用 `section=functions|goals|branches|constants|calls|unsupportedApis|diagnostics` 选择分区，再沿该分区的 `nextActions` 续读。`sectionCounts` 是各分区数量，一页或单个分区读完不等于整个结构读完，更不代表运行时验证。游标绑定工作区、对象、查询和来源版本，不能跨分区使用。`search_resources` 默认排除备份/恢复产物；明确需要这些来源时用 `sourceFilter=all|artifacts`，不要拿 `.bak` 替代正式来源。

结果 envelope 中 `pagination.truncated` 表示逻辑结果有后页，`pagination.deliveryTruncated` 表示字节预算导致摘要省略细节，后者不承诺存在分页游标；按 `nextActions/nextReadPlan` 恢复细节。`resolve_entity` 摘要保留候选身份，但不能把摘要中的候选升级为修改授权。字段/结构页若单项超预算会明确失败，不返回缺项的“完整”结果。

1. 关联结果 `record.page.nextCursor` → `find_references` 的 `cursor`：当前锁定结果集下一页。
2. `record.scan.sourceCursor` / `scan.nextAction` → 带原查询条件的来源扫描：补齐尚未扫描的来源，再刷新关系。**先读完当前结果页再续扫**，新增来源可能使旧结果快照失效。
3. 原文工具自己的游标 → 同一原文工具：脚本/FMG 正文窗口等，不能传给 `find_references`。

游标保持原样，不绕过 source hash/revision 校验。失效时先确认工作区、查询条件、来源、缓存目录或工具版本是否变化，再重新搜索。`REFERENCE_PAGE_ITEM_TOO_LARGE` 应按诊断缩小窗口/降低 detail 并走原文读取入口；不要把失败页当成功。

`resolution=resolved` 只说明目标已定位；零条关系且 coverage 不完整，不能宣称“没有关联”。`completeness=partial`、`scan.remaining=true`、truncationReason 必须保留。当前关联遍历有节点、来源与边数限制（默认边上限 512）；翻完已生成的结果页仍不等于全图扫描完毕。

<a id="agent-unpacked-validation"></a>

### 10.3 真实 Agent：观察与隔离写入

先确认用户任务或切片需要真实模型链路，并准备游戏语料及已有模型配置。模拟入口会把选定真实 Mod 资源目录复制到临时 overlay；模型凭据放入本次隔离 user-data，不向原始 `mods` 写入。复制的是选定资源目录，不是整游戏/全语料；结果应检查 corpusManifest 的范围与 missingKinds。

```powershell
# 沿用上一节确认过的路径；环境变量作用于当前进程及子进程。
$env:SOULFORGE_SEKIRO_ROOT = $GameRoot
$env:SOULFORGE_SEKIRO_MOD_ROOT = $Workspace
$TestConfig = Read-Host '已有加密 test 配置文件的路径（不要输入密钥内容）'
if (!(Test-Path -LiteralPath $TestConfig -PathType Leaf)) { throw '配置文件不存在' }
$Task = Read-Host '用户原始任务指令'
npm run agent:simulate -- "$Task" --observe --provider test --test-config "$TestConfig" --label observe-task
```

关键区别：

- **当前 runner 在不传 `--observe` 时默认进入写模式**。`--write` 表达显式写入意图，但省略它并不等于只读。不要无参数启动 runner 试探可用性。
- `--observe` 不作任务验收通过声明；与 `--write` / `--apply-overlay` 互斥。观察仍会调用真实模型、产生运行数据，并不等于零副作用的 help。
- 自定义任务如果不是观察模式，必须提供适用的机器目标 `--goals`；不能借用默认任务的 goals 来证明另一个任务。
- 必须显式选择 `--provider test` 或 `--provider vault`（命令行优先于对应环境变量）。`test` 使用受限查找范围中的加密 `test` 文件，推荐显式 `--test-config`；`vault` 要求 `--config-id` 指向**本次隔离 vault** 中已有凭据的服务，不能假定用户日常配置会自动继承。缺配置时应停止，不读取或复制无关凭据。
- 不把配置明文、API key、真实资产或私有报告内容提交到仓库。只有配置路径和配置选择方式进入说明文档。

已有写入验证授权时，下面展示一个**只验证指定字段**的目标格式。表、行和字段必须先在当前语料中查明；示例值不适用于任意 Mod：

```powershell
$FieldTask = '将鬼刑部的忍杀次数改为2'
$Goals = '[{"goalId":"health-bars","kind":"param-field","table":"NpcParam","rowId":50800000,"fieldId":"ninsatuNum","expectedValue":2,"required":true}]'
# 直接 node 传 JSON，避免 npm/cmd 再转义；先做与 npm preagent 相同的构建检查。
node scripts/ensure-agent-production-build.mjs
if ($LASTEXITCODE -ne 0) { throw '生产产物未就绪，停止模拟' }
node scripts/run-real-agent-gyoubu.mjs "$FieldTask" --goals $Goals --write --provider test --test-config "$TestConfig" --label param-field-check
```

PARAM-only goals 即使字段值正确，也不等于自然语言任务整体已验收。完整任务应定义对应的语义终态目标；已有匹配测试清单时，可在确认任务与语料一致后使用 `--testset four-1` 到 `four-4`，不为获得绿色结果改换题目：

```powershell
npm run agent:simulate -- --testset four-1 --write --provider test --test-config "$TestConfig" --label four-1
```

步数、模型请求超时、工作区/预热/会话超时、输出预算可通过当前帮助中的参数设置。不要复制历史默认值当通用门槛；到限应如实报告停止原因，不自动扩大预算或重试付费模型。

<a id="agent-installed-validation"></a>

### 10.4 已安装 EXE 的 Agent 链路

使用已安装应用的实际路径，不使用仓库根 launcher。以下以观察模式检查安装版链路；只有另有任务及写入授权时，才改为合适的 `--write` 和目标验收参数：

```powershell
$InstalledExe = Read-Host '已安装的 SoulForge.exe 完整路径（不是仓库根启动器）'
if (!(Test-Path -LiteralPath $InstalledExe -PathType Leaf)) { throw '安装版 EXE 不存在' }
node scripts/run-real-agent-gyoubu.mjs "$Task" --runtime installed --exe "$InstalledExe" --observe --provider test --test-config "$TestConfig" --label installed-observe
```

这里直接调用脚本，避免 npm 的 preagent 为 installed 测试额外构建本地 unpacked 产物；仍需仓库的脚本依赖。`unpacked` 会检查生产产物 freshness，`installed` 核验指定 EXE 并启动该应用。缺少安装版 EXE 时应报告 `not-attempted`，不回退到 unpacked 冒充通过。运行后检查 report 的 runtime/productionReceipt、实际启动产物身份及停止诊断，不能仅凭存在一个 `.exe` 文件认定安装版有效。

本流程的业务写入对象仍是临时 overlay。运行结束依照报告检查回滚、精确恢复和清理；失败保留的临时目录用于排障，不强杀用户会话，不手动删除未确认已恢复的资源。

<a id="agent-validation-results"></a>

### 10.5 结果、报告与验收边界

模拟报告位于仓库 `output/agent-real/`，包括主 JSON、durable `.rollout.jsonl`，并可能带 `.evidence.md` 等附属材料。普通桌面会话日志在 Electron/SoulForge user-data 的 `agent/sessions/`，不能拿另一次运行的日志拼接成本次结果。CLI 则需由调用方保存参数、stdout JSON、stderr、退出码与耗时；执行面板里的工具卡片不替代原始结果。

验收至少区分：

| 结果 | 正确解读 |
|---|---|
| CLI `ok=true` | 本次工具返回成功；另查 completeness、coverage、候选标记及实际内容 |
| `--observe` | 观察记录，不是修改任务通过；可能返回 `ok=false` / 非零退出码，结合 verificationMode、诊断和报告判断，不能直接归为运行故障 |
| `goalsOk` / 字段匹配 | 指定断言命中；还要检查 goalCoverage、taskCoverageOk、taskCompletionVerified |
| 完整任务通过 | 按当前 report.ok、verdict、rollback、cleanup、durable terminal、超时/页面错误等综合判定；无写入时的 not_applicable 也必须有对应依据 |
| installed 缺失 | not-attempted，不是安装版通过 |
| 构建/fixture/partial | 只声明对应范围，不提升为原生全语料、Gate 或发布完成 |

完整写入链路应包含实际提交操作、原生重读、语义目标验证、回滚及 overlay 精确恢复；仅模型口头说“完成”、某个字段值正确或进程退出码为 0 都不够。缺少旧格式 markdown task record 与缺少 durable rollout/terminal 不是同一问题，依据结构化报告诊断，不自行补造记录。

<a id="cli-cache-troubleshooting"></a>

### 10.6 常见问题与最小验证范围

- **旧编译产物**：CLI 使用 dist，unpacked 模拟使用生产产物；先核对实际运行路径和源码/产物身份，再构建受影响部分。修改某工作树后不要无意调用另一个工作树的 CLI。
- **只会 list/help 不会实际查询**：这只能验证入口/注册表，必须针对任务做真实内容读取或分页检查；不需要因此启动真实模型。
- **`warming_up` / `not_indexed` / partial / source stale**：检查 `--base`、索引覆盖、来源哈希、Bridge 诊断和续扫动作；空结果不是“无关联”。
- **缓存数据库版本高于当前应用**：拒绝降级是安全行为。不要删用户数据库，也不要忽略 `CLI_SEMANTIC_CACHE_UNAVAILABLE` / `CLI_SQLITE_FALLBACK`。无可用持久缓存时，跨进程快照可能无法恢复，不能宣称续页通过。
- **主仓库与工作树版本不同**：需要独立验证时，可为 CLI 子进程使用独立的本地缓存根；不要迁移或降级用户的现有缓存。同一分页链必须保持同一缓存目录、工作区与工具版本。

CLI 缓存默认位于 `%LOCALAPPDATA%/SoulForge/cli-workspaces/` 下的受管目录。以下隔离只作用于当前 PowerShell 及其子进程，最后恢复环境变量；它不修改 Mod 路径，也不是桌面安装版 user-data 的替代方案：

```powershell
$PreviousLocalAppData = $env:LOCALAPPDATA
$IsolatedLocalAppData = Join-Path ([System.IO.Path]::GetTempPath()) ('soulforge-cli-check-' + [guid]::NewGuid().ToString('N'))
try {
    $env:LOCALAPPDATA = $IsolatedLocalAppData
    Write-Output "CLI 隔离缓存根：$IsolatedLocalAppData"
    # 本段仅演示首个查询，不是分页验收；要验证续页，把 §10.2 的完整调用链放在此 try 内。
    # 验证时另行保存各次 stdout、stderr、退出码和缓存根，不在页面之间切换目录。
    Invoke-SoulForgeTool 'search_param_rows' @{ query = '葫芦种子'; paramNames = @('EquipParamGoods'); limit = 2 }
} finally {
    if ($null -eq $PreviousLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue }
    else { $env:LOCALAPPDATA = $PreviousLocalAppData }
}
```

文档修改本身只检查链接、命令/参数、示例 JSON 和行为边界；直接运行两个 `--help` 或纯目标解析检查即可，不默认构建 EXE、打开模型会话或改写 Mod。涉及产品代码时，按实际改动和产品边界选择专项测试、真实 CLI 读取、完整 Agent 或 installed 验证。测试结论写清本次实际执行、未执行和覆盖范围，不把本手册变成并行状态台账。

---

本手册只提供方法，不产生新范围、状态或 authority。当前任务以用户指令、GitHub Issues 和 DECISIONS 为准；执行事实以当前源码、实际测试结果及操作 journal 为准。前述历史治理记录不授予产品写入权限，也不限制当前工程开工。
