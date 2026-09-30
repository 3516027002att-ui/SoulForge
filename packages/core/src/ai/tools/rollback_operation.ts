import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, asString, fail, finalizeCommittedToolResult } from '../toolRegistrySupport.js';
import { rollbackOperation } from '../../patch/rollback.js';
/** rollback_operation: one domain tool declaration, schema and handler. */
export function createRollbackOperationTool(): RegisteredTool {
    return {
        name: 'rollback_operation',
        description: 'Rollback a committed operation from its backup. Requires full-permission mode and a host-issued confirmation bound to the operation. For CLI, the user must start the host with --confirm-rollback <opId>; tool input cannot grant its own confirmation.',
        permission: 'rollback',
        permissionLevel: 'rollback',
        inputSchema: { opId: 'string' },
        run: async (input, context) => {
            const value = asRecord(input);
            const opId = asString(value.opId);
            if (!opId)
                return fail('INVALID_INPUT', 'rollback_operation requires opId.');
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            // 回滚必须走生产上下文：session（可写路径权威校验）、持久 store（幂等与
            // 审计）、备份/恢复目录（逆向事务的还原点）。缺任一即干净失败，绝不回退
            // 到内存 store —— 那会把「没有备份」伪装成「已回滚」。
            if (!context.session || !context.operationLogStore || !context.backupBaseDir || !context.recoveryDir) {
                return fail('ROLLBACK_CONTEXT_REQUIRED', '回滚需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir / recoveryDir）。');
            }
            const result = await rollbackOperation({
                opId,
                store: context.operationLogStore,
                session: context.session,
                backupBaseDir: context.backupBaseDir,
                recoveryDir: context.recoveryDir,
                author: 'ai',
                ...(context.confirmation ? { confirmation: context.confirmation } : {})
            });
            // rollbackOperation 返回自带 ok 字段的结果对象，不能再用 ok() 整体包装
            // —— 那会把失败状态（EDIT_CONFIRMATION_REQUIRED 等）吞成 ToolResult.ok=true。
            if (!result.ok) {
                const diagnostic = result.diagnostics[0];
                return fail(diagnostic?.code ?? 'ROLLBACK_FAILED', diagnostic?.message ?? '回滚失败。', { opId: result.opId });
            }
            return finalizeCommittedToolResult({ data: result, changedSources: result.restoredFiles, context });
        }
    };
}
