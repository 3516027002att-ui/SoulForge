# Mature Tooling Parity Audit — 2026-08-23

This checkpoint freezes the MAP / ACTION / EVENT acceptance standard after reviewing the current `main` implementation and the latest parity-oriented commits. It is a gate, not a redesign document.

## Global rule

A feature does not pass because it can render, move, or edit text.

- MAP passes only when the resource/model/material/texture/scene/editing chain behaves like a mature FromSoftware map editor.
- ACTION passes only when TAE → ANIBND → HKX identity, binding, skeleton mapping, sampling and playback come from authoritative game data.
- EVENT passes only when EMEVD/DarkScript semantics are correct and the source editor behaves like a real IDE.

Do not add fallback heuristics that silently turn missing semantics into a plausible-looking result. Missing authority must fail closed or surface an explicit partial/unsupported state.

## License gate

SoulForge remains Apache-2.0.

- Compatible source may be used with its required attribution.
- GPL projects may be inspected to learn behavior, file relationships, UX and validation expectations, but GPL implementation text must not be copied or adapted into SoulForge.
- License must be checked at file level, not only repository root. Example: Smithbox is MIT at repository level, but `src/Smithbox.Program/Utilities/Havok/SplineCompressedAnimation.cs` carries an explicit GPLv3 header and therefore is not an Apache-compatible implementation source.

### Immediate ACTION quarantine

The current `bridge/SoulForge.Bridge/Havoc/` tree must be treated as quarantined. Its class/file structure and implementation correspond to the GPLv3 `Meowmaritus/SoulsAssetPipeline/Havoc/...` implementation family. Do not build new SoulForge logic on top of it.

`bridge/SoulForge.Bridge/HkxNativeAnimation.cs` must also be treated as provenance-unsafe until rewritten or independently justified. Its spline decompression structure, method naming and constants overlap the GPL HavokLib / SoulsAssetPipeline / Smithbox GPL-lineage decompressor family. A comment saying “clean-room” is not sufficient provenance.

The cleanup target is not “rename/refactor until it looks different”. The target is an independently implemented decoder from compatible documentation/source plus black-box behavioral validation.

## ACTION audit

### What is currently wrong

`TaeNativeDocument` currently interprets `animFileInfo + 0x00 == 1` as an alias flag and suppresses the local HKX name. That is not the actual semantic layer.

For the Sekiro-era TAE layout used here, the animation file structure starts with a mini-header type:

- `0 = Standard`
- `1 = ImportOtherAnim`

For a Standard mini-header, authoritative fields include:

- `IsLoopByDefault`
- `ImportsHKX`
- `AllowDelayLoad`
- `ImportHKXSourceAnimID`

For ImportOtherAnim, authoritative fields include:

- `ImportFromAnimID`
- an additional unknown field

This behavior is represented in Smithbox's SoulsFormats `Formats/TAE/Animation.cs` and is also reflected in DSAnimStudio's animation resolution behavior.

The current `read-anibnd-hkx-animation` path then compounds the problem by generating candidate names such as `a000_XXXXXX.hkx`, `a00_XXXX.hkx`, raw numeric names, and similar patterns from `animId`. That is filename guessing and must be removed as an authority mechanism.

The current read command also emits poses by iterating integer frame indices with `SampleAllBones(f, loop:false)`. Integer-frame preview may be a diagnostic sampling mode, but it must not become the playback model. Runtime playback must be continuous-time and derive frame/block position from animation timing metadata.

### Required identity resolution

Implement one explicit resolver whose output records both the requested TAE animation and the resolved motion source.

1. Locate the requested animation by TAE animation ID.
2. Read the real mini-header.
3. If `MiniHeaderType == ImportOtherAnim`, follow `ImportFromAnimID` to the referenced TAE animation. Repeat until reaching a non-import animation. Detect cycles and missing targets and fail closed.
4. On the resolved Standard animation:
   - if `ImportsHKX == true`, motion identity comes from `ImportHKXSourceAnimID`;
   - otherwise motion identity is the resolved animation's own HKX identity.
5. Preserve an authoritative `AnimFileName` only when the TAE actually supplies one. It may be used as explicit source data, never replaced by generated filename candidates.
6. Resolve the ANIBND/HKX object through the binder/resource identity and HKX binding data. If identity cannot be proven, return an unresolved diagnostic instead of trying multiple plausible filenames.

The resolver must expose the chain for diagnostics, e.g. requested animation → imported event animation → imported HKX source → resolved binder entry. This is evidence, not UI decoration.

### Binding and skeleton gate

Do not align transform tracks to skeleton bones by index.

The HKX animation binding is authoritative for transform-track-to-bone mapping. Playback must:

- parse the animation object and its `hkaAnimationBinding` relationship;
- consume transform-track-to-bone indices from the binding;
- map those bone indices into the selected skeleton;
- use reference-pose transforms for bones with no animation track;
- surface out-of-range or incompatible binding indices as diagnostics instead of silently reindexing.

Skeleton selection/remapping must be identity/name/hierarchy based where the source format requires it; a same-length array is not proof of compatibility.

### Sampling gate

Required formats for the Sekiro path are at least:

- spline-compressed animation;
- interleaved-uncompressed animation.

Sampling must be continuous-time.

- Convert playback time to animation-local sample/block coordinates using duration/frame-duration metadata.
- Preserve fractional frame position.
- Spline tracks must evaluate at fractional position using the actual knots/control points and the format's quantization rules.
- Interleaved tracks must interpolate between neighboring samples; rotation interpolation must follow quaternion semantics rather than component-wise linear interpolation.
- `loop` and `clamp` are distinct policies. Boundary behavior at exactly duration, negative time and multi-loop time must be deterministic and tested.
- The editor playback clock must pass time, not pre-rounded integer frame numbers, into the animation sampler.

### ACTION regression tests required before merge

At minimum add fixtures/tests that would fail the old implementation:

- TAE Standard animation with `ImportsHKX=true` resolves a different motion source ID.
- TAE `ImportOtherAnim` chain resolves correctly.
- import cycle fails closed.
- ANIBND entries deliberately renamed so filename guessing cannot succeed, while authoritative identity still resolves.
- binding order differs from skeleton bone order and still animates the correct bones.
- unanimated skeleton bones preserve reference pose.
- fractional-time spline sample differs from both neighboring integer samples and matches a trusted reference.
- interleaved fractional-time translation/rotation interpolation matches a trusted reference.
- loop and clamp differ at/end beyond duration exactly as specified.

## MAP audit

### What is worth keeping

The current work has useful infrastructure that should not be thrown away blindly:

- pooled `BufferGeometry` resources;
- explicit 16/32-bit index handling;
- FLVER position/normal/UV extraction;
- recent skinning/index remap corrections;
- free-look/fly camera work;
- scene/resource separation work.

These are foundations, not parity completion.

### What currently fails the mature-map criterion

`modelResourcePool.ts` currently gives every real model one neutral `MeshStandardMaterial` with hard-coded roughness/metalness/color. That proves geometry can be displayed, but it bypasses the real FLVER material → shader/material definition → texture slot → texture resource chain.

The current wire payload contains geometry-centric fields (`positions`, `indices`, `uvs`, `normals`) but no authoritative per-mesh material binding/texture chain in the rendering contract. Therefore the present path must be classified as geometry preview, not mature map rendering.

### Required resource chain

For a map part, retain the actual identity chain rather than flattening it into “modelName → geometry”:

MSB Part → model/resource identity → MAPBND/BND entry → FLVER mesh → material index → material definition/shader metadata → texture slots → texture container/resource → GPU material/texture instance.

The exact Sekiro material source files and texture container locations must be resolved from game/resource data. Do not assign substitute colors or infer a material from a model-name prefix when data is missing.

Resource pooling should remain, but pool keys must include the authority that affects the resulting GPU resource. Geometry, material and texture lifetimes may be pooled independently; two instances may share geometry while differing in transform, visibility or editor state.

### MAP regression gate

Before calling MAP mature:

- one known Sekiro map must load multiple real model resources through the same resource resolver used by the editor;
- meshes with different material indices must render differently because of real material/texture data, not hard-coded styling;
- missing texture/material resources must yield explicit diagnostics;
- repeated parts must demonstrably share pooled immutable GPU resources without sharing mutable editor selection/transform state;
- selection, framing, hide/show, transform editing and camera navigation must operate on scene instances while preserving source identity;
- save/patch must modify the authoritative MSB data, not renderer-only transforms.

## EVENT audit

### What is already useful

Do not replace the existing event workbench wholesale. It already contains several pieces worth preserving:

- CodeMirror-backed source editing;
- EMEDF-driven instruction-name completion;
- instruction hover information;
- event/resource navigation helpers;
- event-block folding/gutter diagnostics;
- per-tab editor state/undo history;
- incremental loading for very large EMEVD source;
- fail-closed behavior when EMEDF is missing.

The current source explicitly says Outline / Problems and related IDE panels are not rendered, so EVENT is not yet at the frozen acceptance target.

### Required semantic-service split

Do not keep adding regex features directly to the editor component. Mature IDE behavior needs one document semantic service that owns a parsed/indexed model of the DarkScript source and exposes editor-neutral queries.

Required query families:

- completion at position;
- signature help / active parameter at position;
- hover;
- diagnostics;
- definition;
- references;
- document symbols / Outline;
- workspace symbols;
- code actions / Quick Fix.

CodeMirror should be an adapter over these services. The same semantic engine should be testable without a DOM.

### Completion/signature gate

Instruction-name prefix completion is only the first layer.

The semantic engine must know the current call expression and argument index, then offer:

- instruction/function names;
- formal parameter names where the language permits them;
- enum members from the parameter's EMEDF type;
- event IDs / event parameters where semantically valid;
- other resource IDs only when their role is known from authoritative metadata.

Signature help must remain open while moving between arguments and visibly track the active parameter. Nested expressions and incomplete calls must not crash the parser.

### Diagnostics / navigation gate

Diagnostics must be produced incrementally and attached to source ranges, including at least:

- unknown instruction/function;
- wrong argument count;
- literal/type mismatch detectable from EMEDF;
- invalid enum value/member;
- unresolved event reference;
- parser/syntax errors;
- assembler/compiler errors mapped back to source when available.

Go-to-definition/find-references must use a document/workspace symbol index rather than string search. Event definitions, event calls/references and local/event parameters need distinct symbol identities.

Outline, Problems, Quick Fix and symbol search are required views over the same semantic model, not separate ad-hoc parsers.

### Long-file gate

Keep the current incremental source loading work. Add a performance acceptance test around realistic common-event scale. Semantic indexing must be incremental/cancellable and must not rebuild all 70k+ lines synchronously on each keystroke.

## Merge order

1. ACTION: quarantine GPL-lineage implementation; fix TAE mini-header parsing and authoritative identity resolution first.
2. ACTION: establish a license-clean HKX object/binding decoder, then spline/interleaved continuous-time sampling and skeleton mapping.
3. MAP: keep geometry/resource/camera foundations, replace neutral-material preview path with the real material/texture resource chain.
4. EVENT: keep the current CodeMirror/incremental-load base, move semantics into an editor-neutral language service and fill signature/diagnostics/navigation/symbol/code-action gaps.

Do not merge parity claims based only on screenshots, smoke tests or “it renders/moves/edits”. Each item above needs fixture-backed evidence against real Sekiro resources or a trusted reference implementation's observable behavior.