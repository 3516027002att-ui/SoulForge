# MAP decoder performance checks

`scripts/profile-map-decode.mjs` calls the production Bridge daemon's paged
`read-map-static-geometry` command. It verifies repeated geometry bytes and
source hashes, records native phase timings, wire/model counts and caller/RSS
samples, and can exercise two overlapping requests, queued cancellation,
reopen and workspace close at the existing concurrency of two.

```sh
node scripts/profile-map-decode.mjs --bridge /path/to/SoulForge.Bridge \
  --input /owned/read-only/model.flver --model modelName \
  --out /owned/results --repeat 10 --controls true
```

For managed heap observations, compile the validation-only
`scripts/scene/mapDaemonMemoryProbe.cs` as a framework-dependent .NET 10 console
application in an owned scratch directory. Run the same driver with `dotnet` as
`--bridge` and `--bridge-args '["/owned/Probe.dll","/owned/SoulForge.Bridge.dll"]'`.
This executes the compiled production daemon. Heap counters include the probe;
25 ms samples are estimates. Forced collection occurs only after timed requests
and daemon shutdown. Executable, helper, producer and input hashes are checked
before and after capture.

The synthetic native fixtures resolve the current platform's compiled
production DLL by default. `SOULFORGE_BRIDGE_DLL` selects an isolated producer;
`SOULFORGE_DOTNET` or `SOULFORGE_DOTNET_PATH` selects its runtime:

```sh
node --test scripts/scene/map-warm-source-hash.fixture.mjs
node --test scripts/scene/map-captured-source.fixture.mjs
```

Its independently constructed six MiB FLVER2 has three vertices and one
triangle. The controlled allocation bound exposes copying the full source on
every warm page; it is not a general geometry/page memory budget. Controls cover
same-size/restored-timestamp tampering, changed-content reopen, unknown-token
fallback hash, invalid cursor, cancellation, cache reset and observer failure.
Linux active cancellation observes reads on the executing native thread while
the owned source descriptor is open. Other platforms report that observation
as not run.

On 2026-10-01, base `6eec144` producer `d000df5c…` allocated 6,322,472 bytes for
the controlled warm read; candidate `04f7b9a6…` allocated 97,424 bytes, with
identical geometry. In one paired daemon run, nine warm calls averaged
6.886 ms versus 4.845 ms. Whole observation-process allocation across ten
requests and controls was 101,420,616 versus 20,081,072 bytes; sampled peak RSS
was 144,433,152 versus 88,543,232 bytes. Both runs observed overlap, queued
cancellation, successful reopen and actual cache disposal with zero entries
and retained bytes. Detailed SHA-bound evidence is retained locally in
`.local-validation/map-performance-recovery-receipt.json`.

These are synthetic native decode measurements. They do not establish GPU,
Electron main-process or game-image performance. The three minimum restored
real MAPBND/TPF inputs are SHA-verified KRAK; the current Linux producer reports
`MAPBND_KRAK_OODLE_UNAVAILABLE`. A drawable real-map benchmark remains
unavailable on those inputs.

MAP cold reads and unknown-token fallback now decode their exact captured and
hashed DCX bytes. Binder reuse compares all captured source bytes, including
trailing data. An independently constructed 219-byte DFLT MAPBND negative
previously reproduced a fresh B hash paired with cached A geometry after
same-size/restored-timestamp replacement. Candidate `5cffee96…` emits B geometry
and its B hash. The fixture also checks direct DFLT FLVER reads, byte-identical
container reuse and that captured A cannot authorize path metadata while the
path contains B.

The reproducible indexed-grid generator is
`node scripts/scene/generate-map-grid.mjs /owned/new-grid.flver`. Its 2,353,468
bytes contain 65,536 source vertices and 130,050 triangles. Seventeen pages
emit 69,648 vertices because page boundaries repeat shared vertices. Removing
the second dense-index lookup for each triangle corner preserved every
geometry byte (SHA `b91b69c0…`) and existing decode guards. Two profile orders
on producer `5cffee96…` versus `6e4c640d…` gave warm model averages
210.47→184.68 ms and 234.54→196.74 ms; native chunk time averaged
127.54→109.34 ms and 144.18→111.05 ms. The existing SF14 unit suite also
passed on the candidate, including list/strip, UV/normal/bounds, cursor,
rigid-reference and invalid/weighted/singular negatives. Input, compiled smoke
and profile hashes are retained in `.local-validation/chunk-index-receipt.json`.
These observations do not establish allocation/RSS or GPU improvement.

The legacy path adapter now also validates the complete current source hash
before reusing decoded BND/DCX objects. It uses a bounded pooled stream and
preserves the existing 512 MiB source check, including growth while reading.
`bnd-path-freshness.fixture.mjs` reproduced stale physical hashes/children in
all four advertised consumers: `read-dcx-document`, `list-bnd4-entries`,
`snapshot-bnd4-child` and `extract-bnd4-child`. A second negative changes only
the entry name and retains its child hash; stale native snapshot metadata was
also reproduced. Candidate `293fbfe9…` returns the independent current payload,
child bytes and entry name, while unchanged content still avoids reinflation.
All three maintained synthetic native fixtures execute through the central
runner with zero unavailable legs. This does not claim an executed inverse
transaction or active cancellation inside this legacy hash helper.

The optional `--uv` grid adds one Float2 UV stream and reproduces SHA
`379b2126…`. The completed layout plan is not modified after construction, so
its descriptor now stores the UV-set count once. Direct calls to the compiled
getter showed 10,404,152→152 allocated bytes for 260,100 queries of a one-UV
plan; the empty plan was already bounded. The maintained zero/single/paired
UV fixture checks exact counts and a 25,000-query allocation negative
(1,000,152→152 bytes for the single/paired plans). Candidate `4a7f5883…`
retains complete UV-grid geometry SHA `dd3fdd1e…`. Two warm profile orders gave
238.24→221.51 ms and 234.32→211.94 ms model time, with
124.10→101.58 ms and 143.84→112.24 ms native chunk time. SF14 and all four
maintained synthetic native fixtures passed on that producer. Receipt:
`.local-validation/uv-count-receipt.json`. These are synthetic CPU observations.
