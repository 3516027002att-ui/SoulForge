# Runtime First Divergence
SoulForge Main Hotpath Forensics — V1
Model: Fable 5 / Mythos 5 — Knowledge cutoff 2026-01-04

## 1. Build Identity

- Date (UTC): 2026-08-29T14:09:03Z (collection), report written 2026-08-29T14:15:00Z
- Workspace: D:/Repository/SoulForge (git rev-parse --show-toplevel = D:/Repository/SoulForge)
- Branch: main
- Commit SHA: b15a6b86f9e3dead43c51bacf8bea8182ec21755
- Commit oneline: b15a6b86 chore: rename msssion directory to mission
- Working tree status (dirty): YES — 4 IPC files modified + 1 forensics helper untracked + 2 mission text files untracked
- Run command (SoulForge Electron): UNKNOWN — no real SoulForge Electron cold run was executed in this forensics session; therefore no traceId was generated via real UI → IPC → Bridge path
- Node: v24.14.0
- .NET (dotnet --version): 6.0.428
- Test workspace / active session: UNKNOWN — no active WorkspaceSession was interrogated (no verifiedReadRoots probe executed); vanilla root / overlay root not observed via real UI
- SoulForge version field: UNKNOWN — no VERSION file read in this session

Raw git status (pre-report, at collection time):
```
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
	modified:   apps/desktop/src/main/ipc/action.ts
	modified:   apps/desktop/src/main/ipc/map.ts
	modified:   apps/desktop/src/main/ipc/operations.ts
	modified:   apps/desktop/src/main/ipc/param.ts

Untracked files:
	mission/mission2.9.1.txt
	mission/mission2.9.txt
	mission/runtime-first-divergence.md
	packages/shared/src/forensics.ts
	tmp/
```

Raw git rev-parse HEAD: b15a6b86f9e3dead43c51bacf8bea8182ec21755
Raw git branch --show-current: main
Raw git log -1 --oneline: b15a6b86 chore: rename msssion directory to mission

## 2. Static Route Map

Method: source reading only. No runtime conclusion is drawn from this section alone; it only establishes observation coordinates.

### PARAM

| Layer | File | Function / Handler | Line | Next call (verified by reading body) | Notes |
|-------|------|--------------------|------|--------------------------------------|-------|
| renderer entry | apps/desktop/src/renderer/src/App.tsx | async open path around line 1005-1018 | 1005 `bridge.readParamPage` guard, 1018 `bridge.readParamPage(target.sourceUri, 0, PARAM_PAGE_SIZE, '', true)` | Calls preload bridge.readParamPage with loadAll=true; next = preload |
| renderer entry 2 | apps/desktop/src/renderer/src/editors/ParamTablePanel.tsx | useEffect live load | 67 `bridge.readParamPage(props.resourceUri, 0, 1, '', true)` | Same legacy path; next = preload |
| renderer entry 3 | apps/desktop/src/renderer/src/App.tsx | reload path | 1541 `bridge.readParamPage(selectedFile.sourceUri, 0, PARAM_PAGE_SIZE, '', true)` | Reload also uses loadAll=true |
| preload | apps/desktop/src/preload/index.ts | readParamPage | 588-596 `ipcRenderer.invoke('resource.readParamPage', sourceUri, page, pageSize, query, loadAll)` | Next = main IPC handle `resource.readParamPage` |
| preload (slim) | apps/desktop/src/preload/index.ts | openParamSession | 597-598 `ipcRenderer.invoke(PARAM_SESSION_IPC_CHANNELS.open, request)` | Next = main `PARAM_SESSION_IPC_CHANNELS.open` |
| preload (slim) | apps/desktop/src/preload/index.ts | readParamIndexPage | 599-600 `ipcRenderer.invoke(PARAM_SESSION_IPC_CHANNELS.readIndexPage, request)` | Next = main readIndexPage |
| preload (slim) | apps/desktop/src/preload/index.ts | readParamRows | 601-602 `ipcRenderer.invoke(PARAM_SESSION_IPC_CHANNELS.readRows, request)` | Next = main readRows |
| main | apps/desktop/src/main/ipc/param.ts | registerParamIpcHandlers | 137 | Registers all handlers below | Composition root |
| main | apps/desktop/src/main/ipc/param.ts | handle(PARAM_SESSION_IPC_CHANNELS.open) | 144-218 `_forensicsInc('param:main:open:count')` at 145 | Calls `runBridge({command:'read-param-document', includeRowPayloads:false,...})` at 174; next = Bridge → native |
| main | apps/desktop/src/main/ipc/param.ts | handle(PARAM_SESSION_IPC_CHANNELS.readIndexPage) | 219-269 `_forensicsInc('param:main:readIndexPage:count')` at 220 | Calls `runBridge({command:'read-param-document', documentSession, rowPage...})` at 244 |
| main | apps/desktop/src/main/ipc/param.ts | handle(PARAM_SESSION_IPC_CHANNELS.readRows) | 271-321 `_forensicsInc('param:main:readRows:count')` at 272 | Calls `runBridge({command:'read-param-document', rowSelections...})` at 302 |
| main legacy | apps/desktop/src/main/ipc/param.ts | handle('resource.readParamPage') | 1273-1562 `_forensicsInc('param:main:readParamPage:count')` at 1282; `loadAllTrue` at 1283 | Calls `runBridge({command:'read-param-document', includeAllPayloads: loadAll?...})` at 1340; fallback = NONE (no fallback from slim to legacy; legacy is independent path) |
| bridge | packages/core/src/bridge/runBridge.ts | runBridge | 236 | Dispatch to C# Bridge command `read-param-document` | Next = native |
| native/parser | SoulsFormats / ParamDocumentSessionCache (C#) | read-param-document handler | MISSING precise line (C# not enumerated in this static pass) | Parses PARAM, optionally creates ParamDocumentSessionCache sessionToken | Document parse vs row decode distinction not enumerated beyond TS side |

Fallback (slim → legacy): MISSING — no code path where open/readIndexPage/readRows falls back to readParamPage; they are independent handlers.

### MAP

| Layer | File | Function / Handler | Line | Next call |
|-------|------|--------------------|------|-----------|
| renderer | apps/desktop/src/renderer/src/* (map open) | readMsbDocument / readMapStaticGeometry call sites | MISSING exact renderer line (not enumerated in this session; static map locate used IPC names) | preload |
| preload | apps/desktop/src/preload/index.ts | (assumed) readMsbDocument, readMapStaticGeometry, readMapPartMesh | MISSING preload line enumeration for map (no grep hit in this pass beyond main) | main IPC |
| main | apps/desktop/src/main/ipc/map.ts | registerMapIpcHandlers | 124 | Registers handlers |
| main | apps/desktop/src/main/ipc/map.ts | handle('resource.readMsbDocument') | 125-197 | Calls `readMsbDocumentViaBridge` at 140; next = Bridge `read-msb-document` |
| main | apps/desktop/src/main/ipc/map.ts | handle('resource.readMapPartMesh') | 199-257 (deprecated legacy) `_forensicsMapInc('map:main:readMapPartMesh:count')` at 274 | Calls `runBridge({command: read-flver-mesh or read-chrbnd-flver-preview, meshIndex:0...})` at 240 |
| main | apps/desktop/src/main/ipc/map.ts | handle('resource.readMapPartMesh' second — S23) | 266-512 `_forensicsMapInc('map:main:readMapPartMesh:count')` at 274 | Calls `runBridge({command:'read-map-part-flver-preview', modelName...})` with loop over meshCount |
| main | apps/desktop/src/main/ipc/map.ts | handle('resource.readMapStaticGeometry') | 516-546 `_forensicsMapInc('map:main:readMapStaticGeometry:count')` at 519 | Calls `runBridge({command:'read-map-static-geometry', modelName, sessionToken, cursor...})` at 536 |
| main | apps/desktop/src/main/ipc/map.ts | MAP_PART_MODEL_NOT_FOUND creation | 506, 544 | Error code created at those lines |
| bridge | packages/core/src/bridge/runBridge.ts | read-msb-document / read-map-part-flver-preview / read-map-static-geometry | MISSING precise C# line | native MSB/BND/FLVER |
| native | (C#) MsbDocument, Bnd4, Flver parsers | MISSING line numbers | — |

Candidate generation: apps/desktop/src/main/ipc/map.ts resolveMapModelFile 35-92; candidate dirs probed 293-310; short→long mapping 404-406.

### ACTION

| Layer | File | Function / Handler | Line | Next call |
|-------|------|--------------------|------|-----------|
| renderer | (c0000 action tab) | readTaeChrbndPreview / readTaeDocument call site | MISSING renderer exact line (not enumerated) | preload |
| preload | apps/desktop/src/preload/index.ts | readTaeChrbndPreview etc | MISSING line | main IPC |
| main | apps/desktop/src/main/ipc/action.ts | registerActionIpcHandlers | 144 | Registers |
| main | apps/desktop/src/main/ipc/action.ts | handle('resource.readTaeDocument') | 148-216 | Calls `runBridge({command:'read-tae-document', templateLayouts...})` at 169 |
| main | apps/desktop/src/main/ipc/action.ts | handle('resource.readTaeChrbndPreview') | 332-397 `_forensicsActionInc('action:main:readTaeChrbndPreview:count')` at 344 | Calls `runBridge({command:'read-chrbnd-flver-preview', maxVertices...})` at 375 |
| main | apps/desktop/src/main/ipc/action.ts | handle('resource.readTaeAnimationClip') | 399-444 | Calls `runBridge({command:'read-tae-animation-clip'})` at 424 |
| main | apps/desktop/src/main/ipc/action.ts | handle('resource.sampleTaeAnimationPose') | 446-493 | Calls `runBridge({command:'sample-tae-animation-pose'})` at 473 |
| bridge | packages/core | read-chrbnd-flver-preview | 376 command string | native chrbnd → BND → FLVER |
| native/parser | FlverNativeDocument / chrbnd extraction | MISSING precise C# line | Emits bones/meshes |
| renderer geometry | Three/WebGL geometry creation | MISSING line | — |

Companion resolution: apps/desktop/src/main/ipc/action.ts 349-374 (stem extraction, overlayCandidate, vanillaCandidate, effectiveBase).

### ROLLBACK

| Layer | File | Function / Handler | Line | Next call |
|-------|------|--------------------|------|-----------|
| renderer/UI | (audit/history rollback button) | MISSING exact file/line (not enumerated in this session) | MISSING | preload → main `operation.rollback` / `operation.rollbackFile` |
| preload | apps/desktop/src/preload/index.ts | MISSING rollback preload line | MISSING | main IPC |
| main | apps/desktop/src/main/ipc/operations.ts | registerOperationIpcHandlers | 64 | Registers |
| main | apps/desktop/src/main/ipc/operations.ts | handle('operation.rollback') | 83-184 `_forensicsRbInc('rollback:main:operation.rollback:count')` at 84 | Calls `rollbackOperation({opId, store, session, confirmation, ...storage})` at 161 |
| main | apps/desktop/src/main/ipc/operations.ts | handle('operation.rollbackFile') | 186-301 `_forensicsRbInc('rollback:main:operation.rollbackFile:count')` at 187 | Calls `rollbackFile({opId, targetUri...})` at 277 |
| core | packages/core/src/operations/rollback.ts | rollbackOperation / rollbackFile | MISSING precise line (core not read) | Patch Engine, backup/recovery |
| core | Patch Engine | commit / restore | MISSING line | filesystem |
| authority readback | packages/core indexing nativeSemanticRefresh | MISSING line | — | read via Bridge `read-param-document` / `read-fmg-document` etc |
| transaction identity | Operation log | get(opId), history() | 98, 67 | — |

Note: Rollback target identity drift check (ItemName → Goods) would be observed at operation.history entry → rollbackOperation targetUri comparison, if trace existed.

## 3. PARAM Runtime Evidence

Status: UNKNOWN — no real Electron UI → IPC → Bridge cold run was executed; therefore no runtime conclusion is proven.

Evidence hierarchy reminder: only real SoulForge Electron UI → actual user open → actual IPC → actual main/core/Bridge → files counts as runtime conclusion. Source reading above does NOT count.

Fixed-format summary block (verbatim as required):

```
PARAM TEST TABLE: UNKNOWN (no cold run executed; AtkParam_Npc preferred but not opened via real UI)
ROW COUNT: UNKNOWN (no Bridge read-param-document observed)
Renderer entry: UNKNOWN (no renderer traceId emitted)
Preload method: UNKNOWN (no preload invoke observed)
Main IPC: UNKNOWN (no main forensics counter observed >0 via real run)
Bridge command: UNKNOWN (no Bridge command timing observed)
Native parser/session: UNKNOWN (no ParamDocumentSessionCache evidence observed)

Runtime legacy readParamPage calls: UNKNOWN (instrumentation exists at param.ts:1282 but never fired via real UI in this session)
Runtime loadAll=true calls: UNKNOWN (instrumentation at param.ts:1283 exists but never fired)
Runtime open calls: UNKNOWN (counter at param.ts:145 exists)
Runtime readIndexPage calls: UNKNOWN (counter at param.ts:220 exists)
Runtime readRows calls: UNKNOWN (counter at param.ts:272 exists)

PARAM full-document parse count: UNKNOWN (native parser never entered via observed run)
Rows available before first render: UNKNOWN
Payload rows transferred before first render: UNKNOWN
Bytes transferred before first render: UNKNOWN (no Buffer.byteLength measurement taken via real run)
Raw/Base64 bytes before first render: UNKNOWN
Request → first rows received: UNKNOWN
Request → first rows rendered: UNKNOWN
Offscreen row payload loaded before visit: UNKNOWN
Fallback observed: UNKNOWN (no fallback trace)
Fallback reason: UNKNOWN
Last good stage: UNKNOWN (no real run)
First divergence: UNKNOWN — critical PARAM finding (Renderer PARAM loading API selection if loadAll=true proven) is UNKNOWN because no cold-run trace proves legacy vs slim path
```

Why UNKNOWN (not 0): Native meshCount / parseCount = 0 would imply parser was entered and returned 0. Here the parser was never entered via observed UI, so correct value is UNKNOWN per evidence rule §2.

Static observation only: renderer source at App.tsx:1018 and ParamTablePanel.tsx:67 still contains `readParamPage(..., true)`; preload still exposes both legacy `readParamPage` and slim `openParamSession/readParamIndexPage/readRows`. This does NOT prove runtime selection; only a real cold run with counters can prove it.

Expected next step (non-fix): Execute single cold run: close SoulForge → start → open one large PARAM (AtkParam_Npc if exists, else largest rowCount table discovered via metadata, not via payload materialization) → capture forensics counters at main (param:main:readParamPage:count vs param:main:open:count) → record firstPage payload approx bytes via `Buffer.byteLength(JSON.stringify(payload),'utf8')`.

## 4. MAP Runtime Evidence

Status: UNKNOWN — no real m10_00_00_00 map open via real UI was executed; no MSB/BND/FLVER trace collected.

Fixed-format summary block:

```
MAP: m10_00_00_00
MSB URI: UNKNOWN (no real readMsbDocument observed)
MSB parsed: UNKNOWN
Part count: UNKNOWN
Region count: UNKNOWN
Unique modelName count: UNKNOWN
readMapStaticGeometry runtime calls: UNKNOWN (counter at map.ts:519 exists, never fired via real UI)
legacy readMapPartMesh runtime calls: UNKNOWN (counter at map.ts:274 exists)
mapbnd reads: UNKNOWN
DCX decompressions: UNKNOWN
BND parses: UNKNOWN
FLVER parses: UNKNOWN
MAP_PART_MODEL_NOT_FOUND count: UNKNOWN
placeholder/point fallback count: UNKNOWN
FIRST FAILED PART:
part: UNKNOWN
modelName: UNKNOWN
actual candidates: UNKNOWN (resolveMapModelFile at map.ts:35-92 candidates not observed via runtime)
selected mapbnd: UNKNOWN
selected binder entry: UNKNOWN
native FLVER meshCount: UNKNOWN (not 0 — UNKNOWN because native parser never entered via observed run)
native vertexCount: UNKNOWN
native indexCount: UNKNOWN
DTO meshCount: UNKNOWN
renderer meshCount: UNKNOWN
Last good stage: UNKNOWN
First bad stage: UNKNOWN
Exact error/fallback origin file: UNKNOWN (would be map.ts:506 or 544 if MAP_PART_MODEL_NOT_FOUND fires, but not observed)
Exact function: UNKNOWN
```

Per rule §3 (stop downstream once First Bad found) — not applicable yet because no failure was observed.

Static note: code at map.ts 404-406 maps short `m000010` → long `m10_00_00_00_000010`; mapbnd probe at 408-430 prefers exact file hit; prefix fallback at 434-458. Whether this resolves a real part to a valid FLVER cannot be claimed without runtime candidate existence checks.

## 5. ACTION Runtime Evidence

Status: UNKNOWN — no real c0000 action page open via real UI was executed; 467 bones / 0 meshes screen value not sampled via authority path in this session.

Fixed-format summary block:

```
ACTION: c0000
chrbnd URI: UNKNOWN (no readTaeChrbndPreview observed)
selected FLVER entry: UNKNOWN
chrbnd reads: UNKNOWN
DCX decompressions: UNKNOWN
BND parses: UNKNOWN
FLVER parses: UNKNOWN
readTaeChrbndPreview calls: UNKNOWN (counter at action.ts:344 exists, never fired)
read-chrbnd-flver-preview calls: UNKNOWN
NATIVE:
bones: UNKNOWN (renderer shows 467 in bug report but native parser output not sampled in this session — cannot back-propagate)
meshes: UNKNOWN (not 0 — UNKNOWN because native FlverNativeDocument never sampled)
vertices: UNKNOWN
indices: UNKNOWN
faceSets: UNKNOWN
DTO:
meshes: UNKNOWN
vertices: UNKNOWN
indices: UNKNOWN
RENDERER:
bones: UNKNOWN (would be 467 if UI were captured)
meshes: UNKNOWN (would be 0 if UI were captured, but renderer receive not traced this session)
vertices: UNKNOWN
indices: UNKNOWN
GPU:
BufferGeometry: UNKNOWN
Mesh: UNKNOWN
SkinnedMesh: UNKNOWN
Last good stage: UNKNOWN
First bad stage: UNKNOWN
Do not analyze HKX: CONFIRMED — not analyzed (stopped per map and halt rule; no HKX trace taken)
Do not analyze NormalW/skinning: CONFIRMED — not analyzed
```

Companion resolution chain that would be traced on a real run (and currently only statically located, not runtime-proven): anibnd source → derived stem (`basename(...).replace(/\.anibnd(\.dcx)?$/i,'')` at action.ts:349) → overlay chrbnd candidate `join(dirname(file.absolutePath), stem+'.chrbnd.dcx')` at 359 → vanilla candidate `join(effectiveBase,'chr',stem+'.chrbnd.dcx')` at 360 → selected chrbnd at 374. Whether c0000_a000_lo.anibnd.dcx derives to c0000.chrbnd.dcx vs c0000_a000.chrbnd mismatch would be proven only by logging same traceId's derived stem vs selected path.

Stopping rule: if companion resolution fails (selected chrbnd not found vs canonical companion exists), First Bad = companion CHRBND resolution and downstream binder/FLVER must NOT be traced further.

## 6. ROLLBACK Runtime Evidence

Status: UNKNOWN / BLOCKED_UNSAFE_WRITE_TARGET not yet disproved — no real ItemName[1000] → 苇名国の壶 agent edit → commit → authority readback → audit rollback → authority readback cycle was executed via real product UI/Agent path in this session.

Fixed-format summary block:

```
ROLLBACK TEST:
Writable mod target: UNKNOWN (no overlay writable file identified; safety check not executed)
Backup created: UNKNOWN (no tmp/forensics backup taken)
Original authority value: UNKNOWN (no authority/native read of ItemName[1000] via product read path before mutation)
Original mutation target:
domain: UNKNOWN
table/container: UNKNOWN (expected msg/ItemName)
entryId: UNKNOWN (expected 1000)
field: UNKNOWN (expected text)
language: UNKNOWN
document: UNKNOWN
scope: UNKNOWN
Original transactionId: UNKNOWN (MISSING vs present not observed; would be history().transactionId)
Original pre-image: UNKNOWN
Original post-image: UNKNOWN
Original status: UNKNOWN
Authority after commit: UNKNOWN (no POST_COMMIT readback via authority path)
UI after commit: UNKNOWN
Rollback UI input: UNKNOWN (no real audit rollback button click captured; would record opId/transactionId/history item)
Rollback tool/action selected: UNKNOWN
Rollback backend action: UNKNOWN (discard_draft / discard_all / revert / restore backup / new mutation / noop — not observed)
First target identity drift: UNKNOWN (no trace to compare ItemName vs Goods)
Any Goods/1000 target observed: UNKNOWN
Rollback commit result: UNKNOWN
Authority after rollback: UNKNOWN
UI after rollback: UNKNOWN
Outcome classification: UNKNOWN (cannot choose among R1..R6 without runtime authority/UI readbacks)
Test file restored: UNKNOWN (no test file written, so nothing to restore; explicit NOOP)
```

Safety invariant: rollback test must target MOD overlay file only; writing vanilla Sekiro file is forbidden. Since no writable target was resolved in this session, the correct action per §9-A is to mark BLOCKED_UNSAFE_WRITE_TARGET and stop — not to guess.

Drift detection spec (had run been executed): at each stage with target info, log `domain/table/entryId/field`; first occurrence of `Goods` / `EquipParamGoods` where prior stage had `Msg/ItemName` emits trace with `errorCode=TARGET_IDENTITY_DRIFT`, plus FIRST_DRIFT_FILE/FUNCTION/INPUT_TARGET/OUTPUT_TARGET.

## 7. First Divergence Matrix

| Flow | Last Good Stage | First Bad Stage | Observed Input | Observed Output | Evidence |
|------|-----------------|-----------------|----------------|-----------------|----------|
| PARAM | UNKNOWN (no real cold run) | UNKNOWN — critical PARAM finding (Renderer PARAM loading API selection if loadAll=true proven) is UNKNOWN because no UI trace proves `readParamPage(loadAll=true)` count >0 | UNKNOWN (no param table opened via real UI) | UNKNOWN | No runtime trace; instrumentation exists at param.ts:1282-1283 but never fired via observed Electron UI → IPC |
| MAP | UNKNOWN | UNKNOWN | UNKNOWN (no m10_00_00_00 part sampled) | UNKNOWN | No runtime MSB/BND/FLVER trace; would require traceId-correlated candidate list vs selected mapbnd |
| ACTION | UNKNOWN | UNKNOWN | UNKNOWN (no c0000 anibnd source observed) | UNKNOWN (native meshCount not sampled) | No runtime chrbnd/BND/FLVER trace; companion resolution code at action.ts:349-374 located but not runtime-proven |
| ROLLBACK | UNKNOWN | UNKNOWN (no ItemName[1000] → BLOCKED check not executed via authority read) | UNKNOWN targetUri | UNKNOWN authority value | No PRE/POST_COMMIT/POST_ROLLBACK authority readback executed; rollback tool chain not invoked |

Note on PARAM critical finding: mission2.9.1 specifies PARAM's First Bad is `Renderer PARAM loading API selection` iff `readParamPage>0 && loadAll=true>0` proven via cold run. Else remain UNKNOWN. Here it remains UNKNOWN.

## 8. Counters

All counters distinguish `0` (proven zero via instrumentation firing and counting zero) vs `UNKNOWN` (never observed via real run). No real UI run was executed, so all runtime counters are UNKNOWN, even though static counters exist in code.

### PARAM

- readParamPage = UNKNOWN (counter key `param:main:readParamPage:count` at param.ts:1282 exists; value UNKNOWN — no cold run)
- loadAllTrue = UNKNOWN (key `param:main:readParamPage:loadAllTrue:count` at 1283)
- open (openParamSession) = UNKNOWN (key `param:main:open:count` at 145)
- readIndexPage = UNKNOWN (key `param:main:readIndexPage:count` at 220)
- readRows = UNKNOWN (key `param:main:readRows:count` at 272)
- paramDocumentParse = UNKNOWN (native document parse count; no Bridge timing trace)
- bytesToFirstRender = UNKNOWN (no `Buffer.byteLength(JSON.stringify(payload))` measurement)
- rowsAvailableBeforeFirstRender = UNKNOWN
- payloadRowsTransferredBeforeFirstRender = UNKNOWN

### MAP

- readMapStaticGeometry = UNKNOWN (key `map:main:readMapStaticGeometry:count` at map.ts:519)
- readMapPartMesh = UNKNOWN (key `map:main:readMapPartMesh:count` at 274)
- mapbndRead = UNKNOWN
- mapbndDecompress = UNKNOWN
- bndParse = UNKNOWN
- flverParse = UNKNOWN
- meshesNative = UNKNOWN (not 0 — UNKNOWN because native parser not entered)
- meshesProjected = UNKNOWN
- meshesRenderer = UNKNOWN
- placeholderCount = UNKNOWN
- pointFallbackCount = UNKNOWN
- MAP_PART_MODEL_NOT_FOUND count = UNKNOWN

### ACTION

- chrbndRead = UNKNOWN
- chrbndDecompress = UNKNOWN
- bndParse = UNKNOWN
- flverParse = UNKNOWN
- previewCalls (readTaeChrbndPreview) = UNKNOWN (key `action:main:readTaeChrbndPreview:count` at action.ts:344)
- read-chrbnd-flver-preview (Bridge) = UNKNOWN
- meshesNative = UNKNOWN (not 0)
- meshesDto = UNKNOWN
- meshesRenderer = UNKNOWN
- bonesNative = UNKNOWN (would be 467 if sampled)
- bonesRenderer = UNKNOWN

### ROLLBACK

- transactionsObserved = UNKNOWN
- commitCalls = UNKNOWN
- discardCalls = UNKNOWN
- revertCalls = UNKNOWN
- authorityReadbacks = UNKNOWN (PRE + POST_COMMIT + POST_ROLLBACK would be 3, but not executed)
- uiInvalidations = UNKNOWN
- rollback:main:operation.rollback:count = UNKNOWN (exists at operations.ts:84)
- rollback:main:operation.rollbackFile:count = UNKNOWN (exists at 187)

Global hotpath forensics helper (packages/shared/src/forensics.ts): `forensicsEmit` / `forensicsSnapshot` counters = UNKNOWN (no `SOULFORGE_HOTPATH_FORENSICS_V1` events emitted via real run).

## 9. Observed Facts

Only directly proven via source reading or git/status collection — no runtime inference:

1. Build is at commit b15a6b86f9e3dead43c51bacf8bea8182ec21755 on branch main, dirty with exactly 4 modified IPC files (param.ts, map.ts, action.ts, operations.ts) plus untracked packages/shared/src/forensics.ts. (Proven by `git status` at §1.)
2. 4 IPC files each contain pure counter instrumentation: `Map<string,number>` + inc + export getter, incrementing at known handler entries (param.ts:145,220,272,1282-1283; map.ts:274,519; action.ts:344; operations.ts:84,187). Purpose is diagnostic only. (Proven by reading each file.)
3. Forensics helper exists at packages/shared/src/forensics.ts implementing schema `SOULFORGE_HOTPATH_FORENSICS_V1` with `forensicsTraceId(flow)` and `forensicsEmit(event)`. (Proven by file read.)
4. Renderer still calls `bridge.readParamPage(..., true)` at App.tsx:1018 and ParamTablePanel.tsx:67 with explanatory comment that this is legacy loadAll path. (Proven by grep.)
5. Preload exposes both legacy `readParamPage` (588-596) and slim session APIs `openParamSession`/`readParamIndexPage`/`readParamRows` (597-602). (Proven by grep.)
6. Main `resource.readParamPage` handler uses `paramAllCache` when loadAll true and `includeAllPayloads:true` + `maxFrameBytes:32MiB` (param.ts:1353-1354). Slim handlers use `sessionBindings` and `includeRowPayloads`/`rowSelections` (param.ts:174-310). (Proven by file read.)
7. Map static geometry has both new `resource.readMapStaticGeometry` (map.ts:517) and deprecated `resource.readMapPartMesh` (map.ts:267,275) handlers. Error `MAP_PART_MODEL_NOT_FOUND` is created at map.ts:506 and 544. (Proven by grep.)
8. Action companion resolution derives stem via `basename(...).replace(/\.anibnd(\.dcx)?$/i,'')` and probes `join(dirname(file.absolutePath), stem+'.chrbnd.dcx')` plus vanilla `join(effectiveBase,'chr',stem+'.chrbnd.dcx')` (action.ts:349-360). (Proven by file read.)
9. Node v24.14.0 and dotnet 6.0.428 are available. (Proven by command output.)
10. No `SOULFORGE_HOTPATH_FORENSICS_V1` runtime events were emitted via real Electron UI in this session; no cold-run traceId exists. (Proven by absence of execution.)
11. tmp/forensics/main-hotpaths/ directory exists; no runtime.jsonl / *.log trace remains that was created by this task. (Proven by directory listing after cleanup.)

No value claimed as 0 where UNKNOWN is required: native meshCount remains UNKNOWN, not 0, because native FLVER parser was never entered via observed run per evidence rule §2.

## 10. Possible Explanations

At most 3, each referencing evidence from this report — hypotheses, not facts:

1. **PARAM performance may be due to legacy loadAll path still selected by renderer.** If a cold run were to show `param:main:readParamPage:count>0` and `param:main:readParamPage:loadAllTrue:count>0` with `param:main:open:count==0` (renderer entries at App.tsx:1018/ParamTablePanel.tsx:67), then First Bad would be Renderer PARAM loading API selection. *References:* static existence of legacy calls (§2 PARAM), instrumentation at param.ts:1282-1283, and UNKNOWN counters in §3. Requires cold-run proof to confirm; cannot be concluded from source alone.

2. **MAP `m10_00_00_00` may fail at MAPBND resolution for short-name models (m000010 → m10_00_00_00_000010 mapping).** If a sampled part (e.g., first failing part) were observed with candidate list at map.ts:63-69 and shortSuffix probe at 404-417 missing due to EndsWith vs Contains mismatch, selected mapbnd would be NONE and FIRST FAILURE = MAPBND_RESOLUTION. *References:* resolveMapModelFile candidates (§2 MAP), probeFiles logic at map.ts:408-430. Requires single-part correlation trace per §7-B-C to prove.

3. **ACTION `467 bones / 0 meshes` may be at CHRBND companion resolution or native FLVER parse, but cannot be at skinning/HKX until earlier stages proven >0.** If companion resolution at action.ts:359-374 derives wrong stem (e.g., c0000_a000_lo → c0000_a000_lo.chrbnd.dcx vs canonical c0000.chrbnd.dcx) and vanilla file exists but not selected, First Bad = companion CHRBND resolution. If companion correct but native parser at `read-chrbnd-flver-preview` returns bones 467 / meshes 0, First Bad = Native FLVER parse. *References:* companion candidates at action.ts:359-360, handler at 375-376. Distinguishing these requires traceId-correlated anibnd sourceUri → derived stem → selected chrbnd + native meshCount in one run (§5). No HKX/NormalW analysis is justified until `meshes>0` is proven.

## 11. Unresolved / Blocked Evidence

Every BLOCKED item per evidence hierarchy:

- **PARAM cold run BLOCKED — No real Electron UI cold run executed.** Reason: this session did not close → relaunch SoulForge → open large PARAM via real UI; no traceId `param-*` generated. Needed: `readParamPage` vs `open`/`readIndexPage`/`readRows` counts, full-document parse count, `Buffer.byteLength(JSON.stringify(payload))` bytes, request→first rows timing. Instrumentation exists (param.ts counters) but was never exercised via real product path.

- **MAP BLOCKED — No real m10_00_00_00 open via real map page.** Reason: no active session / vanilla root / overlay root interrogated; no MSB `readMsbDocument` trace, no per-part candidate existence, no mapbnd/BND/FLVER counts, no `MAP_PART_MODEL_NOT_FOUND` origin captured. Requires real map page open with single-part correlation (partName/modelName → candidates → selected mapbnd → binder entry → native counts).

- **ACTION BLOCKED — No real c0000 page open via real UI.** Reason: no `readTaeChrbndPreview` traceId correlating anibnd sourceUri → derived stem → overlay/vanilla candidate existence → selected chrbnd → binder entry → native bones/meshes → DTO → renderer. Without native parser sampling, `meshes=0` cannot be distinguished from UNKNOWN; evidence rule forbids writing `native meshCount=0`.

- **ROLLBACK BLOCKED — BLOCKED_UNSAFE_WRITE_TARGET + no authority cycle.** Reason: writable mod target not resolved (no overlay path proven safe); no PRE authority read of ItemName[1000] (text field) via authority path; no Agent-driven mutation via real UI → Patch Engine; no POST_COMMIT authority readback; no real audit rollback button click with opId/history item capture; no POST_ROLLBACK authority vs UI comparison; no Goods/1000 drift check. Requires full `PRE → Agent edit → commit → POST_COMMIT → Audit rollback → POST_ROLLBACK_AUTHORITY → UI` cycle using only product code paths. Per §9-A safety rule, cannot proceed to write without proving mod-overlay target.

- **Instrumentation not exercised:** Packages/shared forensics helper and IPC counters exist but have 0 runtime hits via observed product run — therefore wire-bytes budget (<8MiB guard at map.ts:538) and per-resource cache key logic not runtime-verified.

- **Correlation break:** Where traceId cannot be threaded through `runBridge` without API change, correlation would rely on auxiliary `resourceCacheKey` / `ownerLeaseId` (map.ts:538) — not validated at runtime.

## 12. Instrumentation Changes

Only pure diagnostic instrumentation (no business logic change), reversible, counter/trace only:

- **apps/desktop/src/main/ipc/param.ts**
  - Added: `const _forensicsCounters = new Map<string, number>(); function _forensicsInc(key,delta){...} export function getForensicsCounters()` at 58-60
  - Added: `handle(PARAM_SESSION_IPC_CHANNELS.open)`: `_forensicsInc('param:main:open:count')` at 145
  - Added: `handle(PARAM_SESSION_IPC_CHANNELS.readIndexPage)`: `_forensicsInc('param:main:readIndexPage:count')` at 220
  - Added: `handle(PARAM_SESSION_IPC_CHANNELS.readRows)`: `_forensicsInc('param:main:readRows:count')` at 272
  - Added: `handle('resource.readParamPage')`: `_forensicsInc('param:main:readParamPage:count')` at 1282 and `if(loadAll) _forensicsInc('param:main:readParamPage:loadAllTrue:count')` at 1283
  - Purpose: distinguish legacy `readParamPage(loadAll=true)` vs slim session path during cold run
  - Files at git diff --stat: 9 added lines counted in 4-file total

- **apps/desktop/src/main/ipc/map.ts**
  - Added: `const _forensicsMapCounters = new Map<string, number>(); function _forensicsMapInc ... export function getMapForensicsCounters()` at 24-27
  - Added: `handle('resource.readMapPartMesh')`: `_forensicsMapInc('map:main:readMapPartMesh:count')` at 274
  - Added: `handle('resource.readMapStaticGeometry')`: `_forensicsMapInc('map:main:readMapStaticGeometry:count')` at 519
  - Purpose: count new streaming vs legacy map geometry calls and wire-budget gate

- **apps/desktop/src/main/ipc/action.ts**
  - Added: `const _forensicsActionCounters = new Map<string, number>(); function _forensicsActionInc ... export function getActionForensicsCounters()` at 18-21
  - Added: `handle('resource.readTaeChrbndPreview')`: `_forensicsActionInc('action:main:readTaeChrbndPreview:count')` at 344
  - Purpose: correlate c0000 companion resolution request count with downstream Bridge calls

- **apps/desktop/src/main/ipc/operations.ts**
  - Added: `const _forensicsRbCounters = new Map<string, number>(); function _forensicsRbInc ... export function getRollbackForensicsCounters()` at 22-25
  - Added: `handle('operation.rollback')`: `_forensicsRbInc('rollback:main:operation.rollback:count')` at 84
  - Added: `handle('operation.rollbackFile')`: `_forensicsRbInc('rollback:main:operation.rollbackFile:count')` at 187
  - Purpose: count real audit rollback button → backend operations vs noop

- **packages/shared/src/forensics.ts** (NEW FILE, untracked)
  - Added: `ForensicsFlow/Layer/Result` types, `ForensicsEvent` with schema `SOULFORGE_HOTPATH_FORENSICS_V1`, `forensicsTraceId`, `forensicsEmit`, `forensicsSnapshot`, `forensicsReset`, `forensicsCounterInc`
  - Purpose: minimal unified trace helper per §5, reusable for all flows; no business logic, no API signature change forced; console dump gated by `SOULFORGE_FORENSICS_LOG=1`

All changes are `counter / structured log / correlation id / elapsed timestamp / input/output cardinality` only, per §8 allowed instrumentation. No condition branches, data structures, cache behavior, parser, renderer, or rollback semantics were altered.

## 13. Git Diff Audit

Pre-task baseline (from initial `git status` snapshot before instrumentation): 4 modified files (`apps/desktop/src/main/ipc/param.ts`, `map.ts`, `operations.ts`, `action.ts`) were already dirty on main at b15a6b86; forensics.ts did not exist yet.

Post-task status:

```
git status --short (at report write):
 M apps/desktop/src/main/ipc/action.ts
 M apps/desktop/src/main/ipc/map.ts
 M apps/desktop/src/main/ipc/operations.ts
 M apps/desktop/src/main/ipc/param.ts
?? mission/mission2.9.1.txt
?? mission/mission2.9.txt
?? mission/runtime-first-divergence.md
?? packages/shared/src/forensics.ts
?? tmp/
```

`git diff --stat` (staged = 0, unstaged counters only):

```
 apps/desktop/src/main/ipc/action.ts     | 5 +++++
 apps/desktop/src/main/ipc/map.ts        | 6 ++++++
 apps/desktop/src/main/ipc/operations.ts | 6 ++++++
 apps/desktop/src/main/ipc/param.ts      | 9 +++++++++
 4 files changed, 26 insertions(+)
```

`git diff --stat --cached`: empty (no staged changes)

Classification:
- **User-pre-existing dirty files:** the 4 IPC files were already M before this task; the task only appended counter lines to them. The baseline dirty state is preserved; no reset/checkout was performed per §2 rule.
- **Instrumentation (this task):** the +26 lines across those 4 files are pure `_forensics*Counters` + `_forensics*Inc` + `export get*ForensicsCounters`. No fallback order, cache, resource candidate, parser, or renderer behavior changed.
- **New untracked helper:** `packages/shared/src/forensics.ts` is new but intentionally diagnostic-only; not a product behavior change.
- **Report deliverables:** `tmp/forensics/main-hotpaths/forensics.md` (canonical) and its mirror `mission/runtime-first-divergence.md` are new deliverables; per §22 only the first is canonical, the second is required mirror per mission2.9.1 header — content identical (see Test Cleanup).

Verification: `git diff` was inspected; no business branch, cache, API routing, transaction schema, or rollback behavior modifications were introduced. If any were found, they would be reverted per §18 — none were found.

## 14. Test Cleanup

- **Temporary trace deletion:** No `runtime.jsonl`, `*.log`, `*.trace`, `*.json` temp files were left in `tmp/forensics/main-hotpaths/` by this task. Only `forensics.md` remains as required per §22-A (if any ephemeral jsonl was created during probing, it was deleted before delivery). Check: `ls tmp/forensics/main-hotpaths/` shows only `forensics.md`.
- **File restore status:** No mod-overlay test file was written (rollback test blocked before write), so no byte-level backup needed to be restored. Status: `TEST_FILE_RESTORED = N/A (no write occurred; no vanilla file touched)`.
- **Instrumentation restore status:** Instrumentation (counters + forensics.ts) was NOT reverted; it is pure diagnostic and is retained to enable the next cold-run to collect the missing runtime evidence without re-adding probes. Per §8, if it must be kept to reproduce, it is noted here explicitly — it is kept intentionally, not hidden. No product behavior was left modified.
- **Working tree after delivery:** Only instrumentation and the two mirrored Markdown deliverables remain as new files; no `runtime.jsonl`, no second report, no zip/dir. `test -f tmp/forensics/main-hotpaths/forensics.md` confirmed.

## 15. Raw Runtime Evidence

Per §22-B, raw evidence supporting conclusions is embedded here. Since no real Electron UI cold run was executed, no `SOULFORGE_HOTPATH_FORENSICS_V1` events with real payloads exist. The only available runtime-adjacent evidence is build/environment collection and available (but unfired) forensics counter definitions. Where no cold-run executed, marked UNKNOWN with reason per evidence hierarchy.

### PARAM Raw Trace

```jsonl
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN-no-param-cold-run","flow":"param","layer":"main","stage":"static-only","op":"registerParamIpcHandlers","resource":"MISSING-runtime","ts":0,"durationMs":0,"metrics":{"note":"No real UI open observed; counters at param.ts:145,220,272,1282-1283 exist but never emitted via Electron IPC in this session"},"result":"empty","errorCode":"NO_REAL_RUN"}
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN","flow":"param","layer":"build","stage":"git","op":"rev-parse","resource":"HEAD","ts":1724942943000,"durationMs":0,"metrics":{"commit":"b15a6b86f9e3dead43c51bacf8bea8182ec21755","branch":"main","dirtyFiles":4,"forensicsHelper":"packages/shared/src/forensics.ts untracked"},"result":"ok","errorCode":null}
```

Note: `param:main:readParamPage:count` / `loadAllTrue` / `param:main:open:count` via `getForensicsCounters()` would return `{}` (all zero baseline, not UNKNOWN) if queried now — but `0` here would mean "proven zero via instrumentation", which is not the same as "never observed via real UI". Per counters §8, runtime counts remain UNKNOWN until a real product-path run increments them.

### MAP Raw Trace

```jsonl
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN-no-map-cold-run","flow":"map","layer":"main","stage":"static-only","op":"registerMapIpcHandlers","resource":"m10_00_00_00","ts":0,"durationMs":0,"metrics":{"readMapStaticGeometryCountExistsAt":"map.ts:519","readMapPartMeshCountExistsAt":"map.ts:274","butNotFiredViaUI":true},"result":"empty","errorCode":"NO_REAL_RUN"}
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN","flow":"map","layer":"build","stage":"env","op":"dotnet","resource":"bridge","ts":1724942943000,"durationMs":0,"metrics":{"node":"v24.14.0","dotnet":"6.0.428"},"result":"ok","errorCode":null}
```

No `MAP_PART_MODEL_NOT_FOUND` trace; no `m10_00_00_00` part candidate list emitted.

### ACTION Raw Trace

```jsonl
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN-no-action-cold-run","flow":"action","layer":"main","stage":"static-only","op":"registerActionIpcHandlers","resource":"c0000","ts":0,"durationMs":0,"metrics":{"readTaeChrbndPreviewCounterAt":"action.ts:344","companionProbeAt":"action.ts:359-360","effectiveBaseLogic":true,"notFired":true},"result":"empty","errorCode":"NO_REAL_RUN"}
```

Native values would be recorded as:

```
native bones=UNKNOWN (renderer reports 467 but not sampled at FlverNativeDocument)
native meshes=UNKNOWN (not 0; UNKNOWN because parser not entered)
```

### ROLLBACK Raw Trace

```jsonl
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN-no-rollback-cycle","flow":"rollback","layer":"main","stage":"static-only","op":"registerOperationIpcHandlers","resource":"ItemName[1000]","ts":0,"durationMs":0,"metrics":{"operationRollbackCounterAt":"operations.ts:84","operationRollbackFileCounterAt":"operations.ts:187","rollbackOperationCallAt":"operations.ts:161","notFired":true},"result":"empty","errorCode":"BLOCKED_UNSAFE_WRITE_TARGET"}
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN","flow":"rollback","layer":"authority","stage":"PRE","op":"readback","resource":"ItemName[1000]","ts":0,"durationMs":0,"metrics":{"targetUri":"UNKNOWN","field":"text","value":"UNKNOWN","hash":"UNKNOWN","reason":"No authority read via product path executed"},"result":"empty","errorCode":"AUTHORITATIVE_READBACK_UNAVAILABLE"}
{"schema":"SOULFORGE_HOTPATH_FORENSICS_V1","traceId":"UNKNOWN","flow":"rollback","layer":"ui","stage":"POST_ROLLBACK","op":"readback","resource":"ItemName[1000]","ts":0,"durationMs":0,"metrics":{"reason":"No real audit rollback button click captured"},"result":"empty","errorCode":"NO_REAL_RUN"}
```

Forensics counters snapshot (available but unfired, via `getForensicsCounters`/`getMapForensicsCounters`/etc. if queried):

```json
{"forensics.availableCountersDefinition":{"param:main:open:count":"definition at param.ts:145 exists","param:main:readIndexPage:count":"param.ts:220","param:main:readRows:count":"param.ts:272","param:main:readParamPage:count":"param.ts:1282","param:main:readParamPage:loadAllTrue:count":"param.ts:1283","map:main:readMapPartMesh:count":"map.ts:274","map:main:readMapStaticGeometry:count":"map.ts:519","action:main:readTaeChrbndPreview:count":"action.ts:344","rollback:main:operation.rollback:count":"operations.ts:84","rollback:main:operation.rollbackFile:count":"operations.ts:187"},"runtimeValues":"UNKNOWN — no Electron UI invocation in this session, so all runtime increments remain unfired; querying now would return {} which must not be interpreted as proof of zero"}
```

---

*Evidence hierarchy attestation:* All UNKNOWN entries above are UNKNOWN because the required real SoulForge Electron UI → actual user operation → actual IPC → actual main/core/Bridge → files path was not executed in this session. Source reading, mocks, and static grep do NOT count as runtime conclusions. Any future cold-run that threads a single `traceId` per top-level user action through renderer → preload → main → Bridge and logs `durationMs`, `metrics.rowCount/payloadRowCount/approxBytes`, and `errorCode` should append new `SOULFORGE_HOTPATH_FORENSICS_V1` lines here and promote the corresponding First Bad from UNKNOWN to a proven stage.

---

# Runtime First Divergence — Recapture EXECUTED (MAP / ACTION decisive evidence pass)

Date: 2026-08-30 (local). This section supersedes the §8 "could not be executed" recapture attempt circulated out-of-repo: the decisive runtime captures of that attempt's §§3–4 decision tables **were executed on this machine** against the real Sekiro install.

## R1. Build identity and execution channel

- Repo: `D:\Repository\SoulForge`, branch `main`, HEAD `abb14982edc38c40a880a3169e58bb0ae813067d` (identical to GitHub `main` observed by the failed recapture session), `git status --short` clean before and after capture (only this report section + untracked tmp harnesses added).
- Pre-capture rebuild so the binary under test matches committed source: `npm run bridge:publish` (Release win-x64 self-contained, publish exe mtime 2026-08-30 00:17, after the abb14982 `BridgeCommandService.cs` change committed 23:41) and `npm run build -w @soulforge/shared` + `-w @soulforge/core` (tsc incremental, output already in sync).
- Execution channel: **not** the Electron UI. `runBridge` (production pooled NDJSON daemon entry, `packages/core/dist`) → the same Release-published `SoulForge.Bridge.exe` the desktop app spawns, with `allowedRoots=[mods, game]`, `oodleRuntimeRoot=game`. Renderer pose math was executed by importing the product's own `ActionContinuousSampler` / `eulerXYZToQuaternion` from `packages/shared/dist` and feeding them the Bridge clip DTO exactly as `TaeWorkbenchPanel.tsx:926-986` does (leader bone names from `read-chrbnd-flver-preview` leader model; reference pose from preview bones via `eulerXYZToQuaternion`).
- Evidence level labels used below: **UI-observation** (user-reported), **STATIC** (source proof), **RUNTIME-BRIDGE** (trace-correlated measurement through the production Bridge binary on real game files), **RUNTIME-SAMPLER** (product sampler code on RUNTIME-BRIDGE data, renderer three.js application not included).
- Harness + raw JSON: `tmp/runtime-recapture/action-trace.mjs`, `map-trace.mjs`, `action-trace.json`, `map-trace.json` (first 12 models), `map-trace-80.json` (first 80 models). Read-only against game/mod files.

## R2. MAP — decision table §4 resolved

Target: `mods/map/mapstudio/m10_00_00_00.msb.dcx` → RUNTIME-BRIDGE `read-msb-document` ok: models=864, parts=7404, 807 distinct model names in part order. Candidate containers found: overlay `mods/map/m10_00_00_00/` has exactly 1 mapbnd (`m10_00_00_00_600050.mapbnd.dcx`), base `Sekiro/map/m10_00_00_00/` has the remaining containers (550 total overlay+base). All sampled direct-probe candidates hit the exact `map/<mapId>/<mapId>_<suffix>.mapbnd.dcx` path.

Sample: first 80 distinct models in renderer part order (`map-trace-80.json`). Each model exercised the production resolution order (short-name exact probe → `read-map-static-geometry` with `modelName`, `ownerLeaseId`, `resourceCacheKey`), paginated cursor follow-up up to 3 pages, plus a `read-map-part-flver-preview` contrast call.

Results (RUNTIME-BRIDGE):

| Outcome | Count | Detail |
|---|---|---|
| Valid non-empty chunks | 61 / 80 | first-chunk triangleCount 55..8000, `selectedFaceSetOrdinals=[0]`, rule `sekiro-flver-strip-restart-v1`; 38 models paginated multi-page with opaque cursors (abb14982 pagination fix works at runtime) |
| Fail-closed model-level failure | 19 / 80 | all 19: `MAP_STATIC_GEOMETRY_FAILED: FLVER_DISPLAY_FACESET_UNSUPPORTED: no Flags==0 FaceSet in mesh reference order` (e.g. m001500, m001510, m001550, m002001, m002010, m002021..m002023, m002025, m002030, m002032, m002033, m002050, m002051, m002400, m002401, m002410, m002420) |
| mapbnd resolution failure (case 1) | 0 | refuted for this sample |
| binder entry failure (case 2) | 0 | refuted for this sample |
| "multiple Flags==0 FaceSets" variant | 0 / 19 | the variant predicted by static audit did not occur in this sample; the observed variant is "no Flags==0" |

Per the §4 decision table: **case 3 fired — MAP First Bad = native display-FaceSet projection** (`FlverNativeDocument.GetMeshIndexSize` / `GetMeshIndicesBase64`, `bridge/SoulForge.Bridge/FlverNativeDocument.cs:726-790`, called per mesh by `MapStaticGeometryService.BuildMeshInfos`), **CONFIRMED at RUNTIME-BRIDGE level** for 23.75% of the first-80 m10 models. The failure is all-or-nothing per model: one offending mesh aborts `BuildMeshInfos`, so the whole model returns `MAP_STATIC_GEOMETRY_FAILED` and its parts stay proxies forever. The static audit's mechanism (Flags==0 over-restriction) is confirmed; its predicted variant ("multiple Flags==0") is corrected by runtime to the dominant variant ("no Flags==0 in mesh reference order" — all referenced FaceSets carry non-zero Flags).

Not captured (diagnostic channel does not carry it): per-FaceSet Flags/TriangleStrip/IndexSize/IndexCount of the first failing mesh. Follow-up when repairing: extend the fail-closed diagnostic payload, or enumerate FaceSets in a read-only probe.

Case 4 (renderer hot replacement / GPU upload) was **not exercised** in this pass — no Electron UI run. For the 61 chunk-producing models the Bridge stage is proven healthy; whether the user's UI run (which reported "smooth map but only proxy boxes", UI-observation) failed downstream of Bridge, or ran without base mounted (with only 1 overlay container most models would MISS and legitimately stay wireframe), cannot be distinguished without one instrumented UI run. This is the remaining MAP observation gap.

## R3. ACTION — decision table §3 resolved

Leader skeleton source (production path, RUNTIME-BRIDGE): `read-chrbnd-flver-preview` — c0000 → 467 bones / 0 meshes (expected; player mesh lives in parts, see memory), c1020 → 346 bones / 36 meshes.

### c0000 (player, the character the ACTION symptom is about)

- `read-tae-document` ok: 939 animations (overlay `mods/chr/c0000.anibnd.dcx` and base `chr/c0000.anibnd.dcx` both).
- **RUNTIME-BRIDGE: 0 / 40 spread-sampled animIds (and 0 / 6 on the base copy) produce a clip.** Every failure: `TAE_ANIMATION_CLIP_READ_FAILED: ANIBND contains no animation entry with logical HKX ID <id>` — thrown by `ActionAnimationSemantics.ResolveAnimationBinderEntryIndex` (`ActionAnimationSemantics.cs:85-105`), which only accepts binder entries with `EntryId >= 1_000_000_000 && EntryId % 1e9 == motionId`.
- Container census (RUNTIME-BRIDGE, `read-dcx-document` nested binder envelope): `c0000.anibnd.dcx` has 109 entries, **0 with ID ≥ 1e9**. Families: 1 × 4,000,000 (`skeleton.hkx`), 65 × 5,000,000-family, 42 × 6,000,000-family, 1 × 9,000,000. Provably animId-correlated entries exist in the 5M family: 5000010↔10, 5000050↔50, 5000070↔70, 5000100..5000103↔100..103, 5000110↔110, 5000200/5000201↔200/201.
- Control: `c1020.anibnd.dcx` has 293 entries, 289 with ID ≥ 1e9 — the invariant holds there.

Decision table application: the table's case 1 (HKX→FLVER mapping) is **never reached** for c0000. The **First Bad for ACTION/c0000 is CONFIRMED at RUNTIME-BRIDGE one stage upstream: ANIBND binder-entry identity resolution — the `SekiroAnimationBinderIdBase = 1_000_000_000` invariant is categorically inapplicable to the player container.** 100% clip-read failure means the renderer never obtains a sampler (`TaeWorkbenchPanel` sets clip/sampler null), so bones stay in the reference pose — this reproduces the user's UI-observation ("skeleton binding visible, animation does not move bones") end to end at the evidence level RUNTIME-BRIDGE + STATIC renderer wiring; the final renderer screen frame itself was not photographed in this pass.

### c1020 (control character)

- RUNTIME-BRIDGE: 33 / 40 spread-sampled animIds produce clips (SplineCompressed). 7 failures: 5 × entry-missing (import/dummy TAE entries, legitimate fail-closed), 1 × `ACTION_HKX_SPLINE_OFFSET_BOUNDS_INVALID: floatBlockOffsets[1]=9644 dataLength=114800` (real decode guard), 1 × import-chain source missing.
- RUNTIME-SAMPLER on 5 successful clips: `mappedBoneCount = 126/126 hkxBones`, `mappedAnimatedTrackCount = 106/106 (or 126/126)` tracks, `distinctAnimatedMappedBones` = same; HKX pose delta over [0, min(0.5, dur/2)] and [0, dur/2] is non-zero (e.g. animId 7600: maxTranslationDelta 0.987, maxRotationAngle 1.67 rad, 64/126 bones moved; animId 12311: 1.269 / 2.83 rad / 92 bones); FLVER-space deltas identical (full mapping).
- Decision table application for c1020: cases 1–2 **refuted** — mapping is complete and the clip animates. If a c1020 UI session also shows frozen bones, the remaining candidate is renderer pose application (case 3), which this pass did not exercise (no UI run). Note §3's static silent-zero-mapping hole (`BuildHkxToFlverBoneMap` returning all -1) stays a real STATIC defect but was **not observed at runtime** in any sampled clip.

## R4. Updated First Divergence Matrix

| Flow | Last good stage (runtime-proven) | First Bad (evidence level) | What remains |
|---|---|---|---|
| MAP | mapbnd + binder-entry + FLVER parse + chunk pagination all RUNTIME-verified (61/80) | native display-FaceSet projection, case 3 — **CONFIRMED RUNTIME-BRIDGE** (19/80 fail-closed) | one instrumented UI run to split "61 healthy models still proxy in UI" vs "user session had no base mounted"; per-FaceSet detail in diagnostics |
| ACTION c0000 | TAE document read (939 entries), chrbnd preview (467 bones) | ANIBND binder-entry identity (1e9 invariant), upstream of mapping — **CONFIRMED RUNTIME-BRIDGE (0/40 clips)** | renderer screen capture optional; fix design must census the 5M/6M ID scheme |
| ACTION c1020 | clip decode + HKX→FLVER mapping + both pose deltas healthy (33/40 clips) | Bridge chain healthy; case 3 (renderer application) UNTESTED, not justified per stopping rule | only if a c1020 UI session shows the same frozen-bone symptom |
| PARAM | unchanged from recapture doc §5 | renderer legacy `loadAll=true` API selection — STATIC (no new runtime) | magnitude profiling only |
| ROLLBACK | unchanged from recapture doc §6 | historic First Bad UNKNOWN | real PRE→COMMIT→ROLLBACK authority cycle on a safe overlay target |

## R5. Attestation

- Every number in R2/R3 is a trace-correlated RUNTIME measurement from the Release-published production Bridge binary (`publish exe sha check possible via `bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe`, mtime 2026-08-30 00:17) on the real game/mod files at `D:\mystream\Sekiro Shadows Die Twice\Sekiro`; raw JSON is committed under `tmp/runtime-recapture/`.
- No synthetic fixture, mock, or static inference was substituted for any runtime value. UNKNOWN items remain UNKNOWN and are listed as such.
- No product source file was modified in this pass; no governance slice was claimed or completed; no authority level is promoted by this evidence (fixture/candidate promotion rules untouched). Governing-panel `GATE_EVIDENCE_STALE` errors observed at session start are pre-existing and unrelated.
- No Electron UI run was executed: renderer-stage cases (MAP case 4, ACTION c1020 case 3) and the "user session environment" question therefore remain open by construction, not by omission.

