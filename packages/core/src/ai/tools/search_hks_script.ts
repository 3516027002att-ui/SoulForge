import type { RegisteredTool } from '../toolRegistry.js';
import { createStandaloneHksHandler } from '../toolRegistrySupport.js';
export function createSearchHksScriptTool(): RegisteredTool {
    return { name: 'search_hks_script', description: "Find exact, case-sensitive source text in a standalone .hks/.lua. Pass file and query; follow nextActions for remaining matches, then readAction for source context. Text matches do not prove action semantics. A cursor is bound to file, query and sourceHash.", permission: 'read', permissionLevel: 'read', inputSchema: { file: 'string', query: 'string', cursor: 'string?', limit: 'safe-integer?' }, run: createStandaloneHksHandler('search_hks_script') };
}
