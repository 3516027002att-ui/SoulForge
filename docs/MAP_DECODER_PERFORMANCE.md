# MAP decoder performance checks

The 2026-10-01 numbers below are historical observations on their named
producers and runtime. Their temporary per-run receipts and original restored
MAP copies were lost with the execution filesystem. The maintained source
fixtures and grid generator remain available; fresh recovery captures must
bind their own runtime, producer and input hashes. After the private backup
completed, a single verified volume restored a real DFLT MSB, a KRAK MAPBND
and two DFLT character containers. The selected MAPBND remains unavailable on
the supported Linux decoder; character inputs do not prove actual map-scene
or GPU performance.

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
and retained bytes. The historical SHA-bound receipt was recorded as
`.local-validation/map-performance-recovery-receipt.json`.

These are synthetic native decode measurements. They do not establish GPU,
Electron main-process or game-image performance. In the prior workspace, the three minimum restored
real MAPBND/TPF inputs were SHA-verified KRAK and the named Linux producer
reported `MAPBND_KRAK_OODLE_UNAVAILABLE`. Those copies are not present in the
recovered workspace; a fresh drawable real-map benchmark remains unavailable.

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
and profile hashes were recorded in `.local-validation/chunk-index-receipt.json`.
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

The two discarded JSON preflight outputs now serialize to a counting stream.
The same generic types, default STJ options, exact byte comparisons and chunk
shrink loop remain in use; final daemon serialization/enforcement is unchanged.
This avoids retaining a UTF-8 array and UTF-16 string solely to measure them.
The serializer still uses pooled buffers, and large tokens may grow them.

Candidate `579f27db…` passed both previous byte-count formulas, escaped Unicode
and controls, declared generic contracts, failures after a 64 KiB prefix and
successful recovery. Both thresholds are checked at −1/equal/+1 byte. Actual
native BuildChunk controls execute a single prefix shrink, opaque continuation
without skipping/replay, and rejection when one triangle exceeds the safe
frame. These controls do not separately force the full command response's
8 MiB rejection branch or assert final daemon envelope size. SF14 and all five
maintained synthetic native fixtures passed with zero unavailable legs.

Two longer alternating profile pairs of twenty UV-grid rounds gave warm model
averages 224.55→214.42 ms and 182.88→168.51 ms; whole observation-process
allocation was 1,416,231,224→1,116,526,464 and
1,412,900,536→1,115,780,064 bytes. Geometry, page/count and lifecycle controls
remained identical. Earlier short pairs were mixed, including a reverse pair
of 192.45→203.13 ms, so these observations do not establish a universal latency
improvement. These captures were recorded in
`.local-validation/json-count-receipt.json`, bound to source `6dc4c217…` and the
compiled producer. The measurements remain synthetic native CPU observations.

The 2026-10-02 recovery baseline at source `6dc4c217…` used SDK 10.0.100,
framework 10.0.0 and producer `9679aff1…`, with default JIT settings. The
regenerated UV grid retained input `379b2126…` and complete geometry
`dd3fdd1e…`. Twenty daemon rounds averaged 207.59 ms for warm model reads;
all four concurrency/cancellation/reopen/release controls passed. These fresh
captures are independent of the earlier runtime's numbers.

The next recovery capture used only backup volume 0048: 512 MiB, SHA
`f9f34e10…`. The original-byte Mod m10 MSB (`8dca8500…`, 426,514 bytes)
expanded to 6,772,360 bytes and exposed 864 models, 7,404 parts, 1,506 regions,
189 events and 33 routes. Its complete document projection remained SHA
`dd148675…` across repeated reads. The Mod m10 MAPBND (`f634e1f5…`, 1,975,936
bytes) was actually KRAK and returned `MAPBND_KRAK_OODLE_UNAVAILABLE`.
The second Mod MAPBND in the backup has identical bytes; it was not downloaded.

The same volume contained character containers c4510 (`06304a3a…`, 7,516,841
bytes) and c5030 (`3fea221d…`, 2,193,302 bytes). Their physical magic is DCX,
their outer compression is DFLT, and actual native inventory reports
`DCX-DFLT->BND4`. The fixed registry's BND4 label denotes this embedded binder,
as its specification defines; it is not a conflicting top-level classification.
On the existing production MAP static decoder, c5030 yielded 11 pages, eight
output meshes, 28,868 emitted vertices and 37,478 triangles. SHA `6f66af7f…`
binds the five position, normal, UV, index and source-index buffers measured by
the maintained driver. The candidate retained those bytes and counts and the
same concurrency, cancellation, reopen and disposal controls. This is real
character geometry supplied to the MAP decoder, not an actual map benchmark.

One measured DFLT allocation hotspot was the pre-sized `MemoryStream` followed
by `ToArray`, which retained two output allocations per inflate. The exact-size
output-buffer correction changes only this method. It fills the declared-size
array, rejects short output, and probes one further decompressed byte to reject
overlong output without growing the array. Existing size limits and KRAK
dispatch remain unchanged. The 12 maintained DFLT cases first produced two
allocation failures on the baseline: 4,197,064 bytes for a two MiB output and
6,163,744 bytes for a malicious stream declaring 32 bytes. The candidate passed
all 12; all 39 current C# cases and five existing native fixtures passed without
skips on Linux. Decompressed EOF does not independently prove complete zlib
framing under the default .NET runtime: half-stream truncation and checksum
corruption are covered, while universal truncated-trailer rejection is not
claimed.

Baseline source `6dc4c217…`/DLL `9679aff1…` and candidate source
`04caa088…`/DLL `019899eb…` used the same SDK 10.0.100/framework 10.0.0,
input and hash-bound observation helper, with no JIT or concurrency overrides.
Two alternating pairs of the actual compiled DFLT method reduced median
current-thread allocation from 13,545,200 to 6,772,728 bytes. Stage medians were
5.813→3.921 ms and 5.936→3.598 ms; every output leaf SHA remained `d418012f…`.
These are short method-level observations rather than steady-state or whole-MAP
speed guarantees.

The actual MSB daemon comparison consumed each complete 2,532,035-byte
file-backed projection through 20 artifact reads; owned hash verification was
outside the final paired return timing. Warm complete-return means were
126.965→128.301 ms and 125.935→125.328 ms, so overall wall time remained mixed.
Whole native-observer allocation across the reads and controls was
1.651→1.481 GB and 1.659→1.473 GB; sampled native peak RSS was
392.79→371.00 MB and 394.89→357.28 MB. These process totals include the observer
and control requests, not only DFLT. All pairs retained the full document SHA,
observed two active native requests, cancelled a queued request without a result,
read the document again, closed successfully and cleared their owned artifact
directories. Zero MAP lease-cache entries do not prove every managed allocation
was released. Source, producer, raw captures and input receipts are retained
under `.local-validation/map-backup` and `.local-validation/dflt-compare`;
these local proofs are separate from a product package or Windows run.

An additional read-only phase probe bound that same `04caa088…`/`019899eb…`
producer and input. Across 20 fresh document sequences, median stage work was:
DCX read/inflate 2.688 ms / 7,199,392 current-thread bytes, MSB read
3.321 ms / 2,970,720 bytes, `VerifyRoundTrip` 14.416 ms / 9,744,720 bytes,
and explicit-report `ToEnvelope` 0.454 ms / 970,912 bytes. Verification includes
its copy, nested reparse and two hashes; its nested read must not be counted
again. Result-only serialization using the actual daemon JSON options measured
9.010 ms / 5,064,440 bytes for a string and 9.010 ms / 2,532,408 bytes for UTF8.
These serializer alternatives do not measure the full frame, oversize preflight,
DOM conversion, artifact storage or transport, and the stages are not a complete
request or causal-DAG sum. Default tiering and natural GC produced variation.
Every projected object matched the actual service golden; Node's canonical
`.data` SHA stayed `dd148675…`. Native JSON lexical hashes are kept separately
because float spellings and Unicode escaping differ. The specifically checked
independent VSTest interval ended 31.716 seconds before this probe; other host
load is unexcluded. The bound phase receipt is
`.local-validation/msb-phase/receipt.json`.

The subsequent KRAK diagnostic correction changes only three map-read messages.
On Windows, the original game-directory guidance remains exactly the same.
On non-Windows hosts, the current unavailable Oodle provider is stated
explicitly: MSB reads suggest an already decompressed MSB, the BND4-only model
preview suggests MAPBND, and static geometry suggests MAPBND or FLVER, with
supported Windows reading as another option. Codes, failed/map classification
and provider admission are unchanged. All 42 current C# cases passed without
skips on Linux; two actual read commands on the original-byte KRAK MAPBND
retained its SHA and the same unavailable verdict. These outputs bind source
`5f21c4a8…` and DLL `3420f1bb…`. This corrects actionable text without adding
Linux KRAK decoding, running vendor code or claiming a Windows execution test.

`scripts/scene/mapVertexHitProbe.cs` is a validation-only .NET 10 console host.
Compile it in an owned scratch directory, run it from the repository root,
and pass the producer path, UV-grid path and their expected SHA-256 hashes. It binds the actual private helper
through runtime-closed generic types and concrete spans, with reflection only
outside each timed loop. Its two source-file pins make later source edits
require an explicit rebind. On the recovered producer, 8.1 million measured
cached hits had median 10.83 ns/hit, zero measured allocation, unchanged
buffer/bounds bytes and no extra position/normal/UV decodes. A subsequent
first-seen source decoded exactly once. Direct dictionary lookup measured
4.21 ns/hit as a diagnostic with different call overhead; this does not predict
an end-to-end speedup or justify a hot/cold-path rewrite.

A separate exact-capacity candidate used the observed accepted source count
for full prefixes and kept existing growth behavior on shrink retries. Twelve
tiny/sparse/shared/disjoint/boundary shapes retained identical geometry and
lower chunk allocation. Across four alternating twenty-round daemon pairs,
process allocation consistently fell about 16.5%, but warm wall time remained
mixed, including 197.71→219.52 ms. Sampled native peak RSS increased in three
of four pairs, including 126.1→165.0 MB. The candidate was rejected and its
product source restored. No allocation result is presented as a whole-MAP
speed or memory improvement. Current receipts are in
`.local-validation/recovery-receipt.json` and
`.local-validation/chunk-capacity/rejection-receipt.json`; these files are
local validation artifacts and are not part of a published package.

The renderer read observer now binds its phase at dispatch through a best-effort
start event and an event-only invocation identity. Completion cannot borrow a
later phase or another request's start when IDs repeat and clock samples match.
Missing, duplicate, dropped or overflowed starts report unavailable attribution;
pending observations use the existing 10,000-sample limit and clear on disposal.
The maintained actual-helper/installer tests preserve exact result, error and
cancellation identity, including clock-origin and dispatch observation failures.
This fixes a latent measurement defect: the current normal renderer probe never
sets its phase to `done`, so the reproduced transition does not demonstrate a
normal-run request loss. Cross-model scheduler dependencies still do not form a
verified full MAP causal DAG; the existing 260 s / 400 ms limits and submitted-frame
semantics remain unchanged. No real MAP, Electron or GPU performance is established
by these source-only tests.

Model timelines now retain the logical map URI, MSB revision, loader ID, model
name and canvas identity through read, preparation and replacement. The MSB
revision does not establish the physical hash of the resolved MAPBND/FLVER;
that hash remains unobserved in this renderer DTO. Missing binding fields stay
unavailable. Per-invocation records are captured before awaiting the cache promise
and copied before enqueue, so a shared cached geometry object cannot replace an
older invocation's timing. Repeated ready callbacks retain the first boundary.

The optional `postReturn` projection divides the final IPC return through ready
into before-prepare, preparation queue, renderer preparation turnaround,
before-upload, upload queue and synchronous replacement intervals. These are
contained in `returnProcessingMs`. Worker preparation duration is a separately
reported diagnostic inside renderer turnaround and is never added again. Ready
uses the exact captured replacement-completion boundary; clock, preparation-job
and source gaps are explicit. Upload observation failures preserve replacement
outcomes, while stale/disposed/false/failed callbacks publish no current success.

The maintained controlled-clock fixture drives actual preparation client worker
callbacks, the maintained `FrameTaskQueue` callback and the renderer observer.
Its 90 ms post-return interval accounts as 10/10/20/10/30/10 ms, with a separate
15 ms reported worker duration. Two equal-name loads with different bindings each
retain their own 60 ms timeline. These are callback/accounting regression values,
not measured game-load latency or GPU performance. The full MAP causal DAG and
actual responsiveness quality remain unverified; the 260 s / 400 ms guard limits
are unchanged.

## Oversized native-result allocation

The actual compiled `DaemonState.WriteResultAsync` boundary was measured with
the restored DFLT Mod MSB (physical SHA256
`8dca8500733687d26324eb311ec375a9d6abd6c372af5a47cedc2154f978dd0c`).
Its oversized result is still serialized to the same 2,532,035-byte artifact;
the descriptor, negotiated frame budget, chunk size, cancellation, admission
and cleanup behavior are unchanged. The only production change parses those
existing UTF8 bytes directly into `JsonNode`, removing the preceding full UTF16
string decode.

That experiment deliberately used the daemon's default 1 MiB negotiation. The
desktop MSB read goes through Core's default 16 MiB budget; semantic indexing
requests 32 MiB. This particular 2.53 MB MSB is inline on those normal routes.
The oversized experiment is evidence for its measured artifact boundary, not
evidence that normal desktop MSB loading takes that path.

Two paired runs used the same helper, input and runtime in B/C then C/B order,
with three warmups and twenty samples per case. Managed allocation through the
actual owned output-pump flush fell from 19,142,012 to 14,077,908 bytes and from
19,142,688 to 14,077,216 bytes, a 26.46% reduction in both pairs. This is
all-process allocation for this boundary, including pump/runtime/instrumentation;
it is not peak heap, RSS or whole-map memory. Return and flush scopes overlap
and must not be added to each other or to separate historical stage medians.

Wall time was mixed: method-return medians were 77.92 to 61.13 ms in one pair
and 65.04 to 83.74 ms in the other. The short Linux/default-GC/default-JIT
observation therefore establishes allocation improvement, not a wall-time
speedup. Full request execution, caller reconstruction, renderer/GPU and
Windows performance remain unmeasured by this experiment.

All actual artifacts and chunk reconstruction matched the original result;
the canonical full-data hash remained
`dd148675f26f1f0e3d5b2bb08744fe15c49e785cb58a2cd629cb64fd4f9307ac`.
Seven real serializer/queue/artifact transport tests cover Unicode, nested and
nonfinite values, the inline boundary, exact chunk data, cancellation, closed
output and owned cleanup. The redundant-allocation negative failed on the old
implementation; all seven and the complete 49-case C# suite passed on the
candidate. The sealed local receipt is
`.local-validation/result-transport-utf8/receipt.json`; raw game results and
validation binaries are excluded from source and release artifacts.

## Normal-budget inline output allocation

The next isolated Linux candidate borrows the stdout stream already opened by
`Program`, serializes each output frame directly to UTF8, and queues those owned
bytes with a cached length. The existing `RunAsync(TextReader, TextWriter, ...)`
entry and the unique `DaemonState` constructor remain available; injected text
writers retain string serialization. The separately named `RunStreamAsync`
preserves the former BOMless writer's startup flush, body flush, LF flush,
explicit frame flush and final flush, including their failure boundaries. It
leaves the supplied stream open. Queue capacity still includes one LF byte while
the exact negotiated frame gate excludes it; progress replacement, ordering,
backpressure, cancellation and drain behavior retain their existing rules.

Two paired runs used B/C then C/B order, the same restored DFLT Mod MSB, .NET
10.0.0 from SDK 10.0.100, three warmups and twenty samples for MSB/tiny/Unicode
cases. The actual production `WriteResultAsync` and output pump used the normal
16 MiB frame budget and a common owned draining stream. Native decoding happened
before the measurement. All complete MSB result bytes matched the original
2,532,035-byte result with SHA256
`fb5fb97cbdcbeaeef8b31e8329fa7c0bf9b7fb4a37f58f6cde54dfcc21485f1c`.

Managed allocation through the final frame flush was 5,066,192 to 2,533,880 bytes
in both pairs, a 49.98% reduction. MSB wall means were 27.934 to 30.350 ms
(+8.65%) and 33.408 to 27.113 ms (-18.84%). Tiny and Unicode wall results were
also mixed; their allocation fell about 26% and 31%. These short natural-GC,
default-JIT observations establish allocation improvement, not a stable latency
speedup. Return and flush scopes overlap and must not be added.

With one frame blocked in flight and two still queued, retained queued payload
content fell from 10,129,280 UTF16 character bytes to about 5,064,640 UTF8 bytes.
The queue charged the same approximately 5,064,642 wire bytes including LF and
returned to zero after drain. The one-byte variation in one capture came from
timestamp fractional precision. These payload measurements exclude object and
array headers, serializer/encoder pools, the in-flight frame and the sink's fixed
buffer; they are not heap/RSS measurements. The owned sink models draining and
blocking, not an OS pipe or the desktop consumer.

Two-warmup/three-sample controls around 16 MiB retained the exact inline/artifact
gate and complete result bytes. Fourteen new native checks cover byte identity,
Unicode/nonfinite/null values, actual handshake/cancel/close frames, progress
replacement, queue capacity and cancellation, all five flush boundaries,
serialization/write failures, terminal order, closed admission and borrowed
stream ownership. The initial missing-sink RED had nine failures and seven
existing passes; the final complete C# suite passed 63/63 with zero skips.

The compared baseline DLL is `4cae6295...`, candidate DLL `1994b73f...`, and owned
helper `414f0180...`; exact hashes, input/runtime pins, raw rows and test logs are
in `.local-validation/inline-stream/receipt.json`. The candidate native input
fingerprint is
`bfe17fb6cd138d94d020fafeba235cfa8548b509907ac44173c3dc265da481f7`
(306 inputs). This is isolated compiled-source evidence, not a packaged-app,
Windows, full MAP causal-DAG, first-frame or GPU result. Normal desktop wall time,
consumer decoding and graphics performance remain unmeasured by this probe.

## MSB request phases and bounded source snapshot

A subsequent actual daemon run used the same m10 DFLT MSB at the normal 16 MiB
frame budget, one active request and the compiled producer `1994b73f...`.
Twenty warm requests had median send-to-complete-result-byte time 45.021 ms,
owned Python JSON processing 18.270 ms and native progress-window time 21.424 ms.
Those progress timestamps include frame/enqueue work and did not expose pure
MSB native execution. The Python reader is not Electron main or Core; these
intervals are not a complete MAP causal DAG or first-frame measurement.

MSB reads now opt into the existing bounded timing collector using
`diagnosticTimings: true`. A separate `MSB_NATIVE_TIMINGS` diagnostic exposes six
fixed phases, native queue/start/completion timestamps and scalar source receipts.
The same captured outer bytes supply both physical identity and leaf decoding.
Physical SHA256 `8dca8500...` and decoded MSB SHA256 `d418012f...` remain distinct.
Default-off output retains the exact original result; static MAP geometry keeps
its existing timing schema. Unexecuted phases and source identities remain
explicitly unavailable, including early missing-file failure.

That inspection also found the previous MSB path allocated the complete outer
file before its native size checks. The MSB-only source reader now borrows one
opened handle, checks the existing 512 MiB DCX outer and 128 MiB MSB raw/declared
leaf limits before full allocation or supported leaf decoding, and rejects
growth or truncation instead of publishing a partial snapshot. The handle uses
the former `FileShare.Read` behavior and closes on failure or cancellation.
Existing codecs retain malformed/unknown-header diagnosis and source-path
context. This is a local read safeguard, not a whole-MAP memory solution.

On the observed source input `2a566c9c...` (307 inputs) and DLL `3f3c3fc1...`,
twenty warm opt-in requests measured median native total 20.299 ms and queue
wait 0.228 ms. Phase medians were file read 0.169 ms, physical hashing 0.271 ms,
DCX resolution 3.723 ms, initial MSB parse 3.061 ms, verification 13.028 ms and
envelope projection 0.471 ms. Verification's mean 14.667 ms was about 63% of
mean native total 23.269 ms. It includes a source copy, another MSB parse and
hashes, so it is the next concrete CPU/allocation target; adding its nested work
or historical stage medians to native total would double count.

The opt-in run's send-to-result-byte median was 58.516 ms and owned Python parse
median 19.616 ms. It is an observation run, not a paired optimization comparison
with the earlier producer. Default result identity, opt-in base result, queued
cancellation, same-source reopen, zero active/queued health, workspace close and
native process exit were verified. Full source/input/producer pins and rows are
retained in `.local-validation/msb-native-timing/final-receipt.json`. Independent
review reproduced an important final-header boundary: valid DCA magic at 0xFC
has its length at 0x100–0x103. The reader now captures 0x104 bytes while keeping
the codec's original 0x100 magic-search limit. The actual reader negative failed
before that correction; the final source `5879f573...` and DLL `07795d12...`
passed 75/75 native cases with zero skips. A bounded current-producer read
reconfirmed default silence, opt-in source receipts and cancel/reopen/close
without repeating the twenty-sample phase experiment. Its separate rebind
receipt preserves the earlier timing evidence's original producer identity.
Renderer/main-process timing, actual m10 static-model geometry and GPU first
frame remain outside this capture; the restored m10 MAPBND is still KRAK and
unavailable to the current Linux decoder.

## Private MSB verification snapshot

An owned helper bound to that current `07795d12...` producer and `5879f573...`
source separated verification work on the same 6,772,360-byte MSB leaf. Twenty
samples measured actual compiled verification at mean 13.688 ms and about
9,744,720 current-thread allocated bytes. The explanatory subscopes measured
the source copy at 1.244 ms / 6,772,384 bytes, reparse at 3.272 ms / about
2,970,720 bytes, semantic comparisons at 0.668 ms / 840 bytes, and the two leaf
hashes at 4.060 and 3.995 ms / 360 bytes each. These separately instrumented
scopes exclude the initial parse and are not a request DAG; their sums must not
be added to prior request totals. Raw rows and the exact source-extracted
comparison lineage are retained under `.local-validation/msb-verify/receipt.json`.

Only `read-msb-document` now uses an internal owned verification entry point.
Its raw snapshot is a fresh private allocation, or its DCX resolution returns
a fresh decoded payload. The local synchronous parse/verify interval has no
cache, asynchronous yield or external callback publishing those bytes. Timing
retains scalar receipts only, and the eventual envelope publishes projected
values rather than the source array. The public `VerifyRoundTrip` still copies
the caller-retained mutable array. Writer and semantic-export callers are
unchanged. Both paths use the same complete second parse, semantic comparisons
and both source hashes; `ByteIdentical` remains false because no writer rebuild
is being tested.

The current compiled candidate has native input fingerprint
`ef466a636f9c4a030928c13992e850eeb0797efa9e28332eb456ad822410db37`
(307 inputs) and DLL
`12449b4b0b872fa1f1d7c6db0e9703527918e0c5be44d4e893385b5ec1b2e594`.
A second helper called the actual public-copy and internal-owned methods from
that same DLL, with fresh hash memos, three warmups and twenty paired samples
in each B/C and C/B order on .NET 10.0.0. Mean allocations fell from about
9.74 MB to 2.97 MB in both orders, a 69.50% reduction within verification. Wall
means were 13.622 to 11.452 ms (-15.93%) and 13.084 to 9.835 ms (-24.83%).
These natural-GC measurements support this local copy removal; they do not
measure full request latency, retained heap, RSS or first-frame/GPU performance.

Six new tests went from missing-entry RED on the prior producer to GREEN on
the candidate; the complete native suite passed 81/81 with zero skips. Tiny,
LOH-boundary and 2 MiB sources with tiny geometry confirm the public path still
allocates its separate source copy. Post-read name mutations, with and without
an earlier hash memo, still fail semantic verification and preserve the original
versus current hash distinction. Invalid mutated bytes still throw rather than
reuse an earlier verification. These are controlled mutable-array checks, not
a promise that the owned path supports concurrent external mutation.

The complete 2,532,035-byte native result remains SHA256 `fb5fb97c...` in both
actual-method projections. A bounded candidate daemon capture at the normal
16 MiB / one-active-request settings reconfirmed default timing silence, all six
opt-in phases with physical and leaf source identity, queued cancellation without
a late result, same-source reopen, zero active/queued health and close, and exit
zero. Input bytes remained unchanged. Exact pins, every measured row and the
separate daemon capture are in
`.local-validation/msb-verify/actual-receipt.json` (SHA256 `624dffff...`).
The two full leaf hashes remain the largest measured verification CPU component.

## Actual Node client return boundary

A subsequent owned capture called the unmodified compiled Core
`BridgeDaemonClient` with the official .NET entry and that same `12449b4b...`
producer. It retained the 16 MiB / one-active-request negotiation and same
physical/decoded MSB hashes. The compiled bodies of four relevant Core modules
matched their current source emitted by TypeScript 5.9.3; 72 input/runtime/source
pins matched before and after. The 65 canonical code/compiler inputs were also
copied into owned evidence storage before later rebuilds could replace them.

Three warmups and twenty measured requests had median client request-to-payload
return 90.162 ms and same-request native total 24.815 ms. The final decoded stdout
chunk callback-to-parsed-frame boundary was 10.677 ms, and parsed frame-to-payload
return was 0.146 ms. The chunk callback is Node event delivery rather than OS read
readiness; its interval includes remaining line handling and `JSON.parse`, so it
is not a pure parse measurement. Native completion-to-parsed-frame epoch gap had
median 64.495 ms with the existing 5 ms tolerance. It includes native output
serialization/queueing, pipe transfer and Node frame handling. Native execution
overlaps the client request span; these values are not a critical-path sum.

The bounded observer forwarded the original private method return/promise and
throw behavior, retained metadata rather than result arrays, and restored the
methods after disposal. All 105 actual frames and 23 rows carry request/session
identity. The capture verified complete result values, source identity, queued
cancellation with an actual cancelled terminal receipt and no result replay,
same-source reopen, zero active/queued health and close, and native exit zero.
Natural-GC Node heap/RSS and native RSS observations are snapshots rather than
allocation totals, peaks or retained-memory proof. Evidence is under
`.local-validation/msb-node-client/receipt.json` (SHA256 `dec2f327...`), with report
SHA256 `e12068f9...` and owned input-copy manifest `61260fd7...`.

This records the real Core client/native return path. It does not execute
`msbBridgeRead` projection, the MAP application service, Electron IPC, renderer
preparation or GPU first frame. This observation run is not a paired whole-request
comparison with the copy candidate.

The MSB helper now accepts optional explicit session and timing options. Absent
session options retain the former scope; an explicit session is forwarded exactly.
Default, false and non-boolean timing inputs add no timing options or diagnostic
details. Only an explicit true forwards the existing native/client timing option and
retains details for the two known timing codes. Other details stay omitted and the
full document projection is unchanged. Six source-bound recording-port regressions
went from 3/6 RED to 6/6 GREEN, with strict actual-source type checking and independent
peer review. Those regressions are not native performance measurements.

A separate two-read integration compiled that actual helper source and called the
real compiled Core `runBridge`, which normally discovered an independently copied
official apphost at the product's ordinary Release publish path. Apphost SHA256 is
`b4c23318...`; receipt SHA256 is `6b2430c0...` and source remains `ef466a63...` / 307
inputs. All six executable/receipt/native-library/runtime-notice files were copied
and hash-checked; the standard freshness assertion also passed in the owned tree.
The default 16 MiB / two-concurrent-request configuration stayed unchanged. Default
and opt-in DTO data were equal, default diagnostics remained silent, and the opt-in
request's actual UUID/session and both source hashes carried native and transport
details through the helper. Both native pools were disposed. This verifies the real
helper transport/projection contract, not latency or Electron/main execution;
`.local-validation/msb-node-client/helper-real-read.json` has SHA256 `cacd5b48...`.
The main service adapter subsequently captured the same owner/session before its
first await and retained the read-owner/generation guards. A headless capture of
that unmodified application service (`d0fab033...`) used actual scanner, workspace,
index, read roots, compiled Core/helper, native apphost and renderer DTO sanitizer
functions. Two warmups and ten measured reads had median application return
157.696 ms, nested helper return 100.278 ms, map projection 9.645 ms, index ingest
6.742 ms and sanitizer 35.031 ms. Native execution (24.571 ms) is also nested;
these durations must not be added. Actual request/session UUIDs, both input hashes
and the identical complete DTO data SHA256 `be36ea81...` are retained in receipt
`6170c986...`. The 25 observed source/input pins matched before and after capture;
ten additional implementation copies are explicitly a post-run inventory. This
executes production functions in owned Node/VM storage, not Electron IPC/main
runtime, renderer preparation or GPU first frame.

### Allocation regression contract correction

The hosted Linux native suite exposed an over-precise assertion in the new copy
control: its 2 MiB source delta was 2,100,592 bytes, outside `sourceSize + 64`,
while all verification reports and the other 80 tests passed. An owned single-thread
probe on the unchanged `12449b4b...` DLL and .NET 10.0.0 reproduced that exact delta.
Its 360 natural pairs had 28 failures of the old bound, with source-relative extras
from -5,328 to +6,064 bytes. Subsequent GC-instrumented and original-binary controls
reported +24 throughout. Those controls do not uniquely attribute the transient
variation to GC or JIT. The thread-wide allocation counter is not an object-local
copy measurement; the product source and outputs did not change.

Small/85,000-byte/2 MiB fixtures still compare full reports and hashes. The allocation
contract now uses seven alternating pairs on the large-source/tiny-geometry case,
with a median delta and a source-relative 1/16 tolerance. It detects a missing or
additional whole source copy without asserting an exact runtime allocation total.
Two owned source mutants proved sensitivity: deleting the public copy and adding
an owned-path copy each failed the allocation assertion with a zero delta while
the other five report/mutation/error checks passed. The unchanged real producer
passed all 81 tests with zero skips. No product, runtime flags or budgets changed;
trace, mutant source/DLL identities and tests are retained under
`.local-validation/msb-allocation-contract/`.

### Renderer string masking fast path

The application capture identified sanitizer traversal as an available CPU cost.
A separate single read through the frozen service captured its complete actual
pre-sanitizer input, preserving the same DTO data hash. Of 10,053 strings, 9,870
contain neither a colon nor a backslash; 9,817 values are unique. The candidate
therefore uses no memo or retained DTO cache. Every existing masking regex requires
one of those two characters, so their absence returns the original string before
regex replacement; all possible matches use the unchanged shared replacements.
Object traversal, sensitive-field filtering, source-text exemptions and binary
identity remain unchanged.

Twenty paired sanitizer-only operations in each B/C and C/B order gave median
36.740 → 32.644 ms (-11.15%) and 34.612 → 30.368 ms (-12.26%). CPU time moved in the
same direction. Tiny and 10,000-unique-string controls showed no measured regression.
The complete serialized output stayed equal, including the real DTO golden. The
owned comparison also covered 20,000 deterministic mixed-character strings,
Windows/UNC/device/file-URI masking, logical URI and existing POSIX-string behavior,
source-content exemptions, sensitive keys, own enumerable/getter order, thrown
error identity, diagnostic details, primitives, sparse arrays and binary identity.
The maintained shared regression went from 7/8 RED to 8/8 GREEN and demonstrates
that impossible matches avoid regex work. Strict checking of both shared source
files passed. Evidence is under `.local-validation/renderer-sanitizer/`, with
comparison report SHA256 `41d47d1b...` and receipt `42e319ce...`.

This is a measured local sanitizer CPU improvement. Natural-GC heap/RSS snapshots
do not establish exact allocation or retained/peak memory savings. The comparison
does not measure whole-request, Electron, GPU or first-frame improvement.

### Primitive field projection

A follow-up that merely reordered the source-text Set lookup was rejected: it
reduced lookups from 132,720 to 10,040 but had mixed median CPU/wall results across
the two orders (+0.98% and -4.29%). It was never added to production. An independent
sampled CPU stack then identified the object-entry loop and recursive field call
as the remaining prominent sites. This profiler run is diagnostic evidence with
sampling overhead, not a latency baseline.

The retained candidate keeps `Object.entries` and sensitive-field filtering, copies
non-object primitive fields directly, sends ordinary strings through the same
masking function, and continues to recurse into objects. Source-text strings still
pass through verbatim. No result/input cache or shared mutable projection is added.
With the preceding shared masking fast path held constant in both variants, two
20-pair sanitizer-only B/C and C/B comparisons had medians 30.634 → 18.637 ms
(-39.16%) and 29.912 → 17.474 ms (-41.58%); CPU moved in the same direction, and tiny
and unique-string controls showed no measured regression. The full real serialized
DTO and its existing data golden remained equal. Raw rows, source/runtime/input
pins and comparisons are in `.local-validation/renderer-primitive-copy/`, report
SHA256 `4503283c...`.

Eight maintained source-bound regressions went from 7/8 RED to 8/8 GREEN. They
cover fewer primitive recursive visits, unchanged path/source-text/diagnostic
projection, new output objects without aliases to mutable inputs or other output
copies, own getter snapshot order including filtered fields, original thrown
error identity, primitives, sparse arrays, binary identity and cyclic-object
failure. Strict checking of the actual renderer DTO source passed. This remains
local projection CPU evidence; natural-GC snapshots do not prove exact allocation
or retained-memory savings, and whole-request/Electron/GPU/first-frame improvement
has not been measured.

A subsequent complete application-service comparison used the same frozen service
source, actual compiled Core/helper, independently copied normal apphost, input,
workspace/index and read roots. The shared masking fast path was common to both
variants; only primitive dispatch differed. After four warmup reads, ten pairs in
each B/C and C/B order gave application-return medians 122.121 → 102.916 ms (-15.73%)
and 110.983 → 102.067 ms (-8.03%). The same requests' sanitizer medians were
32.339 → 20.316 ms and 32.668 → 20.849 ms. Native/helper timings also drifted between
variants, so the complete return difference is not entirely attributed to the
sanitizer. Native and helper spans are nested within application return, not added
as a critical-path total.

All 44 read rows retained request/session/source identity, and the 177 actual
frames retained request/session metadata. All DTO data hashes were identical,
all 29 observed pins matched before and after,
and the actual index retained 7,404 map entities and 1,506 regions. Observation had
zero errors, native pools were disposed and hooks restored. Receipt `c95984fa...`
and report `36b2533f...` are under `.local-validation/msb-service-paired/`. This
measures headless production application functions through native return and DTO
projection. It does not execute Electron IPC/main runtime, renderer preparation or
GPU first frame, and natural-GC memory snapshots remain limited.

### Submitted-frame observation integrity

The actual controller callback previously let submitted-frame clock/event errors
escape after `renderer.render` had succeeded, preventing the next RAF from being
scheduled. Five source-bound callback/loop controls went from 2/5 RED to 5/5 GREEN.
Only observation is protected; actual renderer errors retain their original
failure, and normal frame cadence/disposal stay unchanged. Missing or nonfinite
observation clocks produce no fabricated submitted-frame timestamp. The actual
controller and transitive source passed strict checking with real declarations;
the combined frame/post-return regressions passed 14/14 with zero skips.

These controls use a recording renderer and test observation integrity, not GPU
execution or first-frame latency. There is no fresh supported normal-app GPU
capability receipt in the current restored environment; older receipts were lost.
Current GPU availability is unknown, and hosted editor/native-frame successes do
not establish it. Actual MAPBND KRAK decoding and GPU first-frame evidence remain
separate limits.

### Renderer scene projection path checks

A source-bound CPU capture reused the actual returned MSB DTO and the current
controller's field expressions plus compiled browser-safe scene functions.
For 9,996 semantic entities and 8,910 drawable nodes, four warmups and twelve rows
gave medians of 1.604 ms for field projection, 61.379 ms for scene-manifest
construction and 24.645 ms for draw-list construction; the local projection span
was 88.027 ms. This excludes React scheduling, collision filtering, scene mount,
Electron IPC and GPU submission. Source/output equality and before/after pins
were checked; report `81950d60...` is under
`.local-validation/renderer-scene-projection/`.

Separate diagnostic instrumentation attributed 54.082 ms inside manifest
construction and 21.741 ms inside draw construction to the existing object path
guards. Their JSON serialization is nested inside those spans and still runs
unchanged. A structured-walk bypass was not adopted because public mutable,
getter and serialization semantics need to remain intact.

The accepted small candidate combines the three path predicates into their exact
union. It preserves JSON serialization, output order and error behavior while
scanning each serialized projection once. In ten pairs per B/C and C/B order,
manifest-plus-draw medians were 95.655 → 89.495 ms (-6.44%) and
103.108 → 96.418 ms (-6.49%); CPU medians fell by about 4 ms. All 48 rows and
293,970 raw/serialized/key/actual-field controls are retained in report
`fc9dc832...`, with unchanged full-output hashes and source/input pins.
Actual source regressions went from 5/6 RED to 6/6 GREEN, including every UTF16
code unit, public output identity/order, getter/toJSON errors, cycles, BigInt,
sparse arrays and nonfinite values. Strict checking passed. These are local
scene-preparation CPU results; natural-GC snapshots do not establish exact
allocation, retained-memory, whole-MAP, GPU or first-frame improvement.

The restored normal production App also started on the native desktop with an
owned profile and its original sandbox settings. Its ambient fallback and stock
log establish WebGL1 blocklisting only. Native inspector input failed before any
capability expression ran, so WebGL2 context and WebGPU adapter availability
remain unknown; the owned test windows were closed normally. Current TSL
secondary-diffuse source and the existing three CPU shader-construction tests
are present and pass, but do not establish actual GPU image parity.


### Native Windows whole-MAP observation (2026-10-03)

The fresh m11 production GPU receipt described in `SCENE_VALIDATION.md` measures
115,317 ms UI loading with zero failed models and scene errors, 20 classified
unavailable resources, a 197 ms maximum long task, and verified foreground
conditions. It passes the existing broad load/blocking regression guards;
34 visible long frame gaps still fail the smooth-interaction criterion.

Model request timelines cover 115,473.9 ms of wall time. Their summed spans are
879,722.6 ms, with 764,248.7 ms of overlap. These concurrent and nested spans must
not be added as a loading critical path. The report explicitly retains
`criticalPathVerified=false`: cross-model scheduler dependencies and opening,
render preparation and GPU milestones do not yet form a complete causal DAG.
This single fresh run is whole-path observation, not a controlled proof that an
individual CPU optimization reduced total loading or GPU first-frame latency.
