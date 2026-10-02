# Agent runtime and headless execution

## Shared entry

Desktop, sfcli and deterministic evaluators call `createAgentRunAssembly` and `runAgentSession`. Tool definitions, permission levels, effects and parallel-read policy come from ToolRegistry. Existing native readers, automatic read proofs and Patch Engine remain authoritative; the control kernel never parses native resources or writes files itself.

Desktop sessions now run their provider/control loop in a fixed `agentUtility` utilityProcess. The main process retains workspace indexes, native handles, approvals and domain execution. RPC capabilities are allowlisted, payloads and queues are bounded, and worker death never causes a host mutation to replay. The next session can start a fresh worker; any unresolved operation must first be queried through the existing journal.

The finite kernel lives in `@soulforge/agent` and has no dependency on core, Electron, renderer or the domain index. It holds a bounded transcript and current calls. Time, step, output, context, response, result, queue and configured cost limits terminate explicitly. Model termination remains separate from independent task evaluation.

`agentHostComposition` now owns execution-option normalization, native/tool-session construction, live tool-context binding and bounded automatic RAG readiness. `createAgentRunAssembly` applies that same composition for desktop, CLI and evaluators. Desktop adapters supply Electron credentials, approval UI, secure resource/diff access, workspace storage and retrieval ports; CLI adapters supply local storage and explicit run options.

Host defaults remain explicit: desktop requests use 180 seconds unless overridden and always configure compaction at 80% of the trusted context window (500K tokens when absent). Headless runs retain their explicit 1,800-second default and do not gain automatic RAG or compaction ports. Renderer controls cannot replace provider configuration, permission grants or approval policy. Every tool call keeps the captured workspace/CoreToolSession, proof principal and edit session; replacement rejects the old request before domain dispatch or native session construction after asynchronous storage opening. A late committed result remains committed. Its refresh refuses a replacement host and reports that refresh failure separately; it cannot attach the replacement workspace's index to the old session.

## Headless CLI

Standalone CLI validation and public Windows/Linux CI use Node 22.22.0. Use that
verified runtime for `sfcli`. On the restored Debian 13 host, Node 24.19.0 with
better-sqlite3 12.11.1 loaded a small binding probe but aborted during SQLite
Statement garbage collection in the real `--analyze` request. The same source
and input completed under Node 22.22.0. This observation does not establish the
outcome for other Node 24 versions or platforms. Electron has its own runtime
and ABI binding evidence; do not substitute a standalone Node binding for it.

Use a UTF-8 task file or one argument value. JSON Lines events include protocolVersion, sessionId, runId, requestId and eventSeq. Reports bind the actual source checkout/difference, built code, input and provider configuration. Credentials come from the trusted host environment or the original encrypted `test` loader and remain in process memory. `--diagnostics` emits workspace and individual tool timing/error codes to stderr.

```sh
node tools/soulforge-cli/sfcli.mjs --workspace <isolated-overlay> --mode plan --json agent exec \
  --task-file task.txt --responses-file deterministic-responses.json

SOULFORGE_AGENT_API_KEY=<host-secret> node tools/soulforge-cli/sfcli.mjs \
  --workspace <isolated-overlay> --mode normal --json agent exec \
  --task-file task.txt --provider-config provider.json --max-cost 1
```

Real-provider configuration must supply protocol, model, baseUrl and pricing.inputPerMillion/pricing.outputPerMillion in the same currency as max-cost. The CLI refuses to start without a cost limit and prices. Its accounting reserves the requested output ceiling and a conservative input bound before every provider request, including retry/compaction requests. This is an upper-bound reservation, not a claim that unreported usage was zero.

The original encrypted test input needs no replacement provider JSON or vault save:

```sh
node tools/soulforge-cli/sfcli.mjs --workspace <owned-overlay> --mode plan --no-analyze --diagnostics agent exec \
  --task-file <UTF-8-task> --provider test --test-config <existing-private-test> \
  --max-cost <authorized-total> --input-price-per-million <current-input-price> \
  --output-price-per-million <current-output-price>
```

`--test-config` is optional: the existing loader searches repository `test`, current-directory `test`, then the repository's parent `test`. It decrypts the original `ivHex:base64Cipher` format, and configuration identity is reported as a hash without printing that input's URL/model/key. Prices use the same currency as the authorized limit. An execution budget does not grant credential transmission authority; the operator must supply an approved credential route before a real request. Deterministic `--responses-file` requires no provider credentials or network calls.

The existing desktop `agent:simulate` / `agent:simulate:four` consumer still uses the same loader in its isolated desktop host. Required task effects lacking an independent verifier no longer prevent model discovery or tool execution: every call retains production permission/native-read/staging/backup/journal checks, and final task outcomes remain passed, failed or unverified. A declared read-only contract runs in plan mode. The desktop test consumer's isolated vault setup and real requests need their own authorized credential route; the process-local CLI path avoids that persistent setup. Missing effect verification never turns a model stop into a passed task.

Noninteractive finite runs park concrete approval proposals with their payload hash and return `waiting`. `--protocol-stdin` adds a process-local JSON Lines approval/cancel host around the same shared assembly used by desktop. Each `agent-approval-request` supplies a unique `requestId`, `sessionId`, `runId`, `callId` and `proposalHash`. Reply with those exact fields, `protocolVersion: 1`, `type: "agent-approval-response"` and `decision: "approve"`, `"deny"` or `"cancel"`. Other IDs, hashes and decisions cannot settle the proposal; caller-supplied `timed_out` is refused. Approvals expire after 600 seconds, with a smaller positive `--approval-timeout-ms` available for bounded callers. The receipt authorizes only that proposal; existing mode, native proof, staging, backup, journal and commit checks still apply.

`agent-host-ready` identifies the live run's task `requestId`. A `type: "agent-cancel"` frame with that exact request/session/run scope cancels it. Input EOF/error, oversized input or an output consumer failure also cancel; they never approve. Pending output and partial input are byte bounded. The host joins already-started operations before disposing their resources and projects their authoritative request/journal outcomes into `hostRequests`. Kernel cancellation, a late committed transaction and an independent task verdict remain separate facts.

`--resume-session <rollout.jsonl>` loads the existing rollout into a fresh run with current host policy, fresh permissions and native proof ownership. It closes unanswered historical tool calls with read-only journal reconciliation, recording a hash of the selected history. Missing journal evidence stays `unknown` and cannot authorize replay. Old approval IDs, grants and tool calls are not resurrected. The model may make a fresh proposal through the normal current-run boundaries; resuming alone never dispatches a historical call.

```sh
node tools/soulforge-cli/sfcli.mjs --workspace <owned-overlay> --mode normal --json agent exec \
  --task-file task.txt --responses-file responses.json --protocol-stdin

node tools/soulforge-cli/sfcli.mjs --workspace <owned-overlay> --mode plan --json agent exec \
  --task-file next-task.txt --responses-file next-responses.json --resume-session <prior-rollout.jsonl>
```

Agent calls use session name `agent:<sessionId>` and request ID `<sessionId>:<callId>`. The integrated LocalSessionHost correlates operations with the existing transaction journal. Request status and transaction status are separate; an unknown/cancelled request cannot imply an uncommitted write or a safe retry. Only bounded transaction IDs/states enter model results, never raw journal filesystem paths.

## Comparison and completion limits

Desktop and CLI now use the same finite production kernel. The former loop has been removed; runAgentToolLoop is only a compatibility function forwarding to that shared kernel. The legacy production selector is rejected before provider or workspace work. Explicit comparison fixtures materialize a declared, source-bound control into test-owned output. The historical control `217234bb97ee20e3a83048042c4a1e67e9a16d33` is currently unavailable after the filesystem replacement. `public-main-c4` is an explicitly selected alternative with its own revision, loop and tree identities; it cannot be relabeled as that historical control. The optional agent-control-trace.experiment.mjs exercises retired heuristic triggers; production startup and unrelated convention checks do not need comparison history.

The bounded switch comparison ran four scenarios with both kernels, with identical deterministic transport, task, tools, sampling and neutral budgets. Both native mutations produced identical bytes under independent pinned SoulsFormatsNEXT readback. Read/no-op scenarios wrote nothing; a model falsely claiming success failed the independent goal. Inputs, sibling files and preserved native fields remained unchanged. The separate description-dedup experiment removed 24,248 serialized characters from 56 tool definitions; this is not a token or cost measurement.

Configured automatic RAG keeps its previous cadence: retrieve the fixed external task query once per run, then inject that evidence once per context window, including after successful compaction. Context/evidence and compaction remain host ports. The finite policy uses resource bounds and neutral retries, while retired semantic/discovery/conclusion heuristics stay only in the pinned experiment baseline. Budget stops, model stops, committed transaction outcomes and independent task verdicts remain distinct.

An empty initial Context Broker queue remains `insufficient_evidence` with `ok:false`; it now carries a warning instead of an execution error. This permits ordinary discovery without making unavailable evidence authoritative or claiming task success. Cancellation, timeout, identity conflicts and context-budget refusals retain their error diagnostics.

No paid provider comparison was run. Real-model quality and cost remain unverified. The remaining owner-defined experiment needs a selected provider/model, task/input set, spending limit and accepted independently evaluated outcomes; that experiment does not gate the implemented shared default. The owned comparison covers one pinned EMEVD fixture and does not prove game-runtime behavior or the previously reported main-process PARAM/preflight OOM root cause.

UI replay is a byte- and count-bounded window and exposes sequence gaps. The durable rollout remains the source for complete history. Slow or failed rollout storage fails closed at its queue budget rather than retaining unbounded copies. These two retention paths were reproduced and tested; process isolation and these caps do not prove every previously reported OOM root cause is fixed.

Bare PARAM row/field commits also invalidate the legacy full-payload cache before their caller-owned knowledge refresh. A deterministic actual-handler probe found that this cache previously retained stale row payloads after successful writes and served the old native hash on the next read. The same bounded fixture reduced sampled peak JS heap from 34.89 to 19.83 MiB in actual Electron 43 main, and from 41.87 to 26.67 MiB under standalone Node 24. This is a specific cache-retention/freshness fix, not proof of the historical full-workspace Electron main-process PARAM/preflight OOM. See [the scoped diagnosis and reproduction](experiments/param-postcommit-cache-memory.md) for RSS, owners, retained references, native verification, and unresolved runtime limits.
