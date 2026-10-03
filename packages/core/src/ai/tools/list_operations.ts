import type { RegisteredTool } from '../toolRegistry.js';
import { fail, ok } from '../toolRegistrySupport.js';
import { getDefaultOperationLogStore } from '../../patch/operationLog.js';
/** list_operations: one domain tool declaration, schema and handler. */
export function createListOperationsTool(): RegisteredTool {
    return {
        name: 'list_operations',
        description: 'List Patch Engine operation log / patch history entries for the active workspace.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        run: async (_input, context) => {
            const ws = context.workspaceIndex;
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            // 优先用主进程注入的生产 SQLite store；没有注入时退回内存 store（测试/离线
            // 形态），不再把「内存空日志」冒充生产日志 —— 主进程 ai.runAgent 已注入。
            const store = context.operationLogStore ?? getDefaultOperationLogStore();
            return ok({
                operations: await store.list(ws.workspaceId),
                history: await store.history(ws.workspaceId)
            });
        }
    };
}
