# 机械档任务清单(用完即弃)

**本文与 [HARD.md](HARD.md) 同为一次性工作计划,不是长期规范。** 每条做完就删掉那一条;
全部做完连同 `docs/plan/` 整个目录一起删除,退场步骤见 HARD.md 的 T-H4。

本档的判据都是固定的:**改错会立刻转红,不需要跨文件权衡,也不需要读懂整条调用链。**
适合稳定推进、不易出错的执行。判断上有疑问的都放在 HARD.md,不要在本档自行扩大范围。

三条通用要求(每条任务都适用,不再逐条重复):

1. 加门禁必须用负例证明它会红——改坏对象 → 确认 `exit=1` 且诊断指名真实原因 → 还原确认 `exit=0`。
   没实测过会红的门禁,实测约一半是假门禁。
2. 加断言后看检查总数是否涨了预期条数。**不涨就是没执行。**
3. 改了 Gate 主题域文件(治理校验器、治理 schema、范围 JSON、验证脚本、投影器)要
   **先提交再 `gov seal`**——指纹锚点是 HEAD,未提交的改动清不掉 stale。四步见 `gov help`。

---

## T-M1 探针文件零容忍门禁

**做什么:** 给 `scripts/` 下的 `_probe*` / `_tmp*` 临时文件加门禁,禁止入库残留。

**实测依据:** 2026-08-02 在 `scripts/` 发现 16 个临时探针文件,最早的建于 7-18,跨半个月无人
发现。原因是它们全部 gitignored 因而不进 `git status`——**纯约定不带门禁 = 迟早失效**。
已清理的清单:`_gen_section28.py`、`_probe-backup-{fix,gap}.mjs`、`_probe-debt-classify.mjs`、
`_probe-restore-trace.mjs`、`_tmp_extract/`、`_tmp_probe_{asset_resources,containers,headers,mapbnd,mtd_hkx}.mjs`、
`_tmp_ret_block2.ts`、`_tmp_s28_{lines.txt,part1.mjs,part2.mjs}`、`_tmp_sweep_containers.mjs`。

**判据形态:** 扫 `scripts/` 目录的实际文件名,不是维护一份清单——只迭代自己清单的门禁
从不扫仓库,是已实测的假门禁形态之一。

**注意:** 探针本身是合法工具(第 6 条明确允许用 `scripts/_probe*.mjs` 插桩定位),门禁要拦的是
**残留**而非**存在**。所以判据是"提交时不得存在",不是"任何时候都不得创建"。

**验收:** 负例造一个 `scripts/_probe-x.mjs` → 门禁转红并点名该文件 → 删除后转绿。

**归属层:** 建议 `governance`(它守的是仓库卫生,不依赖本机资源)。加进 `scripts/verify/tiers.mjs`
后跑 `node scripts/verify.mjs --audit` 确认已登记。

---

## T-M2 `git status` 路径过滤误判防护

**做什么:** 让"工作区是否干净"这个判断不可能被路径过滤误导。

**实测依据:** 2026-08-02 本会话多次用 `git status --porcelain -- <少数路径>` 确认"干净",
而工作区一直有 **20 个上个会话遗留的未提交改动**(它们清偿了 18 项临时目录欠债,代码完整
但未验证未提交)。过滤后的"干净"只对被过滤的那部分成立,**而输出看起来跟真干净一模一样**。

**这条不一定要做成门禁。** 可选形态,按你判断挑一个:

- 给 `gov status` 加一行未提交文件数(无过滤),让面板自带这个事实;
- 或在执行手册 L0 压舱石清单里写明"查工作区必须无 `--` 过滤";
- 或两者都做。

不要做成"禁止使用 `--` 过滤"的门禁——带过滤查特定文件是合法用法,禁掉会误伤。

**验收:** 若做成 `gov status` 字段,负例是造一个未提交改动后确认计数变化;
若做成手册条目,验收是该条目被 `verify-handoff-integrity` 的受管文档扫描覆盖。

**动手前先读 `cmdStatus` 已有的实现与注释。** 2026-08-02 在它身上修过一处假绿:
调用不带参数的 `runGovernanceCheck()`,`withFreshness` 默认 false,于是跳过
`GATE_EVIDENCE_STALE` 判定——同一状态下治理层报三条红而 status 报
`governanceGateOk: true`、顶层 `ok: true`、退出码 0。修法与三条 fixture 断言都在
`scripts/verify-gov-cli-fixtures.mjs` 里。往这个命令加字段时留意同一个坑的形状:
**面板字段的默认值不能比它所报告的事实更乐观**。

---

## T-M3 `.gitattributes` 行尾策略

**做什么:** 决定是否给仓库加 EOL 策略,消除投影行尾差异的根因。

**已核实的事实(不要重新查):**

- 文件存在,内容只有一行:`graphify-out/graph.json merge=graphify`
- **它被 gitignore**(`.gitignore:20`),所以当前内容不进新克隆
- 本机 `core.autocrlf=true`,已导致过"重跑投影生成后 `git diff` 输出 0 行却报分叉"
  (该症状已在投影门禁侧修好——判定改为行尾无关)

**为什么归机械档:** 事实已查清,剩下的是执行。**但 blast radius 是全仓 checkout**,
所以动手前必须:先 `git status` 确认干净 → 改 → 观察有多少文件被标记为修改 → 若超出预期
立即 `git checkout` 回退。

**允许的结论包括"不做"。** 若判断收益不抵风险,把结论写进本条并删除本条即可,
不必强行改动。真做的话注意 `.gitattributes` 本身被 ignore,要先决定是否从 `.gitignore:20`
移出——那是两个独立决定。

**验收:** 改动后 `npm run test:handoff-projection` 与 `node scripts/verify.mjs --tier governance`
均不退化;工作区不出现意外的大批文件改动。

---

## T-M4 分支与 origin 的最终处置

**做什么:** 确认或执行 4 条未合并分支与 `origin` 的处置。

**已核实的事实:**

| 分支 | 领先 main | 性质 |
|---|---|---|
| `backup/local-ahead-225c08d` | 1 | 历史快照 |
| `codex/v05-current-project` | 1 | 历史快照 |
| `codex/v05-worktree-publish` | 1 | 历史快照 |
| `worktree-v05-open-format-import` | 2 | 历史快照 |

worktree 已只剩主工作树(`git worktree list` 实测单行)。另有 6 条分支领先 0——
它们已被 main 包含,`--ff-only` 合并无事可做,清理与否都不影响正确性。

`main` 领先 `origin/main` **170** 个提交(2026-08-02 实测)。上表领先数同日实测。
**这两个数都会随提交增长,别照抄:**

~~~powershell
git worktree list
git rev-list --count origin/main..main
git for-each-ref --format='%(refname:short)' refs/heads/
~~~

**当前用户裁定:保留 4 条分支不删、不推 origin。** 本条任务不是推翻它,而是:

1. 复量一次领先数并确认裁定仍适用;
2. 若用户改变主意要推,**推之前必须确认无凭据、无真实游戏资产、无用户 Mod 入库**;
3. 若维持现状,把结论写进本条后删除本条。

**不要自行推 origin。** 推送是外向动作且难以撤回,必须有用户明确指示。

---

## T-M5 收尾:最低回归与封存

**做什么:** 本档任务全部完成后跑一次完整回归并封存。

```powershell
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
node scripts/verify.mjs --tier governance
```

五条全 `exit 0` 才算过。任何一条红都不要封存——封存搬运的是"实际运行过的命令与结论",
把红的说成绿的是伪造证据。

封存时 `--subject` 必须原样带齐目标 Gate 现有证据声明过的 `user-approved` 标记
(如 `scope-ruling:user-approved`、`scope-deferral:REL-E:V0.6:user-approved`)与
`revalidates=<既有EvidenceId>`。漏标记会报 `GATE_EVIDENCE_STALE`,**而那个诊断指向
"主题域变了",真实原因是"标记漏了"**——照诊断反复重跑验证永远修不好。CLI 已有追加前
预检会逐个指名缺哪个,照抄即可。

**CLI 绝不会自动补 `user-approved` 标记**,那等于伪造用户裁定。它只报告缺哪个。
