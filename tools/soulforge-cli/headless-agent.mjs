/** Full headless Agent entry. Only host ports touch resources; credentials remain process-local. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { captureAgentRunProvenance, decodeTaskInput, bindProviderConfiguration } from '../../scripts/testing/agent-run-provenance.mjs';
const failure = (code, message) => Object.assign(new Error(message), { code });
export function parseAgentExecArguments(argv) {
    if (argv[0] !== 'exec')
        throw failure('AGENT_COMMAND_INVALID', 'Expected agent exec.');
    const options = { kernel: 'finite', maxSteps: 200, timeoutMs: 1800000, maxOutputTokens: 100000 };
    const fields = { '--prompt': 'prompt', '--task-file': 'taskFile', '--provider-config': 'providerConfig', '--responses-file': 'responsesFile', '--sessions-dir': 'sessionsDir', '--kernel': 'kernel', '--max-steps': 'maxSteps', '--timeout-ms': 'timeoutMs', '--max-output-tokens': 'maxOutputTokens', '--max-cost': 'maxCost' };
    for (let i = 1; i < argv.length; i++) {
        const key = fields[argv[i]];
        if (!key)
            throw failure('AGENT_ARGUMENT_INVALID', `Unknown agent exec option: ${argv[i]}`);
        const value = argv[++i];
        if (value === undefined || value.startsWith('--'))
            throw failure('AGENT_ARGUMENT_INVALID', 'Option requires a value.');
        options[key] = ['maxSteps', 'timeoutMs', 'maxOutputTokens', 'maxCost'].includes(key) ? Number(value) : value;
    }
    if (!['finite', 'legacy'].includes(options.kernel))
        throw failure('AGENT_ARGUMENT_INVALID', 'Kernel must be finite or legacy.');
    for (const key of ['maxSteps', 'timeoutMs', 'maxOutputTokens'])
        if (!Number.isSafeInteger(options[key]) || options[key] <= 0)
            throw failure('AGENT_ARGUMENT_INVALID', `Invalid ${key}.`);
    if (options.maxCost !== undefined && (!Number.isFinite(options.maxCost) || options.maxCost < 0))
        throw failure('AGENT_ARGUMENT_INVALID', 'Invalid cost budget.');
    if (Boolean(options.prompt) === Boolean(options.taskFile))
        throw failure('AGENT_INPUT_REQUIRED', 'Provide exactly one --prompt or UTF-8 --task-file.');
    if (Boolean(options.providerConfig) === Boolean(options.responsesFile))
        throw failure('AGENT_PROVIDER_REQUIRED', 'Provide exactly one --provider-config or --responses-file.');
    return options;
}
async function buildIdentity(repoRoot) {
    const hash = createHash('sha256');
    let count = 0;
    const walk = async (path) => {
        let entries;
        try {
            entries = await readdir(path, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = join(path, item.name);
            if (item.isDirectory())
                await walk(file);
            else if (/\.(?:mjs|js)$/u.test(item.name)) {
                hash.update(relative(repoRoot, file));
                hash.update(await readFile(file));
                count++;
            }
        }
    };
    await walk(join(repoRoot, 'packages/core/dist'));
    await walk(join(repoRoot, 'packages/agent/src'));
    return { sha256: hash.digest('hex'), fileCount: count, scope: 'core-dist-and-finite-kernel' };
}
export async function runHeadlessAgentCommand(options, core, repoRoot, io = {}) {
    const args = parseAgentExecArguments(options.agentArgs ?? []);
    const emit = io.emit ?? (frame => process.stdout.write(`${JSON.stringify(frame)}\n`));
    const task = args.taskFile ? decodeTaskInput(await readFile(resolve(args.taskFile))) : args.prompt;
    if (!task.trim())
        throw failure('AGENT_INPUT_REQUIRED', 'Task text is empty.');
    let adapter, config, provider, providerPricing;
    if (args.responsesFile) {
        const responses = JSON.parse(decodeTaskInput(await readFile(resolve(args.responsesFile))));
        if (!Array.isArray(responses) || responses.length === 0)
            throw failure('AGENT_FIXTURE_INVALID', 'Response fixture must be a nonempty array.');
        let index = 0;
        adapter = { protocol: 'openai-compatible', listModels: async () => ({ ok: true, models: [] }), complete: async () => { const next = responses[index++]; if (!next)
                throw failure('AGENT_FIXTURE_EXHAUSTED', 'Deterministic responses exhausted.'); return next; }, stream: async function* () { throw failure('AGENT_FIXTURE_STREAM_UNSUPPORTED', 'Use complete fixture responses.'); } };
        config = { id: 'deterministic-fixture', protocol: 'openai-compatible', model: 'fixture', displayName: 'fixture', baseUrl: 'https://fixture.invalid', hasCredential: false, createdAt: '', updatedAt: '' };
        provider = { kind: 'deterministic-fixture', responseSha256: createHash('sha256').update(JSON.stringify(responses)).digest('hex') };
    }
    else {
        const raw = JSON.parse(decodeTaskInput(await readFile(resolve(args.providerConfig))));
        if (args.maxCost === undefined)
            throw failure('AGENT_PROVIDER_BUDGET_REQUIRED', 'Real provider execution requires --max-cost and configured per-million token prices.');
        if (!raw.pricing || !['inputPerMillion', 'outputPerMillion'].every(key => Number.isFinite(raw.pricing[key]) && raw.pricing[key] >= 0))
            throw failure('AGENT_PROVIDER_PRICING_REQUIRED', 'Provider config must include current inputPerMillion/outputPerMillion prices.');
        config = { id: raw.id ?? 'headless', displayName: raw.displayName ?? 'headless', protocol: raw.protocol, baseUrl: raw.baseUrl, model: raw.model, hasCredential: true, createdAt: '', updatedAt: '' };
        const apiKey = process.env.SOULFORGE_AGENT_API_KEY;
        if (!apiKey)
            throw failure('AGENT_CREDENTIAL_REQUIRED', 'Set SOULFORGE_AGENT_API_KEY in the trusted host environment.');
        const created = core.createConfiguredModelServiceAdapter({ config, apiKey });
        if (!created.ok)
            throw failure('AGENT_PROVIDER_INVALID', created.diagnostics[0]?.message ?? 'Invalid provider.');
        adapter = created.adapter;
        providerPricing = {inputPerMillion:raw.pricing.inputPerMillion,outputPerMillion:raw.pricing.outputPerMillion};
        provider = { kind: 'configured', ...bindProviderConfiguration(config), maxCost: args.maxCost, pricing: { inputPerMillion: raw.pricing.inputPerMillion, outputPerMillion: raw.pricing.outputPerMillion } };
    }
    const provenance = await captureAgentRunProvenance(repoRoot, { task, goals: [], taskContract: null });
    const build = await buildIdentity(repoRoot);
    const sessionId = randomUUID();
    let eventSeq = 0;
    const mode = options.mode === 'fullPermission' ? 'full' : options.mode === 'plan' ? 'plan' : 'normal';
    const sessionsDir = resolve(args.sessionsDir ?? join(repoRoot, 'output', 'agent-headless'));
    await mkdir(sessionsDir, { recursive: true });
    const cliSession = await core.openLocalCliSession({ overlayRoot: resolve(options.workspace), ...(options.base ? { baseRoot: resolve(options.base) } : {}), game: options.game ?? 'sekiro', mode: options.mode ?? 'normal', principal: `agent:${sessionId}`, analyze: options.noAnalyze ? false : options.analyze ?? true, useCache: options.useCache ?? true, requireDurableLog: mode !== 'plan', ...(options.confirmRollback ? { confirmRollbackOpId: options.confirmRollback } : {}), onFallbackWarning: message => emit({ type: 'host-warning', message }) });
    let pendingApproval;
    const assembly = core.createAgentRunAssembly(cliSession.bridge, {coreSession:cliSession.coreSession});
    try {
        const result = await assembly.run({ sessionsDir, sessionId, adapter, config, apiKey: args.responsesFile ? '' : process.env.SOULFORGE_AGENT_API_KEY, prompt: task, permissionMode: mode, kernel: args.kernel, maxSteps: args.maxSteps, timeoutMs: args.timeoutMs, maxTotalOutputTokens: args.maxOutputTokens, kernelLimits: { timeoutMs: args.timeoutMs, ...(args.maxCost !== undefined ? {maxCost:args.maxCost}:{}) },
            ...(providerPricing ? {pricing:providerPricing}:{}),
            ...(args.kernel === 'legacy' && mode !== 'full' ? { requestApproval: async (request) => { pendingApproval = request; throw failure('AGENT_APPROVAL_CHANNEL_REQUIRED', 'Run is waiting for host approval.'); } } : {}),
            onEvent: event => { },
            onProtocolEvent: envelope => emit({ type: 'agent-event', ...envelope })
        });
        const report = { type: 'agent-report', sessionId, source: provenance.source, input: provenance.input, build, provider, kernel: args.kernel, finishReason: result.run.finishReason, state: result.kernel?.state ?? (result.run.finishReason === 'stop' ? 'completed' : result.run.finishReason), evaluation: 'unverified', evaluationReason: 'No independent task goal evaluator was supplied.', steps: result.run.steps, rolloutPath: result.rolloutPath, ...(result.kernel?.pendingApproval ? { pendingApproval: result.kernel.pendingApproval } : {}), transactions: result.kernel?.transactions ?? [], unresolvedCalls: result.kernel?.unresolvedCalls ?? [], ...(result.providerBudget ? { budget: result.providerBudget } : {}) };
        await writeFile(join(sessionsDir, `${sessionId}.report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        emit(report);
        return report;
    }
    catch (error) {
        if (error.code === 'AGENT_APPROVAL_CHANNEL_REQUIRED') {
            const report = { type: 'agent-report', sessionId, source: provenance.source, input: provenance.input, build, provider, kernel: args.kernel, state: 'waiting', finishReason: 'waiting', evaluation: 'unverified', pendingApproval };
            await writeFile(join(sessionsDir, `${sessionId}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
            emit(report);
            return report;
        }
        throw error;
    }
    finally {
        await assembly.waitForHostOperations?.();
        await cliSession.dispose();
    }
}
