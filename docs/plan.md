# SoulForge Agent 驱动约束规格

**本文不承载范围、进度、authority 或任务口径。**

- 范围与进度的唯一权威是 `docs/governance/*.json`,选点入口是 `node scripts/gov.mjs next`。
- 技术地形图是 `docs/V0_5_IMPLEMENTATION_HANDOFF.md`(其治理区块是上述 JSON 的投影)。
- 机械化执行循环是 `docs/AGENT_EXECUTION_PLAYBOOK.md`。

本文只固定一件事:**让 coding agent 能独立、稳定推进而不需要人介入,必须满足哪些约束。**
每条约束都由实测失败推导出来,不是设计偏好。违反其中任何一条,agent 会在没有人察觉的
情况下沿错误方向空转。

---

## 1. 入口约束

**agent 的第一条命令必须是 `node scripts/gov.mjs next`,不是通读交接书。**

实测:`gov next` + `gov help` 合计不到 10 KB 就含齐选点、入口、硬前置、所需验证与流程骨架;
交接书 400+ KB,读完仍不知道哪条切片可 claim(那由 `slices.json` 的 lifecycle 决定)。
量级差 50 倍上下。

**本文刻意不写死这几个字节数。** 交接书每次 seal 都追加证据因而持续变长(首版量到 48.5 倍,
两次提交后同样的量法就成了 53.2 倍),写死的绝对值会静默腐烂,而"文档里的数字必须是实测值"
正是第 8 条要求的。需要当前值时自己量:

~~~powershell
$enc = [System.Text.Encoding]::UTF8
$cli = $enc.GetByteCount((node scripts/gov.mjs next | Out-String)) +
       $enc.GetByteCount((node scripts/gov.mjs help | Out-String))
$doc = (Get-Item docs/V0_5_IMPLEMENTATION_HANDOFF.md).Length
Write-Output ("CLI=$cli B  交接书=$doc B  倍数=" + [math]::Round($doc / $cli, 1))
~~~

量法本身也有坑:`node -e` 里写模板字符串在 PowerShell 下会被反引号转义吃掉(实测报
`SyntaxError: missing ) after argument list`),所以上面用 PowerShell 原生写法。
`wc -c` 与 `GetByteCount` 差约 800 B,因为 `Out-String` 会补 CRLF——量级结论不受影响。

门禁:`HANDOFF_ENTRY_NOT_CLI`(交接书开头 60 行内必须给出该命令)、
`HANDOFF_STALE_AUTHORITY_CLAIM`(不得声明交接书为唯一事实源)。

## 2. 自足性约束

**`gov next` 的输出必须自带完整闭环**,agent 拿到切片后不需要回文档找"接下来干什么"。

必须包含:`goal`、`hardPrerequisites`、`entryPoints`、`requiredValidation`、`authorityCap`,
外加 claim → 实现 → 验证 → 封存 → complete 的 `workflow` 骨架。

推论一:凡"方向对但不到位"的指引都要补全,不能停在"去某个文件里找"。
实测例:deferred 切片的出路本来只说"去 `scope.json` 找 `resumeRequires`",而 V0.6 的 3 条
切片对应 12 个 scopeItem,靠 `capabilityId` 反查是每个 agent 都要重做一遍的活。现在直接投影。

推论二:**状态相同但结论相反的两种情形,输出里必须能区分。** 否则 agent 会一致地选错那一边。
实测例:被遗弃的 claim 与真有人在推进的 claim 此前都只显示 `sliceId` + `owner`。5 条
`coordinator-agent` claim 心跳停在 2026-08-01(其后 24 个提交全在治理层、没有一个碰过这些
切片的 `entryPoints`),接手的 agent 一律读成"有人在做"而避开,V0.5 可 claim 面被无声压到 4 条,
且没有任何门禁会因此转红。现在 `activeSlices` 带 `heartbeatStale`/`staleFor`/`recoveryHint`。

该修法本身也受第 4 条约束:CLI **不自动释放** claim,只给出"先按 `recoveryTrigger` 核实,
再 release 或 complete"。误报比漏报危险——擅自释放会撞上另一个真在跑的进程。同理心跳不可
解析时判为未知而非陈旧,不让格式问题冒充协作问题。推进期间用 `gov heartbeat` 刷新即可。

门禁:`cli/next-item-self-sufficient`、`cli/next-includes-workflow`、
`cli/next-release-<id>-deferred-projected`、`cli/next-stale-claim-flagged`、
`cli/next-fresh-claim-not-flagged`、`cli/next-unparsable-heartbeat-not-flagged`。

## 3. 引用真实性约束

**文档与治理数据里形如可执行/可打开的东西,必须真的可执行、可打开。**

- `npm run X` → X 必须在 `package.json`(`NPM_SCRIPT_MISSING`)
- `node scripts/<名>.mjs` → 文件必须存在(`NODE_SCRIPT_MISSING`)
- `gov <子命令>` → 必须被 CLI 接受(`GOV_SUBCOMMAND_MISSING`)
- 切片 `entryPoints` 中形如路径的条目 → 必须能直接打开(`SLICE_ENTRYPOINT_UNOPENABLE`)

`entryPoints` 允许叙述性条目(「Bridge EMEVD/MSB writer」),那不是缺陷;门禁只判
"形如路径却打不开"。状态标注不得拼进路径——实测 `TaeNativeDocument.cs（延期）` 文件存在,
但 agent 照着打开必然失败,而失败长得跟"文件不存在"一模一样。

## 4. 诊断约束(最高优先级)

**指向错误原因的诊断比没有诊断更糟。** agent 会照着它往错误方向修,永远收敛不了,
而每次尝试都消耗一整轮上下文。

一条诊断必须同时满足:

1. 指名具体对象(哪个文件、哪个字段、哪个 ID),不能只说"校验失败"
2. 给出的下一步动作**真能解决问题**
3. 不把 agent 引向错误方向

实测修过的误导型诊断:

| 诊断原文指向 | 真实原因 |
|---|---|
| `GATE_EVIDENCE_STALE`「相关主题域发生变化」 | `--subject` 漏了目标 Gate 的 `user-approved` 继承标记 |
| 空候选时「按 `blockers.json` 解阻塞」 | 切片是 `deferred`,`blockerRefs` 全为空数组,出路在 `scope.json` 的 `resumeRequires` |
| 投影分叉时「运行重新生成」 | `core.autocrlf=true` 导致行尾差异,重跑生成后 `git diff` 输出 0 行 |

因此:凡新增失败路径,诊断必须在**实测的失败场景下**读一遍,确认它指的是真实原因。

## 5. 门禁有效性约束

**每个新门禁必须用负例证明它会红。** 实测约一半看起来合理的门禁,在被测坏之前一直报绿。

加完门禁立刻三步:

1. 改坏被保护的对象
2. 跑门禁确认 `exit=1`,且**诊断指名真实原因**
3. 恢复并确认 `exit=0`

四种已实测的假门禁形态:

- **只迭代自己的清单**:登记表门禁只遍历表内四条路径,从不扫仓库。往第五个文件加 marker 仍报 2973 项全绿。门禁必须*扫描*并与权威*双向*比对。
- **只读副本**:`verify-release-scope.mjs` 只解析交接书里的内嵌 JSON,从不读 `docs/governance/scope.json`,27 条 scopeItem 分叉数周而门禁全绿。
- **判据形态与被检对象错位**:`entryPoints` 门禁用 `/\.(ts|cs)$/` 判形态,而坏数据 `.cs（延期）` 的扩展名不在串尾,行尾锚点不匹配,被当叙述性入口放过。同类:`gov` 子命令门禁读 `COMMANDS` 键,漏掉走 dispatch 显式分支的 `help`,把**正确**的引用报成错。
- **fixture 扰动未还原**:见下条。
- **拿执行面板状态当场景前提**:判据依赖 `lifecycle=active`、`activeClaims` 非空这类会被正常 `gov release` 清空的状态。面板一变,要么**误红**(前提消失被报成规则失效),要么**静默失覆盖**(整段被跳过,`checks` 总数只是变小,没有任何门禁转红)。后者更危险——它看起来一切正常。实测释放 5 条被遗弃 claim 后连锁暴露 4 处,全部潜伏已久:`complete` 成功路径段整段跳过(4 条断言含刚修好的还原断言一条不跑)、心跳陈旧段报「无法构造场景」、`active-slice-needs-exactly-one-claim` 靠清空 `activeClaims` 制造违规而没有 active 切片时清空本就合法、markdown 门禁无条件要求 §13.1.1 有表而投影器在空态时按设计输出散文(两条路径此前从未同时成立)。修法:场景前提自己构造,并把快照取在构造动作之前,让还原一次撤掉扰动与自造状态。

推论:负例要用**仓库里实际存在的那条坏数据**,不能自己构造一条形态标准的。

## 6. Fixture 隔离约束

**为构造负例而改坏的数据,必须在断言结束时还原,并加一条断言锁定还原成功。**

实测后果:`verify-gov-cli-fixtures.mjs` 有段"后置校验回滚"场景把某切片 `authority` 改成
超 cap 却从不还原,导致其后**每一条** seal 断言都跑在已违规数据上。`SEAL_POSTCHECK_FAILED`
恒成立,正向分支 7 条断言一次都没执行过,而负向断言是"数据本来就红"才通过的。
fixture 报"全部通过 63 项",看不出任何异常。

**正向路径与失败路径不能共用一个 `if (ok) {...} else {...}`。** 两分支互斥,靠"环境碰巧
走哪边"声称覆盖两种结局是假覆盖。修好锚点让正向可达后,else 分支立刻变成死码——这本身
就是证明。每种结局要各自显式构造。

**负例还要核对失败原因。** 实测:第一版扰动加了个 schema 不允许的新字段,seal 确实失败,
但 `errors` 是 `GOVERNANCE_SCHEMA_VIOLATION` 而非 stale——断言为错误原因通过。改为扰动
schema 允许的既有字段,并加断言核对 `errors` 含 `STALE`/`FRESHNESS` 且不含 `SCHEMA_VIOLATION`。

判断断言是否真跑过:加一条新断言后看 check 总数是否涨了预期条数。**数目不涨就是没执行。**
不确定时插桩 `console.error` 打印分支与 payload(临时脚本 `scripts/_probe*.mjs`,用完删)。

## 7. 封存与事实源一致性约束

治理事实源已外置为 `docs/governance/*.json`。交接书 `SOULFORGE_PROJECTION_BEGIN/END`
标记内的区块是它们的投影。

- **不得手写标记内的区块**——会被投影门禁判为分叉,或另立一份无人校验的进度口径。
- 证据只用 `node scripts/gov.mjs seal` 封存(它原子完成写证据 + 挂 Gate + 重投影)。
- **改了主题域文件要先提交再 seal**:指纹锚点是 HEAD,未提交的改动会算进
  `trackedDiffSha256` 但不进 HEAD,锚点之后仍显示有变化。
- **seal 写文件但不提交。** 它现在会在成功输出里报 `uncommittedAfterSeal` 与 `nextStep`。
  实测漏过一次:seal 写了 `evidence.jsonl`/`gates.json`,随后的提交只带了交接书散文,
  两个 JSON 悬在工作区,而输出只说 `governanceGate: passed`。

seal 四步(缺任一步会撞上指向错误原因的 `GATE_EVIDENCE_STALE`):

1. 先提交主题域改动
2. `--gates` 指定要恢复的 Gate(freshness 只判定该 Gate 引用的 `evidenceRefs`)
3. `--subject` 带 `revalidates=<既有EvidenceId>` 继承用户批准
4. `--subject` 原样带齐目标 Gate 现有证据声明过的 `user-approved` 标记

**CLI 绝不自动补 `user-approved` 标记**——那个标记的含义是"用户批准了",CLI 写它等于伪造裁定。
只报告缺哪个。

## 8. 诚实性约束

- 没运行过的命令、没读过的文件、没验证过的结论,必须明确说明。
- `unsupported` / `candidate` / `fixture-confirmed` / `partial` / `native-verified` /
  `blocked` / `unverified` 严格区分。
- `skipped`、fixture 通过、失败关闭的测试,都不能写成完整 native authority。
- claim / complete 只改执行面板状态,**不提升 authority**。authority 提升必须另有真实运行的
  验证支撑。

## 9. 最低回归

```powershell
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
```

治理层单独一次跑完:`node scripts/verify.mjs --tier governance`(当前 16 项)。

涉及本机真实资源时按根 `package.json` 跑对应 native smoke。

---

## 附:待处理项(不构成范围口径)

以下是已定位但本轮未处理的技术债,记录位置以免丢失。真实优先级由 `gov next` 决定。

- `.gitattributes` 无行尾策略且被 gitignore,是投影行尾问题的根因。改动 blast radius 是
  全仓 checkout,需单独裁定。
- 项目级 `CLAUDE.md` 被 gitignore(`.gitignore:17`),其指引不进新克隆;tracked 对应物是
  `docs/AGENT_EXECUTION_PLAYBOOK.md` 与本文。
- 临时目录泄漏台账尚有 18 项存量欠债(`npm run test:smoke-temp-cleanup` 守着,只允许缩小)。
- 部分 native smoke 的资源释放不在 `finally` 中,异常路径可能泄漏 bridge 句柄。
- 5 条 `owner=coordinator-agent` 的在飞 claim **已按 `recoveryTrigger` 核实并全部 release**
  (2026-08-02):无任何指向本仓库的 node/dotnet 写进程;工作树 0 改动、无 stash、单工作树;
  对 5 条切片各自的 path-like `entryPoints` 跑 `git log --since=2026-08-02` 全部无提交。
  `authority` 未被改动(release 不撤销也不追加验证结论),V0.5 可 claim 面从 5 条恢复到 10 条。
  释放本身连锁暴露 4 处「拿面板状态当前提」的假门禁,已一并修好并各自用负例证明。
  下次遇到 `heartbeatStale=true` 仍按同样顺序核实,**不要不核实就批量 release**。
- 4 条分支未合并到 main,均为历史快照且各自领先 1~2 个提交:
  `backup/local-ahead-225c08d`、`codex/v05-current-project`、`codex/v05-worktree-publish`、
  `worktree-v05-open-format-import`。按用户裁定**保留不删、不推 origin**;
  main 领先 `origin/main` 150 个提交也按裁定不推。worktree 已只剩主工作树。

