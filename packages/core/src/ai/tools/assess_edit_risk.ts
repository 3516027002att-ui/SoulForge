import type { RegisteredTool } from '../toolRegistry.js';
import { asRecord, fail, ok } from '../toolRegistrySupport.js';
import type { IndexedFile } from '@soulforge/shared';
import { assessEditRisk, evaluateWriterGate, resolveWriterContract } from '../../patch/writerContract.js';
/** assess_edit_risk: one domain tool declaration, schema and handler. */
export function createAssessEditRiskTool(): RegisteredTool {
    return {
        name: 'assess_edit_risk',
        description: 'Assess Files-mode edit risk and resolve writer contract for an indexed file snapshot.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: {
            // `file` can only be declared as a bare object: ToolInputShape is
            // Record<string, string> and cannot express nested required fields.
            // The run body checks them explicitly and names what is missing.
            file: 'object',
            truncated: 'boolean?',
            structuredEditable: 'boolean?',
            parseStatus: 'enum:unparsed|parsed|partial|unsupported|failed?',
            changeKind: 'enum:text|structured|binary?'
        },
        run: (input) => {
            const value = asRecord(input);
            const rawFile = (value.file && typeof value.file === 'object' ? value.file : value) as Record<string, unknown>;
            if (!rawFile || (typeof rawFile.sourceUri !== 'string' && typeof rawFile.sourcePath !== 'string')) {
                return fail('INVALID_INPUT', 'assess_edit_risk 需要在 { file } 中传入包含 sourceUri 的文件对象。');
            }
            const sourceUri = typeof rawFile.sourceUri === 'string' ? rawFile.sourceUri : `workspace://files/${String(rawFile.sourcePath).replace(/\\/g, '/')}`;
            const pathStr = typeof rawFile.sourcePath === 'string' ? rawFile.sourcePath : sourceUri;
            const parts = pathStr.split(/[/\\]/);
            const name = parts[parts.length - 1] || '';
            const dots = name.split('.');
            const derivedExt = dots.length > 1 ? dots[dots.length - 1] || '' : '';
            const derivedCompoundExt = dots.length > 2 ? dots.slice(1).join('.') : derivedExt;
            const file = {
                sourceUri,
                sourcePath: typeof rawFile.sourcePath === 'string' ? rawFile.sourcePath : name,
                extension: typeof rawFile.extension === 'string' ? rawFile.extension : derivedExt,
                compoundExtension: typeof rawFile.compoundExtension === 'string' ? rawFile.compoundExtension : derivedCompoundExt,
                game: typeof rawFile.game === 'string' ? rawFile.game : 'sekiro',
                resourceKind: typeof rawFile.resourceKind === 'string' ? (rawFile.resourceKind as any) : 'unknown',
                ...(rawFile.containerFormat ? { containerFormat: rawFile.containerFormat as any } : {})
            } as unknown as IndexedFile;
            const riskOptions = {
                ...(value.truncated === true ? { truncated: true as const } : {}),
                ...(typeof value.structuredEditable === 'boolean' ? { structuredEditable: value.structuredEditable } : {}),
                ...(typeof value.parseStatus === 'string' ? { parseStatus: value.parseStatus } : {})
            };
            const risk = assessEditRisk(file, riskOptions);
            const contract = resolveWriterContract(file);
            const gate = evaluateWriterGate({
                file,
                changeKind: value.changeKind === 'structured' || value.changeKind === 'binary' ? value.changeKind : 'text',
                riskOptions
            });
            return ok({ risk, contract, gate });
        }
    };
}
