# Controlled Agent provider experiments

The executable harness prepares or runs one treatment over four pinned owned-resource tasks and both treatment variants. The old control implementation is the exact Git revision `217234bb97ee20e3a83048042c4a1e67e9a16d33`. Production remains on the shared finite kernel. These source-only preparations have made no paid calls and have not run game/vendor binaries.

Treatments are `description-dedup`, `automatic-vs-on-demand-rag`, and nine source-hash-bound on/off conditions: `empty-conclusion`, `future-action-conclusion`, `provider-length-conclusion`, `output-reserve-conclusion`, `identical-tool-failure`, `semantic-param-failure`, `research-stall-conclusion`, `candidate-native-nudge`, and `model-wording-partial`. Each command changes one treatment. The full default cutover does not isolate one heuristic.

Description variants use the same old kernel and shared system instructions; only per-tool repetition differs. RAG variants use the same pinned independent pre-read metadata, production lexical retriever and `retrieve_evidence` tool. Automatic retrieval/injection is compared with tool-requested retrieval; no embeddings or production RAG defaults change. Heuristic variants identify the exact original source hash and single condition hash. Actual control-message/diagnostic occurrences are reported; zero occurrence means the effect was unobserved. Source-only activation tests exercise all nine on/off pairs through the real old loop with fake transport and tools. Owned paths and workspace identities use reversible, equal model-visible aliases; native tool arguments restore each owned leg locator.

Create a provider JSON containing only `protocol`, `baseUrl`, `model`, `pricing` (`inputPerMillion`, `outputPerMillion`) and `currency`. Provider choice and prices must be explicit; the file must contain no credentials. Bind existing native inputs with `SOULFORGE_NATIVE_FIXTURE_ROOT`, `SOULFORGE_COMPARISON_DOTNET`/`DOTNET_ROOT`, and `SOULFORGE_COMPARISON_NEXT_ASSEMBLY`, or pass the corresponding paths. Missing or mismatched inputs report unavailable.

```sh
node scripts/run-agent-provider-experiment.mjs --dry-run \
  --experiment description-dedup --provider-config provider.json \
  --max-cost 1 --max-leg-cost 0.125 \
  --max-output-tokens 65536 --max-leg-output-tokens 8192 \
  --timeout-ms 1500000 --leg-timeout-ms 180000 --max-steps 8 --max-tokens 512 \
  --report new-dry-run-report.json
```

Dry-run validates and hashes source/build (including the native Bridge output), the exact baseline, tasks, resource, provider, sampling and budgets. It never reads a provider credential, opens a network connection or invokes native/vendor/game binaries. Budget values above are invocation examples, not authorization or provider recommendations.

The remaining owner choices are the selected provider/model, an explicit total spend ceiling and authorized credential access. After selection, official prices can be bound and conservative per-leg/time/token/step limits proposed while preserving sampling. These reproducibility parameters and the existing independent task/wrong-write/false-success criteria do not introduce separate approval gates. The reviewed invocation may then use `--execute` with an existing host-local `SOULFORGE_AGENT_API_KEY` and a new output directory. The harness does not configure credentials. Future execution copies the pinned resource into owned overlays, preserves original bytes, uses native proof/Patch Engine/journal boundaries, waits for actual host settlement and performs independent pinned NEXT readback. It never launches the game or replays an unresolved mutation.

Reports distinguish task verdict, wrong writes, structured false-success claims, control termination, runtime, provider-reported usage, configured-price estimates and billing-unverified actual cost. Non-JSON final claims remain unverified. Requested reads/read-before-mutation require observed target native evidence; an already-correct resource alone cannot pass an unread task. No-write task policy checks settled operations and the canonical transaction journal, including write-then-restore and committed no-op cases; final equal bytes alone do not erase those write facts. The counterfactual false-success task runs in plan mode and can truthfully report blocked. Every full rollout and resource/operation result remains available under the experiment output. The [report template](AGENT_PROVIDER_EXPERIMENT_REPORT.template.json) has no prefilled success or quality claim.

Adapter request attempts are reported separately from unverified network delivery. Raw numeric provider usage is captured before budget rejection; missing usage and actual billing stay unverified. Failed independent readback retains operation/journal facts and reports unavailable verification. No native readback result is inferred from model termination.
