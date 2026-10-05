# PARAM post-commit memory

## Observed cause and fix

`resource.readParamPage(..., loadAll=true)` keeps its complete native row payload in the module's `paramAllCache`. Both `resource.applyParamMutation` and `resource.applyParamFieldMutation` previously deleted only `paramPageCache` after a successful commit. The complete old document remained reachable during knowledge refresh, and a subsequent all-payload read returned its pre-write source hash without rereading Bridge.

The observed retaining chain is:

`registered PARAM handler/module environment → paramAllCache Map → CachedParamDocument → rows[] → dataBase64 strings`

The fixture bundles the actual `ipc/param.ts` source. A test-only footer exposes the existing Maps for inspection; it creates no additional references to their document values. The native transport and already-settled commit are deterministic seams. At the refresh callback, the old cache values are directly observable, including their row arrays. Forced GC after each cycle cannot release these values while they remain in the Map.

The minimal fix deletes the committed source's `paramAllCache` entry before knowledge refresh, alongside its existing page-cache invalidation. It does not alter commit, staging, native proof, transaction or retry authority. Other sources and failed writes keep their valid cache entries. A refresh failure still returns the committed result and runs refresh only once.

## Same-reproduction comparison

The fixed and baseline bundles use the same Node process role, fixture, sequencing and memory samples. The original measurements used a local baseline commit. The published equivalent for reproduction is `461387d7ecaa414fdc8647cc2eafc46da9114216`; its repository tree, PARAM Git blob and source SHA256 match the measured baseline exactly. The concise metadata retains the local execution identity as a historical measurement instead of relabeling it as a run of the published commit. Production code is never switched to either baseline. The fixture has 12 distinct sources in one workspace, each with 256 rows and a 4,096-byte payload per row. Each cycle reads the full projection, settles a row write, invokes the production caller-owned refresh boundary, forces GC, and samples.

| Measurement | Baseline | Fixed |
| --- | ---: | ---: |
| Sampled peak JS heap | 41.87 MiB | 26.67 MiB |
| Sampled peak host RSS | 125.99 MiB | 123.32 MiB |
| Final post-GC JS heap | 41.40 MiB | 24.80 MiB |
| Stale full-payload documents retained | 12 | 0 |
| Stale row payloads retained | 3,072 | 0 |

Peak JS heap decreased 36.3%, and sampled host RSS decreased 2.1%. RSS is allocator/process memory, not interchangeable with JS heap. Boundary samples are not a claim to catch every instantaneous allocation. See [the concise metrics and hash bindings](param-postcommit-cache-memory-summary.json) for runtime, exact byte measurements, and source/bundle/native/input identities.

Runtime: standalone Node `v24.19.0`, V8 `13.6.233.17-node.51`, actual heap limit `2,348,810,240` bytes. Electron is absent in this comparison. The actual PARAM IPC owner is exercised; the desktop's complete workspace refresh composition and database utility are not.

The same fixture also completed in actual Electron 43 main (`process.type=browser`), using the existing desktop smoke helper's owned HOME/XDG directories and explicit owned `--user-data-dir`, headless platform, and sandbox intact. The baseline and fixed runs both exited successfully. Native/commit seams remain deterministic, and the renderer/whole-desktop composition is still outside this fixture.

| Actual Electron main measurement | Baseline | Fixed |
| --- | ---: | ---: |
| Sampled peak JS heap | 34.89 MiB | 19.83 MiB |
| Final post-GC JS heap | 34.62 MiB | 18.18 MiB |
| Sampled peak main RSS | 179.27 MiB | 179.12 MiB |
| Stale documents / row payloads | 12 / 3,072 | 0 / 0 |

Electron peak heap decreased 43.2%; sampled main RSS decreased about 0.1%. Chromium startup/allocator memory dominates that RSS measure, so it should not be substituted for the stronger JS-heap/cached-object observation. This runtime was Electron `43.0.0`, Node `v24.17.0`, V8 `15.0.245.13-electron.0`, heap limit `4,395,630,592` bytes (4,192 MiB). The experiment only exposes GC for comparable boundaries; it does not change the heap limit. The concise summary includes handler source hashes, exact generated bundle hashes and runtime identity; full launch profiles remain in optional local experiment output.

## Native path checks and field projection retention

A separate no-provider/no-network probe uses an owned copy of the real Mod's ActionGuide PARAM child, the pinned Linux Bridge executable, actual `scanWorkspace`, native semantic decoding, staged native writing, Patch Engine commit, `refreshKnowledgeAfterCommit`, publication, reference rebuild and RAG build. Two writes changed the native `textId` from -1 to 0 to 1, with complete post-refresh typed values, 16 rows, 48 fields, 17 RAG chunks, and converged refreshes. The source input remained unchanged. This smaller path completed below 39 MiB sampled JS heap and 377 MiB sampled descendant-process RSS. It verifies the limited native sequence, not large-container OOM behavior.

The real packed Mod preflight separately produced 131 tables / 50,295 rows. A subsequent owned native PARAM/container write and Patch Engine commit completed. Its post-GC JS heap was 126.5 MiB and fell to 16.2 MiB after semantic invalidation. The run then exited 137 before its first native table-refresh progress event. No late heap snapshot was taken. Exit 137 alone does not establish an OOM or a product leak: cgroup memory counters and the memory-pressure interface are unavailable inside this executor, and its mount inventory has no cgroup mount. A new command uses a separate PID namespace, so it cannot independently inspect the terminated command's former Bridge descendants. The run's last phase checkpoint is preserved; it has no complete peak/allocation receipt for the failed step.

The subsequent bounded reproduction separates two additional allocation owners. Semantic refresh now uses the existing `list-bnd4-entries` directory command instead of the complete DCX/BND roundtrip and CRUD self-tests. On the same unchanged 1,009,714-byte Mod container and Bridge executable, a cold CLI read returned the same physical source hash, decoded payload hash and all 138 entry identities, sizes and offsets. Its 20 ms sampled native RSS was 444,239,872 bytes for the full document versus 120,455,168 bytes for the directory; elapsed time was 790 ms versus 203 ms. This single comparison is not a general latency benchmark. Explicit writer and format-validation checks are unchanged.

A refresh-only observation then cleanly stopped at a 384 MiB JS-heap observation budget while decoding the 7,790-row SpEffect table, after 118 tables. The sampled allocation profile primarily retained complete field-symbol objects. The decoder now shares equal immutable primitive field cells inside one table read, with at most 64 cached values per field. All visible metadata, field values and physical row receipts remain present; independent row vectors, metadata/reference-context changes, serialization, mutation isolation, NaN and negative zero have regression coverage. No automatic-RAG or reference-only default changed. The same refresh-only input now completes all 138 tables without diagnostics, with sampled peak heap 181,884,552 bytes and Node RSS 328,089,600 bytes; the earlier observation stopped at 408,734,744 bytes rather than measuring a completed baseline peak.

The complete owned preflight/write/knowledge/reference/RAG flow also completed twice with `--max-old-space-size=768`, a 768 MiB observed JS-heap stop budget, and the existing 1.5 GiB sampled process-tree budget. The measured total V8 heap limit was 1,006,632,960 bytes (960 MiB); the old-space flag and observation budget are not the total heap limit. Native `textId` changed -1→0→1. Both refreshes converged with 138 tables, 50,302 rows, 6,948,832 field cells and 50,303 RAG chunks. Peak sampled JS heap was 637,551,408 bytes, Node RSS 893,054,976 bytes and descendant-tree RSS 1,598,631,936 bytes. Post-GC completed heaps were 448,907,120 and 449,244,488 bytes; released heap was 107,208,608 bytes. Original input hashes stayed unchanged. These are actual standalone core/Bridge/commit runs, not the complete desktop renderer or historical 4,192 MiB Electron reproduction.

An initial Electron launch without the supported owned profile exited with SIGTRAP/133 before measurement. Reusing the repository's owned profile then completed both bounded main-process measurements; D-Bus/NETLINK/GPU startup warnings remained nonfatal. No socket restriction was bypassed, and the successful launches kept the sandbox intact. The reported full-workspace Electron main-process PARAM/preflight OOM, complete-game peak and remaining lifetime-only Maps still remain unproven. The focused IPC and standalone core results do not establish that the complete desktop historical reproduction is solved.

## Reproduce

Build this checkout's shared/core output first. The loader binds workspace imports to that output even if third-party dependencies are provided through a read-only link.

```sh
node --import ./scripts/param-memory-loader.mjs --test scripts/param-postcommit-cache.fixture.mjs
SF_PARAM_CACHE_SOURCE_REF=461387d7ecaa414fdc8647cc2eafc46da9114216 \
  node --expose-gc --import ./scripts/param-memory-loader.mjs \
  scripts/param-postcommit-cache-memory.experiment.mjs output/param-memory-evidence/node-before
node --expose-gc --import ./scripts/param-memory-loader.mjs \
  scripts/param-postcommit-cache-memory.experiment.mjs output/param-memory-evidence/node-after
SF_PARAM_CACHE_SOURCE_REF=461387d7ecaa414fdc8647cc2eafc46da9114216 \
  node scripts/run-param-ipc-cache-electron-memory.experiment.mjs output/param-memory-evidence/electron-before
node scripts/run-param-ipc-cache-electron-memory.experiment.mjs output/param-memory-evidence/electron-after
node --expose-gc --import ./scripts/param-memory-loader.mjs \
  scripts/param-refresh-memory.experiment.mjs \
  --source=output/native-inputs/ActionGuideParam.param \
  --bridge=bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/SoulForge.Bridge \
  --output=output/param-memory-evidence/native-small --rounds=2
# For the complete container flow, use the explicitly owned input location:
node --expose-gc --max-old-space-size=768 \
  scripts/param-refresh-memory.experiment.mjs \
  --source=output/native-inputs/gameparam.parambnd.dcx \
  --bridge=bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/SoulForge.Bridge \
  --output=output/param-memory-evidence/native-container --rounds=2
```

The native probe requires explicit inputs, copies its source into owned temporary storage, records executable/input/output hashes, samples JS heap and host/descendant RSS separately, saves small phase checkpoints and 1 MiB allocation profiles, and requests cancellation when observed JS heap exceeds 768 MiB, sampled aggregate RSS exceeds 1.5 GiB, or the run reaches four minutes. These observation budgets do not change the total V8 heap limit or guarantee capture of instantaneous spikes. The full-container runs above use bounded phase observations and the same heap/process-tree budgets; raw phase records also survive an unexpected VM termination where writable output remains available. The cache, directory and field-sharing regressions were observed failing before their fixes where applicable. The 13 directory/sharing cases, existing decoder/cancellation/streaming checks, adjacent 19 boundary cases and complete core aggregate passed; desktop typecheck also passed for the IPC fix.

Raw reports, launch receipts, phase checkpoints and allocation profiles are optional local experiment output. The full captured receipts are retained under the ignored `output/.local-validation/` owner; they are not mandatory artifacts or acceptance gates. The reproduction commands generate new optional receipts, while the focused behavior regressions remain ordinary discovered checks.
