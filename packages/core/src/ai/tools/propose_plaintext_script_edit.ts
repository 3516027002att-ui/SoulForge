import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, asString, fail, ok } from '../toolRegistrySupport.js';
import { buildPlaintextScriptEdit } from '../../script/plaintextScriptEdit.js';
/** propose_plaintext_script_edit: one domain tool declaration, schema and handler. */
export function createProposePlaintextScriptEditTool(): RegisteredTool {
    return {
        name: 'propose_plaintext_script_edit',
        description: 'Propose a source-level edit to a plain-text script entry (goal_list.lua, '
            + '*_battle.lua, *nameid.txt). Verifies the target is really plain text from its bytes, '
            + 'preserves the original encoding and trailing padding, and returns a patch proposal. '
            + 'It does not save files. Bytecode entries are rejected.',
        permission: 'propose',
        permissionLevel: 'propose',
        inputSchema: {
            containerUri: 'string',
            childPath: 'string',
            entryIndex: 'number',
            /** 目标条目当前字节的 base64。调用方须经 read 类工具取得,不是猜的。 */
            currentBytesBase64: 'string',
            expectedContainerHash: 'string',
            find: 'string',
            replace: 'string',
            containerFormat: 'string?'
        },
        run: (input) => {
            const value = asRecord(input);
            const containerUri = asString(value.containerUri);
            const childPath = asString(value.childPath);
            const currentBytesBase64 = asString(value.currentBytesBase64);
            const expectedContainerHash = asString(value.expectedContainerHash);
            const find = asString(value.find);
            const replace = asString(value.replace);
            const entryIndex = asNumber(value.entryIndex, Number.NaN);
            if (!containerUri || !childPath || !currentBytesBase64 || !expectedContainerHash || !find) {
                return fail('INVALID_INPUT', 'propose_plaintext_script_edit 需要 containerUri、childPath、currentBytesBase64、'
                    + 'expectedContainerHash 与 find。');
            }
            if (!Number.isInteger(entryIndex) || entryIndex < 0) {
                return fail('INVALID_INPUT', 'entryIndex 必须是非负整数。');
            }
            let currentBytes: Uint8Array;
            try {
                currentBytes = new Uint8Array(Buffer.from(currentBytesBase64, 'base64'));
            }
            catch {
                return fail('INVALID_INPUT', 'currentBytesBase64 不是合法 base64。');
            }
            if (currentBytes.length === 0) {
                return fail('INVALID_INPUT', 'currentBytesBase64 解出零字节。');
            }
            // 全部判定与编排复用已端到端验证过的那一层:明文按真实字节判定、
            // 编码保持、尾部对齐填充保留、锚点唯一性强制、写后哈希。
            // 工具层不重写任何一条 —— 重写就会出现两套会漂移的规则。
            const result = buildPlaintextScriptEdit({
                containerUri,
                childPath,
                entryIndex,
                currentBytes,
                expectedContainerHash,
                ...(asOptionalString(value.containerFormat)
                    ? { containerFormat: asOptionalString(value.containerFormat)! }
                    : {}),
                actions: [{ kind: 'replace-once', find, replace }]
            });
            if (!result.ok) {
                return fail(result.code, result.message, { diagnostics: result.diagnostics });
            }
            return ok({
                operation: result.operation,
                encoding: result.encoding,
                beforeBytes: result.beforeBytes,
                afterBytes: result.afterBytes,
                beforeHash: result.beforeHash,
                afterHash: result.afterHash,
                diagnostics: result.diagnostics,
                note: '已生成 PatchIR 操作,尚未写入任何文件。提交需经 Patch Engine,'
                    + '且写后应用 checkPlaintextWriteback 复验重读字节。'
            });
        }
    };
}
