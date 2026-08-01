/**
 * Evidence freshness 上下文构建器（唯一实现）。
 *
 * freshness 回答的问题是：「这条封存证据锚定的提交之后，该 Gate 的主题域变了吗」。
 * 判定需要 git 上下文，与判定规则（governanceRules.evaluateEvidenceFreshness）分离：
 * 本模块只负责把 git 事实收集成 { anchors } 结构，不含任何治理语义。
 *
 * 锚点来源由调用方注入（markdown §17.1 或 evidence.jsonl），因为迁移期两个数据源
 * 各自持有一份证据表；主题域内容源（handoff 章节/标记块）则是同一份 markdown。
 * 上下文构建若有两份实现，「某个数据源下 stale 证据被判 fresh」这类松动就会只在
 * 一侧出现，而另一侧门禁仍然显示通过。
 */
import { spawnSync } from 'node:child_process';
import {
  extractHandoffMarkedSubject,
  extractHandoffSectionSubject,
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef
} from '../handoff-integrity-lib.mjs';

const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';

const normalize = (value) => value?.replaceAll('\r\n', '\n') ?? null;

/**
 * @param {string} root 仓库根绝对路径。
 * @param {string[]} args git 参数。
 */
function runGit(root, args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
}

/**
 * @param {object} options
 * @param {string} options.root 仓库根绝对路径。
 * @param {string} options.handoffMarkdown 当前交接书内容（主题域内容源）。
 * @param {string[]} options.anchors 需要判定的锚点提交集合。
 * @returns {{ anchors: Record<string, { isAncestor: boolean, subjectScanAvailable: boolean, changedSubjects: string[] }> }}
 */
export function buildFreshnessContext({ root, handoffMarkdown, anchors: anchorList }) {
  const registry = gateSubjectRegistry();
  const anchors = {};
  const currentSections = new Map(registry.allHandoffSections.map((sectionId) => [
    sectionId,
    normalize(extractHandoffSectionSubject(handoffMarkdown, sectionId))
  ]));
  const currentBlocks = new Map(registry.allHandoffBlocks.map((block) => [
    block.id,
    normalize(extractHandoffMarkedSubject(handoffMarkdown, block.beginMarker, block.endMarker))
  ]));
  const needsHandoffScan =
    registry.allHandoffSections.length > 0 || registry.allHandoffBlocks.length > 0;

  for (const anchor of new Set(anchorList)) {
    const ancestor = runGit(root, ['merge-base', '--is-ancestor', anchor, 'HEAD']);
    // status 1 = 明确不是祖先（历史被改写）→ stale，可判定；
    // 其他非 0 = git 无法回答（锚点不存在等）→ 不可判定，失败关闭。
    if (ancestor.status === 1) {
      anchors[anchor] = { isAncestor: false, subjectScanAvailable: true, changedSubjects: [] };
      continue;
    }
    if (ancestor.status !== 0) {
      anchors[anchor] = { isAncestor: false, subjectScanAvailable: false, changedSubjects: [] };
      continue;
    }

    const changedSubjects = new Set();
    let subjectScanAvailable = true;

    if (registry.allFiles.length > 0) {
      const diff = runGit(root, [
        'diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames',
        anchor, '--', ...registry.allFiles
      ]);
      if (diff.status !== 0) {
        subjectScanAvailable = false;
      } else {
        for (const path of diff.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
          changedSubjects.add(path.replaceAll('\\', '/'));
        }
      }
    }

    if (needsHandoffScan) {
      const historical = runGit(root, ['show', `${anchor}:${HANDOFF}`]);
      if (historical.status !== 0) {
        subjectScanAvailable = false;
      } else {
        for (const sectionId of registry.allHandoffSections) {
          const before = normalize(extractHandoffSectionSubject(historical.stdout, sectionId));
          const after = currentSections.get(sectionId);
          if (before === null || after === null) subjectScanAvailable = false;
          else if (before !== after) changedSubjects.add(handoffSectionSubjectRef(sectionId));
        }
        for (const block of registry.allHandoffBlocks) {
          const before = normalize(
            extractHandoffMarkedSubject(historical.stdout, block.beginMarker, block.endMarker)
          );
          const after = currentBlocks.get(block.id);
          if (before === null || after === null) subjectScanAvailable = false;
          else if (before !== after) changedSubjects.add(handoffBlockSubjectRef(block.id));
        }
      }
    }

    anchors[anchor] = {
      isAncestor: true,
      subjectScanAvailable,
      changedSubjects: [...changedSubjects].sort()
    };
  }

  return { anchors };
}

/**
 * 从治理 JSON 证据记录收集锚点。与 collectSealAnchors（markdown 版）对应：
 * 只取格式合法的 sealed-current-run，指纹是否自洽由 validateEvidence 单独报错。
 *
 * @param {Map<string, { type: string, seal: { formatValid: boolean, fields: { head: string } }|null }>} evidence
 */
export function collectSealAnchorsFromRecords(evidence) {
  const anchors = new Set();
  for (const record of evidence.values()) {
    if (record.type === 'sealed-current-run' && record.seal?.formatValid === true) {
      anchors.add(record.seal.fields.head);
    }
  }
  return [...anchors];
}
