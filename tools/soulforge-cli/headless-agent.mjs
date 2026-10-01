/** Full headless Agent entry. Only host ports touch resources; credentials remain process-local. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { captureAgentRunProvenance, decodeTaskInput, bindProviderConfiguration } from '../../scripts/testing/agent-run-provenance.mjs';
import { loadTestAgentProvider } from '../../scripts/testing/test-agent-provider.mjs';
const failure = (code, message) => Object.assign(new Error(message), { code });
export function parseAgentExecArguments(argv) {
    if (argv[0] !== 'exec')
        throw failure('AGENT_COMMAND_INVALID', 'Expected agent exec.');
    const options = { kernel: 'finite', maxSteps: 200, timeoutMs: 1800000, maxOutputTokens: 100000 };
    const fields = { '--prompt': 'prompt', '--task-file': 'taskFile', '--provider-config': 'providerConfig', '--provider': 'provider', '--test-config': 'testConfig', '--input-price-per-million': 'inputPricePerMillion', '--output-price-per-million': 'outputPricePerMillion', '--responses-file': 'responsesFile', '--sessions-dir': 'sessionsDir', '--kernel': 'kernel', '--max-steps': 'maxSteps', '--timeout-ms': 'timeoutMs', '--max-output-tokens': 'maxOutputTokens', '--max-cost': 'maxCost' };
    for (let i = 1; i < argv.length; i++) {
        const key = fields[argv[i]];
        if (!key)
            throw failure('AGENT_ARGUMENT_INVALID', `Unknown agent exec option: ${argv[i]}`);
        const value = argv[++i];
        if (value === undefined || value.startsWith('--'))
            throw failure('AGENT_ARGUMENT_INVALID', 'Option requires a value.');
        options[key] = ['maxSteps', 'timeoutMs', 'maxOutputTokens', 'maxCost', 'inputPricePerMillion', 'outputPricePerMillion'].includes(key) ? Number(value) : value;
    }
    if (options.kernel !== 'finite')
        throw failure('AGENT_LEGACY_KERNEL_RETIRED', 'The production Agent uses the finite kernel; explicit experiments use the pinned Git baseline.');
    for (const key of ['maxSteps', 'timeoutMs', 'maxOutputTokens'])
        if (!Number.isSafeInteger(options[key]) || options[key] <= 0)
            throw failure('AGENT_ARGUMENT_INVALID', `Invalid ${key}.`);
    if (options.maxCost !== undefined && (!Number.isFinite(options.maxCost) || options.maxCost < 0))
        throw failure('AGENT_ARGUMENT_INVALID', 'Invalid cost budget.');
    if (Boolean(options.prompt) === Boolean(options.taskFile))
        throw failure('AGENT_INPUT_REQUIRED', 'Provide exactly one --prompt or UTF-8 --task-file.');
    if (options.provider !== undefined && options.provider !== 'test')
        throw failure('AGENT_PROVIDER_INVALID', 'The encrypted provider selector is --provider test.');
    if ([options.providerConfig, options.responsesFile, options.provider].filter(Boolean).length !== 1)
        throw failure('AGENT_PROVIDER_REQUIRED', 'Provide exactly one --provider-config, --responses-file or --provider test.');
    if (options.provider !== 'test' && [options.testConfig, options.inputPricePerMillion, options.outputPricePerMillion].some(value => value !== undefined))
        throw failure('AGENT_ARGUMENT_INVALID', 'Test config and CLI prices require --provider test.');
    if (options.provider === 'test') {
        if (!Number.isFinite(options.maxCost) || options.maxCost <= 0)
            throw failure('AGENT_PROVIDER_BUDGET_REQUIRED', 'Encrypted provider execution requires a positive --max-cost.');
        if (![options.inputPricePerMillion, options.outputPricePerMillion].every(value => Number.isFinite(value) && value >= 0))
            throw failure('AGENT_PROVIDER_PRICING_REQUIRED', 'Provide explicit input/output prices per million tokens.');
    }
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
    const output = io.emit ?? (frame => process.stdout.write(`${JSON.stringify(frame)}\n`));
    let apiKey = '';
    let privateProviderValues = [];
    const redact = value => {
        const secrets = [...new Set([apiKey, ...privateProviderValues].filter(Boolean)
            .flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))]
            .sort((a, b) => b.length - a.length);
        return JSON.parse(JSON.stringify(value, (_key, item) => {
            if (typeof item !== 'string') return item;
            for (const secret of secrets) item = item.replaceAll(secret, '[REDACTED]');
            return item;
        }));
    };
    const emit = frame => output(redact(frame));
    const emitDiagnostic = event => io.emitDiagnostic?.(redact(event));
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
    else if (args.provider === 'test') {
        // Budget/pricing were validated before the original private input is read.
        const loaded = loadTestAgentProvider({ repoRoot, ...(args.testConfig ? { explicitPath: args.testConfig } : {}) });
        if (!loaded) throw failure('AGENT_TEST_CONFIG_UNAVAILABLE', 'The original encrypted test input was not found or could not be decrypted.');
        apiKey = loaded.config.apiKey;
        privateProviderValues = [loaded.config.baseUrl, loaded.config.model];
        const { apiKey: _privateKey, ...selected } = loaded.config;
        config = { ...selected, hasCredential: true, createdAt: '', updatedAt: '' };
        providerPricing = { inputPerMillion: args.inputPricePerMillion, outputPerMillion: args.outputPricePerMillion };
        provider = { kind: 'encrypted-test', configSha256: createHash('sha256').update(JSON.stringify(loaded.config)).digest('hex'), identityScope: 'selected-original-test-configuration', maxCost: args.maxCost, pricing: providerPricing };
        const created = core.createConfiguredModelServiceAdapter({ config, apiKey });
        if (!created.ok) throw failure('AGENT_PROVIDER_INVALID', 'The original encrypted provider configuration is invalid.');
        adapter = created.adapter;
    }
    else {
        const raw = JSON.parse(decodeTaskInput(await readFile(resolve(args.providerConfig))));
        if (args.maxCost === undefined)
            throw failure('AGENT_PROVIDER_BUDGET_REQUIRED', 'Real provider execution requires --max-cost and configured per-million token prices.');
        if (!raw.pricing || !['inputPerMillion', 'outputPerMillion'].every(key => Number.isFinite(raw.pricing[key]) && raw.pricing[key] >= 0))
            throw failure('AGENT_PROVIDER_PRICING_REQUIRED', 'Provider config must include current inputPerMillion/outputPerMillion prices.');
        config = { id: raw.id ?? 'headless', displayName: raw.displayName ?? 'headless', protocol: raw.protocol, baseUrl: raw.baseUrl, model: raw.model, hasCredential: true, createdAt: '', updatedAt: '' };
        apiKey = process.env.SOULFORGE_AGENT_API_KEY;
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
    const cliSession = await core.openLocalCliSession({ overlayRoot: resolve(options.workspace), ...(options.base ? { baseRoot: resolve(options.base) } : {}), game: options.game ?? 'sekiro', mode: options.mode ?? 'normal', principal: `agent:${sessionId}`, analyze: options.noAnalyze ? false : options.analyze ?? true, useCache: options.useCache ?? true, requireDurableLog: mode !== 'plan', ...(options.confirmRollback ? { confirmRollbackOpId: options.confirmRollback } : {}), onDiagnostic: emitDiagnostic, onFallbackWarning: message => emit({ type: 'host-warning', message }) });
    const bridge = { ...cliSession.bridge, executeTool: async (call, override) => {
        const startedAt = Date.now();
        const details = { requestId: call.id, tool: call.name };
        emitDiagnostic({ phase: 'tool', status: 'start', details });
        try {
            const result = await cliSession.bridge.executeTool(call, override);
            const diagnostic = core.normalizeCliToolDiagnostic?.(result, override?.signal) ?? { ok: result.ok, ...(result.code ? { code: result.code } : {}) };
            emitDiagnostic({ phase: 'tool', status: 'complete', elapsedMs: Date.now() - startedAt, details: { ...details, ...diagnostic } });
            return result;
        } catch (error) {
            const diagnostic = core.normalizeCliToolDiagnostic?.({ ok: false, code: error?.code }, override?.signal) ?? { ok: false, code: error?.code ?? 'TOOL_EXECUTION_FAILED' };
            emitDiagnostic({ phase: 'tool', status: 'failed', elapsedMs: Date.now() - startedAt, details: { ...details, ...diagnostic, message: error instanceof Error ? error.message : String(error) } });
            throw error;
        }
    } };
    const assembly = core.createAgentRunAssembly(bridge, {coreSession:cliSession.coreSession});
    try {
        const result = await assembly.run({ sessionsDir, sessionId, adapter, config, apiKey, prompt: task, permissionMode: mode, kernel: args.kernel, maxSteps: args.maxSteps, timeoutMs: args.timeoutMs, maxTotalOutputTokens: args.maxOutputTokens, kernelLimits: { timeoutMs: args.timeoutMs, ...(args.maxCost !== undefined ? {maxCost:args.maxCost}:{}) },
            ...(providerPricing ? {pricing:providerPricing}:{}),
            ...(mode === 'full' ? {approvalRequiredLevels:[]} : {}),
            onEvent: event => { },
            onProtocolEvent: envelope => emit({ type: 'agent-event', ...envelope })
        });
        const report = redact({ type: 'agent-report', sessionId, source: provenance.source, input: provenance.input, build, provider, kernel: args.kernel, finishReason: result.run.finishReason, state: result.kernel?.state ?? (result.run.finishReason === 'stop' ? 'completed' : result.run.finishReason), evaluation: 'unverified', evaluationReason: 'No independent task goal evaluator was supplied.', steps: result.run.steps, rolloutPath: result.rolloutPath, diagnostics: result.run.diagnostics ?? [], ...(result.kernel?.pendingApproval ? { pendingApproval: result.kernel.pendingApproval } : {}), transactions: result.kernel?.transactions ?? [], unresolvedCalls: result.kernel?.unresolvedCalls ?? [], ...(result.providerBudget ? { budget: result.providerBudget } : {}) });
        await writeFile(join(sessionsDir, `${sessionId}.report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        emit(report);
        return report;
    }
    finally {
        await assembly.waitForHostOperations?.();
        await cliSession.dispose();
    }
}
