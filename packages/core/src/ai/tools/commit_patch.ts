import type { RegisteredTool } from '../toolRegistry.js';
import { fail, finalizeCommittedToolResult } from '../toolRegistrySupport.js';
import type { PatchProposal } from '@soulforge/shared';
import { isAbsolute, join } from 'node:path';
import { commitPatchProposal } from '../../patch/patchEngine.js';
/** commit_patch: one domain tool declaration, schema and handler. */
export function createCommitPatchTool(): RegisteredTool {
    return {
        name: 'commit_patch',
        description: 'Commit a PatchProposal through Patch Engine (staging, backup, hash check, rollback metadata). '
            + 'Pass the object returned by propose_text_patch. Does not write until the user approves in the Agent panel.',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: {
            opId: 'string',
            workspaceId: 'string',
            changes: 'array',
            title: 'string?',
            author: 'string?',
            mode: 'string?',
            createdAt: 'string?'
        },
        run: async (input, context) => {
            const proposal = input as PatchProposal;
            if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
                return fail('INVALID_INPUT', 'commit_patch requires a PatchProposal object.');
            }
            if (!context.session || !context.operationLogStore || !context.backupBaseDir) {
                return fail('COMMIT_CONTEXT_REQUIRED', '提交需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir）。');
            }
            if (!context.confirmation?.id || context.confirmation.subjects.length === 0) {
                return fail('EDIT_CONFIRMATION_REQUIRED', '提交需要用户在 Agent 审批卡确认后签发的写入回执。');
            }
            const overlayRoot = context.session.layers.overlayRoot;
            const resolvedChanges = [];
            for (const change of proposal.changes) {
                if (typeof change.targetPath !== 'string' || change.targetPath.trim() === '') {
                    return fail('INVALID_INPUT', 'commit_patch 的每条 change 都需要 targetPath。');
                }
                const absolute = isAbsolute(change.targetPath)
                    ? change.targetPath
                    : join(overlayRoot, change.targetPath);
                const writable = context.session.resolveWritablePath(absolute, change.layer ?? 'overlay');
                if (!writable.ok || !writable.absolutePath) {
                    const diagnostic = writable.diagnostics[0];
                    return fail(diagnostic?.code ?? 'WRITE_OUTSIDE_OVERLAY', diagnostic?.message ?? '目标不在当前打开的工作区里，无法写入。', { targetPath: change.targetPath });
                }
                resolvedChanges.push({ ...change, targetPath: writable.absolutePath });
            }
            const result = await commitPatchProposal({ ...proposal, changes: resolvedChanges, author: proposal.author === 'user' ? 'user' : 'ai' }, {
                session: context.session,
                operationLog: context.operationLogStore,
                workspaceRoot: overlayRoot,
                backupRoot: context.backupBaseDir,
                ...(context.recoveryDir ? { recoveryDir: context.recoveryDir } : {})
            });
            const failed = result.diagnostics.some((item) => item.severity === 'error')
                || result.changedFiles.length === 0;
            if (failed) {
                const diagnostic = result.diagnostics.find((item) => item.severity === 'error');
                return fail(diagnostic?.code ?? 'COMMIT_FAILED', diagnostic?.message ?? 'Patch Engine 提交失败，工作区未被修改。', { opId: result.opId, diagnostics: result.diagnostics });
            }
            return finalizeCommittedToolResult({ data: result, changedSources: result.changedFiles, context });
        }
    };
}
