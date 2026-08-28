# 交接提示词（把下面整段给下一位 agent）

---

## 0.0 当前续接状态（2026-08-28，优先于下文历史现场描述）

本轮已经完成了原先要求先向用户确认的两项裁定，下一位 agent 不要重复提问：

- 用户选择「修改文档 + `scripts/verify-private-native-gate.mjs`」，并选择「A0 先修信任根」。
- 用户明确授权继承当前冻结 dirty worktree，并按 mission1 继续修改产品代码：`授权你继承当前冻结 dirty worktree，并按 mission1 继续修改产品代码。`
- 独立审查任务的界面批准提示不是本任务的验收证据，也不要求用户逐项批准；但独立审查本身仍必须由不同于当前作者/调度者的任务产生可核验产物。若未来要让 A0/A2 通过，正式 acceptance 是在真实 review artifact 产生后、针对其 authority/source/diff/artifact hash 的一次绑定确认，不是对侧栏任务逐项点“批准”；没有 artifact 时不得预先确认或手造凭证。

当前续接工作树为 `codex/mission1-a0`。权威文档是受 git 跟踪的 `msssion/mission1.md`，`锐评/mission1.md` 是同步的忽略 shadow；修改权威文档后必须重新同步并逐字节核对。当前已经存在的 mission1 脏改动属于本次授权范围，不能 reset、clean 或覆盖。

当前 `scripts/verify-mission1-acceptance.mjs` 已是 A0 fail-closed 候选实现：会绑定 HEAD、tracked dirty patch、完整 blob OID、所有非忽略 untracked 输入、runner trust root、原始负向 fixture/子进程、原子写矩阵、artifact manifest、summary/state/checkpoint 与 quarantine；`--selftest` 和 `--fixture` 会真实运行负向子进程。当前 A0 仍为 `FAIL`，这不是故障吞掉，也不是可继承的旧 PASS。

因此，下文出现的旧字节数、旧哈希、旧 runner 行为、旧“尚未回答两个问题”的文字只属于生成当时的历史交接现场，必须以当前文件、当前 runner 的 `--status` / `--selftest`、治理 CLI 和当前工作树重新核验。不要手造 `mission1-independent-review.json`、用户 acceptance 或 V2 corpus 来让 A0 变绿；缺少真实独立审查和合法 V2 语料时，保持 `FAIL`/`blocked`/`unverified` 的准确状态。

## 0.0.1 当前 IPC/Bridge 研究覆盖（2026-08-28）

本轮新增的文档交付是 `msssion/mission1.md` §4.9：必须先给出当前
renderer → preload → Electron main → Node/core Bridge → C# Bridge 的调用图，
再给出最值得先拆的三点、目标边界、可回退迁移顺序和 NO-TOUCH 清单。最高优先级
是拆 main 的 IPC domain router；随后才是 PARAM 的 native session +
metadata/payload 分离，以及 MAP static、CHR/FLVER bundle 的 batch/session 接线。
不要把这项研究改写成立即大规模重构，也不要把 IPC 次数下降当成 native parse
下降的替代证据。

当前 checkout 的二次核对必须以 mission1 §4.9.1.1 为准：

- `apps/desktop/src/main/ipc.ts` 当前约 11732 行，仍是跨域巨型 router；
- `ParamDocumentSessionCache.cs` 是未跟踪的 PARAM session **candidate**，现有
  `readParamPage`/container path 尚未贯通 session、generation、entry identity，
  `loadAll/includeAllPayloads` 仍可走大帧；
- `read-map-static-geometry` 已有 main/preload/renderer caller，但 renderer 仍
  明确只取最后一个 chunk，C# 还存在每请求重读/重算 hash、绑定未消费和建 session
  时全量物化 mesh 的缺口；它是 **reachable candidate**，不是地图完成证据；
- standalone FLVER 仍由 dummies/skeleton/mesh 三个旧入口分开读取，不能因已有
  chrbnd bundle seam 就声称普通 FLVER 已统一 session。

以上候选改动只改变了当前 dirty 输入的可观察状态，不改变 A0、governance
freshness、native authority 或独立审查要求。所有 M1/M3/M4/M5 出口仍须按
mission1 的 identity、parse counter、payload budget、parity、lifecycle、fallback
断言逐项实测；未满足前保持 `candidate`/`partial`/`unverified`，不得 claim、
complete 或 seal。

你要接手的任务：**持续审查并修改 `mission1.md`，直到它能无歧义地手把手指导一个能力较弱的 agent 完成 SoulForge 的加载、PARAM、地图、动作预览四个域的修复。**

这份文档要补齐所有算法契约，并最终通过一次全新的、独立的、攻击性盲审。**盲审目前不存在**——跨会话派出的 5 个 subagent 无一返回，唯一回来的一份由原作者自己裁定，按定义不算独立。这是最大的空缺。

## 0. 先读这两个文件，别急着改

- `msssion/mission1.md` —— 主文档，501450 字节 / 6988 行。
- `msssion/report.md` —— 交接报告，讲清了**哪里没改、会朝哪偏**。九个未完成范围，每条都配「会怎么偏」和「防偏移」。

**先读 `report.md`**，它比主文档短 40 倍，且专门为你写的。不要从 `mission1.md` 第 1 行开始读——6988 行你读不完，硬读会耗尽上下文。

## 1. 副本与身份（下列旧快照仅供历史追溯）

本节原先记录的是 2026-08-27 的三份副本、旧字节数、旧哈希和旧 commit。它们会随本轮编辑失效，不能作为当前版本判据，也不能覆盖 §0.0 的当前状态。

当前可执行规则只有：权威文件是受 git 跟踪的 `msssion/mission1.md`；`锐评/mission1.md` 是忽略的同步 shadow。只编辑前者，随后用 `Copy-Item -LiteralPath 'msssion/mission1.md' -Destination '锐评/mission1.md' -Force` 和 `fc.exe /b` 校验逐字节一致。当前 branch、HEAD、dirty patch、untracked 输入和 evidence 身份由 `scripts/verify-mission1-acceptance.mjs` 每次运行重新计算，不能用字节数或历史哈希判版本。

## 2. 这份文档特有的四个陷阱

这四条不是通用建议，是在这份文档上**已经把人坑过**的。

**「实测」标签没有可信度分级。** 全文所有「实测」出自同一作者自审。原作者至少犯过一次先写后测——先把 grep 结论写进文档，之后才跑那条 grep（结果碰巧对上）。**表面上分不出哪条是先测后写。** 凡要据以删除生产代码的结论，你必须自己重跑一遍验证命令。文档给的命令能跑。

**行号锚点会过期，而过期的锚点长得和有效的一模一样。** 已经发生过：一份暂存件称 `TaeWorkbenchPanel.tsx:1036` 漂到了 `:1068`，实测 `:1036` 完全正确——是作者把两个不同的调用站点搞混了。**先 grep 符号名确认位置，再用行号当加速器，不要当真相。**

**写进文档的字节数和哈希，在写下去那一刻就过期。** 自指的计量都有这毛病。文档里已有一处把字节/哈希改成「会变，见下」并留了 grep 判别器，照那个做。

**「未测」= 不知道，不等于没问题。** 文档里标了大量未测项。默认阅读「没有反例 ⇒ 没问题」是错的。**不能据以删除任何代码或跳过任何验证。** 要删就先测；测不了就把该条留在原地并写明测不了的原因。

## 3. 验收看行为，不看名字

这份文档里已经抓到两次「grep 报绿、违反照在」：

- 协议按**名字**禁止 `allPositions`/`allIndices`；生产实现同一语义但叫 `Positions`/`Indices`。grep 合规，违反存在。
- 另一处的决定性证据是 `MapStaticGeometryService.cs:276` 的 `Array.Copy(mesh.Indices, triStart * 3, ...)`——分页是在**已建好的整表上切片**，这行说明表已全量存在。

**你自己新增的任何门禁，先用负向用例证明它会红。** 没实测过会红的门禁，约一半是假门禁。

## 4. 硬规则（违反会被 hook 拦或造成真实损害）

- **一切回答用简体中文。**
- **写代码一律在 worktree 分支上做，不直接改 `main`/`master`/`trunk`/`release/*`。** 主会话用 `EnterWorktree`，子任务用 `Agent(isolation: "worktree")`。不要用 `git checkout -b` 开并行分支。
- **禁止在 GitHub 上署 Claude 的名。** commit message、PR 描述、issue 评论都不加 `Co-Authored-By: Claude` 或 `Generated with Claude Code`。
- **绝不 `git add -A`。** 生成时曾有大量与本任务无关的改动；当前归属必须以每次 `git status` / `git diff` 为准，若发现外部 agent 正在写入，先停止写入并确认归属。
- 所有用户 Mod 资源写入必须经过 Patch Engine；禁止在 Patch Engine 外用 `fs.writeFile` 改 Mod 资源；renderer 不得访问文件系统或拿到真实绝对路径。
- 不提交真实游戏资产、用户 Mod、私有 corpus、Oodle DLL、凭据或签名私钥。
- **「做完」= 相关验证命令实际跑过并通过。** 顺序：tests → lint/format → build → typecheck → 最小可复现 smoke。改了前端/渲染器或底层逻辑后必须重跑 `npm run build`。报告里必须区分跑过的和没跑的。
- **subagent 在跑的时候不要干等。** 禁止 `sleep`、禁止轮询产物文件、禁止反复查状态。也不要替它编造结论——通知没到就是不知道。

## 5. 用户裁定（已完成，不要重复提问）

生成本提示词时的两个待决问题已经由用户回答：`partial` 同时修改文档和 `verify-private-native-gate.mjs`；修复顺序为 A0 先修信任根。用户还明确授权继承当前冻结 dirty worktree，原文与当前身份见 §0.0。下一位 agent 不得把侧栏子审查批准项当成新的用户裁定，也不得重复询问这两题。

两条路各自都自洽，**你会随手挑一条走到底且中途不会自我纠正**，而它们影响全篇执行顺序，选错要整体重来。这是决策不是技术判断，问用户。

## 6. 已公开的敏感路径：不要「顺手」处理

`SoulForge` 是**公开仓库**。`mission1.md` 的 `:681`、`:826`、`:1965`、`:2098`、`:4226` 含 Windows 用户名和用户本地 Sekiro 安装路径，**用户已明确知情并选择原样推送**。

**不要主动改写历史去清除它们。** 那需要 force push，属于破坏性操作。你可以建议，但必须先问。

## 7. 当前接手顺序

1. 读 `msssion/report.md`，再读 §0.0、`mission1.md` 的 §0/§4.8/A0 相关章节；不要从 6988 行旧文档的第 1 行顺读。
2. 不要把 `%TEMP%` 中历史暂存件当成当前输入。已存在的持久备份目录是 `C:\Users\ASUS\Desktop\soulforge-mission1-staged-20260827\`；临时文件若仍存在，只能读作历史材料，不能据此生成 PASS。
3. 先运行 `node scripts/verify-mission1-acceptance.mjs --status`、`--selftest`，再核对 `testdata/corpus/mission1-sekiro-acceptance.manifest.json`。当前 runner 的负向子进程和 artifact 身份是门禁输入，不能仅凭文件名或源码字符串判定。
4. 运行 `node scripts/gov.mjs help`、`next`、`status`，确认治理层当前 release/claim/evidence；未经新鲜证据不要 claim/complete/seal。

## 8. 当前优先级与停止条件

1. 补齐真正独立的 A0 攻击审查 artifact，并保留 dispatch receipt、raw reviewer output、攻击用例及 reviewed source/root hash；当前实现者不得自写 review JSON 充数。
2. 按文档要求重新构建合法 V2 corpus，并由独立 verifier/审查者确认三源身份；不得在旧 V1 placeholder 上补几个 hash、自动迁移或改写成 PASS。
3. 只有 A0 trust root 通过后，才进入 A1 与加载/PARAM/地图/动作预览产品域；用户的 dirty-worktree 授权不等于绕过 A0、Patch Engine、Evidence 或 native authority。
4. PARAM 的旧数字、加载域未审结论以及 `%TEMP%` 暂存件均是历史待验证材料；不能从 mod 侧绿灯外推 game 侧，也不能从任一域外推另一域。
5. 如果没有外部独立审查或真实 V2 corpus，保持 `A0=FAIL`、`authority=blocked`，报告唯一下一动作和证据路径；不要为了“完成”降低门禁。

## 9. 回滚与并发安全

- 当前工作在 `codex/mission1-a0`，改动尚未提交；保留 dirty worktree，不执行 `git reset --hard`、`git clean` 或旧 commit 的 checkout 覆盖。
- 可审查的持久备份位于 `C:\Users\ASUS\Desktop\soulforge-mission1-staged-20260827\`；需要恢复时先逐文件比较并取得明确授权，再用窄范围、可审计的补丁恢复。
- `锐评/mission1.md` 只能由 `msssion/mission1.md` 重新同步；不要单独恢复 shadow。验收 evidence/state 属于运行产物，先按当前 runner 的 quarantine 规则保留，不得手改 evidence JSON。
- 下文提到的 `335b6110`、旧 `24.16.5` 节和旧 report 都是历史回滚参考，不是当前回滚指令。

## 10. 交付时要报告什么

- 改了哪些文件、为什么。
- 跑了哪些命令、关键输出是什么。**没跑的命令、没读的文件、没验证的结论都要标出来。**
- 怎么回滚。


