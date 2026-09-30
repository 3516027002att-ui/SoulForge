# Agent runtime and headless execution

## Shared entry

Desktop, sfcli and deterministic evaluators call `createAgentRunAssembly` and `runAgentSession`. Tool definitions, permission levels, effects and parallel-read policy come from ToolRegistry. Existing native readers, automatic read proofs and Patch Engine remain authoritative; the control kernel never parses native resources or writes files itself.

Desktop sessions now run their provider/control loop in a fixed `agentUtility` utilityProcess. The main process retains workspace indexes, native handles, approvals and domain execution. RPC capabilities are allowlisted, payloads and queues are bounded, and worker death never causes a host mutation to replay. The next session can start a fresh worker; any unresolved operation must first be queried through the existing journal.

The finite kernel lives in `@soulforge/agent` and has no dependency on core, Electron, renderer or the domain index. It holds a bounded transcript and current calls. Time, step, output, context, response, result, queue and configured cost limits terminate explicitly. Model termination remains separate from independent task evaluation.

## Headless CLI

Use a UTF-8 task file or one argument value. JSON Lines events include protocolVersion, sessionId, runId, requestId and eventSeq. Reports bind the actual source checkout/difference, built code, input and provider configuration. Credentials are read from the trusted host environment and never written to events or reports.

```sh
node tools/soulforge-cli/sfcli.mjs --workspace <isolated-overlay> --mode plan --json agent exec \
  --task-file task.txt --responses-file deterministic-responses.json

SOULFORGE_AGENT_API_KEY=<host-secret> node tools/soulforge-cli/sfcli.mjs \
  --workspace <isolated-overlay> --mode normal --json agent exec \
  --task-file task.txt --provider-config provider.json --max-cost 1
```

Real-provider configuration must supply protocol, model, baseUrl and pricing.inputPerMillion/pricing.outputPerMillion in the same currency as max-cost. The CLI refuses to start without a cost limit and prices. Its accounting reserves the requested output ceiling and a conservative input bound before every provider request, including legacy retry/compaction requests. This is an upper-bound reservation, not a claim that unreported usage was zero.

Noninteractive finite runs park concrete approval proposals with their payload hash and return `waiting`; they never auto-approve. Writes still require the domain proof, staging, backup and commit boundaries. A waiting run needs a supported approval/resume host; this initial CLI does not infer approval from a previous run or automatically replay it.

Agent calls use session name `agent:<sessionId>` and request ID `<sessionId>:<callId>`. The integrated LocalSessionHost correlates operations with the existing transaction journal. Request status and transaction status are separate; an unknown/cancelled request cannot imply an uncommitted write or a safe retry. Only bounded transaction IDs/states enter model results, never raw journal filesystem paths.

## Comparison and completion limits

The CLI defaults to the finite kernel; `--kernel legacy` is an engineering comparison path. Desktop continues to use the existing loop in its new process host while controlled comparisons are pending. Provider transport, sampling, domain handlers and independent evaluation are reused. No real-provider comparative run or cost was incurred by the refactor tests.

Configured RAG/context and compaction remain host ports; the finite kernel does not retain a second complete corpus. The finite policy omits the legacy discovery-only/conclusion-correction heuristics while retaining hard budgets and neutral retry behavior. Deterministic checks establish protocol and boundary behavior, not real-model success rates. A full real-provider default switch remains unverified until the same task/input/provider/budget and independent validators can be compared.

UI replay is a byte- and count-bounded window and exposes sequence gaps. The durable rollout remains the source for complete history. Slow or failed rollout storage fails closed at its queue budget rather than retaining unbounded copies. These two retention paths were reproduced and tested; process isolation and these caps do not prove every previously reported OOM root cause is fixed.
