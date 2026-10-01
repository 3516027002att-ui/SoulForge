# Scene refactor validation

This change separates scene construction, resource ownership, camera control
and frame cadence. The projection controller still owns selection, gizmos,
instancing and spatial indexes. Scene input remains plain semantic data; none
of the extracted modules takes ownership of documents or native buffers.

`MsbScenePanel` consumes shared `scene-ir` manifest/draw-list placements.
`FlverViewer` retains its typed FLVER adapter because standalone and assembled
characters also require bone palettes, follower mappings, pose updates and
native per-mesh skinning modes. Both adapters mount the same projection core
and use the extracted environment, resource registry, camera and render loop.
This is an explicit remaining adapter boundary, not a second renderer.

## Verified coverage

- Headless functional smoke: 16 picking, camera, skinning, replacement,
  cancellation and repeated-disposal scenarios
- Scene unit tests: 50 tests; scene contracts additionally cover independent
  numeric/image comparisons, receipt corruption, bounded pagination and TSL
- Actual Three 0.172 TSL builder emits WGSL sampling primary, secondary and
  mask textures on their declared UVs; both mask branches compile offline
- Native mesh classification: empty, degenerate, unsupported topology,
  missing ordinal, vertex/index limits, unsupported positions and valid triangle
- Real structural smoke: c4510/c5030, 25 meshes checked; 16 drawable, 9 empty,
  no decode failures. Empty meshes are 3 in c4510 and 6 in c5030
- MAP verifier fixtures: responsiveness failures affect the suite verdict;
  deliberate blocking and over-limit loading fail. Initial guards are 260 s
  total loading and 400 ms blocking; they are regression limits, not UX targets
- MAP wire budgets include complete returned envelopes, including texture data
  URIs and retained diagnostics across pages. The normal verdict requires
  structured terminal counts with zero failed models/scene errors; classified
  unavailable assets have their own count. Missing or malformed counts fail

## Independent native comparison

The external SoulsFormatsNEXT executable is pinned to
`ee1dd61958f60bdc51ce3da548e9a90a8ab39905` (GPL-3.0). Its source and binary
remain outside the Apache product and are never packaged. This independent
execution can catch implementation errors; its shared format lineage cannot
resolve a misunderstanding common to both parsers.

The fixed container SHA-256 values are:

- c4510: `06304a3a91d6827f971fd9ed77ff85473d32e432559796fda730b915471a87ec`
- c5030: `3fea221d87225dc0c66ff77e714104242057e86df28788b565e10b2422a30981`

Across 16 drawable meshes, positions agree within 9.53e-7, normals within
2.95e-8, UVs within 5e-8 and native weights within 2.96e-8. Integer triangle
indices and projected bone indices agree exactly. RGBA vertex colors, 1,532
bone names/hierarchy/local transforms, native header bounds and exposed
material/texture references are also compared. The report identifies bounded
document truncation rather than treating prefixes as complete coverage.

The independently pinned iOrange/bcdec oracle
`80859ed3b7afb1c527a2a99d70c61457bea72d0c` (MIT OR Unlicense) agrees with the
production DDS decoder on 9 raw top-mip RGBA8 buffers: 2 BC7 textures are
byte-identical; 7 BC1 textures differ by at most 1/255 per channel. This compares
native channel values before colorspace conversion, filtering or rendering.

Reproduce field comparisons after building the Bridge:

```sh
node scripts/capture-flver-bridge-observations.mjs <external-oracle-results> <private-observations> <bridge.dll>
node scripts/compare-flver-independent-fields.mjs <external-oracle-results> <private-observations> <bridge.dll> <private-report.json>
npm run test:scene-contracts
npm run test:three-scene-functional
node scripts/verify-map-streaming-native.mjs --fixture
npm run test:map-timing-contract
```

Receipts bind every observation to its raw leaf and producer DLL hash. Reports
also identify the comparison script hash and checkout commit. A deliberate
weight corruption fails in the Bridge report; downstream unobserved layers
remain unverified. Original game files and reference pixels stay private.

## Layered projection comparison

`scripts/compare-scene-projection-fields.mjs` extends the private raw-field
evidence without another native read, a GPU launch or a product rebuild:

```sh
node scripts/compare-scene-projection-fields.mjs <stable-built-product-root> <external-oracle-results> <private-observations> <bridge.dll-or-executable> <private-output-directory> [independent-matrix-expectations.json]
```

The bounded run against product checkout `5e9f864` passes 16 drawable c4510 /
c5030 meshes through the compiled core single-model leader DTO and the shipped
renderer adapter into actual Three `BufferGeometry` attributes. Positions,
normals, indices, both UV sets, vertex alpha, bone indices and runtime-normalized
weights are compared directly with independently exported fields. All 1,532
bone names, parents and local TRS values survive the observed layers. This
checks renderer inputs before GPU upload; it does not validate a sampled pose,
bone FK, bind inverses or rendered pixels. Nine classified empty meshes remain
outside the drawable projection and retain their separate raw-field evidence.

For the real MSB source
`56304e9c1089b64336fecbbd63f84834c12aa0e87d33f258655e5097482ab62a`,
the compiled core Bridge mapper, shared `scene-ir`, draw list and unchanged
renderer instance-batch construction compare all 2,499 parts and 391 regions.
Their positions, degree rotations, scales, labels, model links and 46,240
instance-matrix components pass independent scalar TRS expectations. Spatial
index callbacks use inert test implementations; actual matrix construction and
Three classes come from the compiled product. This covers proxy placements,
not loaded map FLVER geometry or the original halfway stall.

NEXT disambiguates duplicate names at read time. Two region display names have
synthetic ` {2}` / ` {3}` suffixes. The comparison inflates the existing DFLT
source in memory, verifies its entire decoded SHA-256, and checks the native
UTF-16LE bytes before using the raw label. The report preserves raw/display
name pairs, offsets and byte hashes. It does not remove arbitrary suffixes.

Three deliberate Bridge-field injections, one mesh position per FLVER and the
first MSB part's X position, fail the observed downstream fields and identify
Bridge as the first divergent layer. Original captures remain unchanged.
Two additional false-empty injections fail Bridge classification instead of
allowing a drawable mesh to disappear from the pass predicate. Empty topology
is derived from the independent oracle before any projection exclusion.

The report binds corpus files, oracle exports, Bridge observation receipts,
producer DLL, compiled module hashes, selected source hashes and product commit.
Shipped renderer/Three outputs and selected sources match the desktop build
receipt. Core/shared compiled modules are individually hash-bound, but that
desktop receipt does not independently attest their compilation. Every bound
input and HEAD is rechecked before publishing the private report; changed
inputs stop the run. The older MSB capture lacks the FLVER capture's producer
receipt, so its narrower source/decoded-hash provenance is explicit.

The newly localized format/projection gaps are also explicit: tangents are
absent from the current Bridge preview wire, and full native vertex RGB from
Bridge RGBA diagnostics is not projected by the current FLVER viewer adapter.
Alpha is compared. Complete native shader/material bindings, follower
assemblies, MSB subtype payloads and animation remain outside this bounded run.

The next local preservation fix now exports native tangent/bitangent diagnostics
and retains full RGBA and XYZW sets, member metadata and failure statuses through
both FLVER adapters into private four-component geometry attributes. These
attributes do not enable generic vertex-color, opacity or tangent shading. A
fresh isolated Bridge build also uses the existing complete skeleton helper for
standalone reads, preserving native reference FK. Against the pinned external
exporter's own `Node.ComputeLocalTransform`, all 1,532 FK matrices agree exactly;
799,648 tangent components agree within 2.95e-8. The exporter separately provides
independent inverse-reference FK expectations. The original projection report
above stays bound to its earlier product build. The expanded private report is
now bound to integrated product commit `34c86bc`, its fresh compiled outputs,
and published native producer SHA-256
`c6517df62119c9f82f7a9ea64146971f1b8ab42462377f07545913495870b169`.

That report checks 79 hashed inputs and 32 fresh native observations. Across
16 drawable meshes, 678,336 RGBA components and 54,720 bitangent components
agree exactly; 799,648 tangent components agree within 2.95e-8. All 166 raw
texture references agree. Native reference FK is exact across 1,532 nodes;
actual renderer world FK differs by at most 1.75e-6 and inverse binds by at most
4.36e-6. The controlled cross-source follower checks 107 mapped nodes, 184
unmapped nodes and 94 source-node additions, with 105 weighted/ancestor nodes
required to map. Its current FK differs by at most 1.83e-6 and source inverse
binds by at most 3.51e-6. All 2,890 MSB placements / 46,240 instance-matrix
components pass. Eight deliberate field/classification/mapping negatives reject
at their first altered layer. These are CPU/input comparisons and do not
establish game equipment, sampled animation, GPU pixels or backend parity.

The expanded runner checks actual compiled `mountFlverScene` construction with
real Three skeletons and skinned meshes under a headless mount core. Independent
row-vector FK and inverse matrices are converted through the explicit native Z
mirror; absolute matrix tolerance is 1e-5 for float32-oracle/double-renderer
rounding. Controlled same-asset and c4510-leader/c5030-follower namespaces exercise
source inverse binds and direct mapping without claiming game equipment. All
positive-weight source bones and their parent closure must have valid mappings;
an omitted required mapping fails at core. Each runtime verdict contributes to
the report's overall result.

Capture now supports a framework-dependent DLL or published executable and
records the actual binary/tool hashes. Nonzero exits and malformed Bridge
envelopes fail before a manifest is written. The report enforces commands,
options, launch kind, source hashes and fresh MSB receipts, and compares complete
raw texture-slot references. Diagnostic metadata is checked against native
layout bytes and independently exported type names.

Focused source verification passes 15 native vector/buffer failure cases, 8 mesh
classification cases, 18 remaining-gap assertions, 19 viewer tests, 54 scene
unit tests, 21 script contracts, 16 functional scenarios and strict TypeScript.
Declared buffer-length/data-region failures cannot expose partial diagnostics
or be mislabeled absent. Unsupported layouts remain explicit gaps.

## Remaining acceptance work

These checks are bounded implementation evidence. They do not complete #30,
#31, #33, #34, #50 or #55 on their own.

- #30/#33: 5–10 real asset images still need game/mature-tool confirmation,
  per-backend image baselines and independent FK/bind-matrix expectations
- #31: request phases add up with explicit clock tolerance and report native
  queue wait separately from pre-native IPC/main/transport cost. Shared-frame
  submission is measured, not display presentation. Cross-model scheduler
  dependencies and full MAP opening milestones remain an incomplete causal DAG
- #34: WebGL2 remains the default. Actual two-backend image and performance
  parity must pass before changing the default
- #50: integrated-build field reports cover diagnostic preservation, reference
  FK, actual runtime inverse binds and controlled follower mechanisms. Full
  material names/MTD metadata beyond the document preview, additional native
  streams, game-confirmed equipment, MSB subtype/TAE/HKX and shader/image fields
  remain outside this bounded report
- #55: repeated cursors, incomplete terminal pages and stuck/cancelled loaders
  now terminate with diagnostics. The original large-map halfway stall still
  needs a matching asset/build reproduction before it can be called fixed
