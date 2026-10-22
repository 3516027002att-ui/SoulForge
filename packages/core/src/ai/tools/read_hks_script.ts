import type { RegisteredTool } from '../toolRegistry.js';
import { createStandaloneHksHandler } from '../toolRegistrySupport.js';
export function createReadHksScriptTool(): RegisteredTool {
    return { name: 'read_hks_script', description: "Read a standalone .hks/.lua from the opened workspace through validated plaintext or first-party Bridge decoding. Returns lossless sourceOffset/sourceLimit/cursor windows and sourceHash. This is read-only source evidence, not runtime verification or write authorization.", permission: 'read', permissionLevel: 'read', inputSchema: { file: 'string', sourceOffset: 'safe-integer?', sourceLimit: 'safe-integer?', cursor: 'string?', expectedSourceHash: 'string?' }, run: createStandaloneHksHandler('read_hks_script') };
}
