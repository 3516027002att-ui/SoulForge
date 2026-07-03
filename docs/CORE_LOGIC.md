# SoulForge Core Logic

This document defines the core logic that Codex should preserve while implementing the first version.

## 1. Central idea

SoulForge is built around an evidence graph.

A normal editor opens files. SoulForge opens a mod workspace and turns scattered game resources into connected, queryable facts.

The v0.1 evidence graph starts from events:

```text
Event
  -> Event instructions
  -> Flags
  -> Map entities and regions
  -> Param rows
  -> Text entries
```

The AI must reason from this graph rather than raw guessing.

## 2. Workspace scanning

Input: native ModEngine-style mod directory.

Output: indexed file inventory.

Scanner responsibilities:

- Discover known resource directories.
- Classify files by path and extension.
- Record basic metadata.
- Avoid deep parsing unless requested or scheduled.
- Never write to workspace during scanning.

Known directories:

```text
event
map
param
msg
menu
script
action
ai
sfx
```

File metadata:

```ts
interface IndexedFile {
  id: string;
  workspaceId: string;
  sourceUri: string;
  absolutePath: string;
  relativePath: string;
  resourceKind: ResourceKind;
  extension: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
  parseStatus: ParseStatus;
  diagnostics: Diagnostic[];
}
```

`sha256` may be lazy. Do not hash every large file at startup unless the user requests a validation operation.

## 3. Resource URI rules

Every file and symbol must have a stable URI.

URI examples:

```text
file://event/m11_00_00_00.emevd.dcx
event://m11_00_00_00/11002800
instruction://m11_00_00_00/11002800/42
map://m11_00_00_00/entity/1102800
map://m11_00_00_00/region/1102800
param://SpEffectParam/123456
msg://GoodsName/1000
```

URIs are internal identifiers. They should not depend on absolute paths where avoidable.

## 4. Diagnostics model

SoulForge should fail honestly.

```ts
interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  sourceUri?: string;
  details?: unknown;
}
```

Examples:

- `UNSUPPORTED_FORMAT`
- `BRIDGE_TIMEOUT`
- `PARSE_FAILED`
- `PARTIAL_EXPORT`
- `REFERENCE_AMBIGUOUS`
- `VALIDATION_FAILED`

## 5. Parse status

```ts
type ParseStatus =
  | 'unparsed'
  | 'parsed'
  | 'partial'
  | 'unsupported'
  | 'failed';
```

Rules:

- Use `unparsed` before any parser/bridge attempt.
- Use `parsed` only when real structured data exists.
- Use `partial` when some symbols are extracted but diagnostics remain.
- Use `unsupported` when the format is known but no parser exists.
- Use `failed` when a parser exists but failed.

## 6. Bridge contract

The bridge returns JSON only. No human-only text should be required for the app to understand the result.

Generic output shape:

```ts
interface BridgeResult<T> {
  sourceUri: string;
  sourcePath: string;
  game: string;
  resourceKind: ResourceKind;
  parseStatus: ParseStatus;
  diagnostics: Diagnostic[];
  data?: T;
}
```

Bridge commands:

```text
inspect <file>
export-event <file>
export-map <file>
export-param <file>
export-msg <file>
```

The bridge should be replaceable. TypeScript code should depend on the JSON contract, not on C# internals.

## 7. Event export model

Minimum event export:

```ts
interface EventExport {
  mapId?: string;
  events: EventSymbol[];
}

interface EventSymbol {
  uri: string;
  eventId: number;
  name?: string;
  instructions: EventInstruction[];
  raw?: unknown;
}

interface EventInstruction {
  uri: string;
  index: number;
  name?: string;
  category?: string;
  args: EventArg[];
  raw?: unknown;
}

interface EventArg {
  name?: string;
  value: string | number | boolean;
  role?: 'flag' | 'eventId' | 'entityId' | 'regionId' | 'paramId' | 'textId' | 'unknown';
  confidence?: ReferenceConfidence;
}
```

## 8. Map export model

Minimum map export:

```ts
interface MapExport {
  mapId: string;
  entities: MapEntitySymbol[];
  regions: MapRegionSymbol[];
}

interface MapEntitySymbol {
  uri: string;
  entityId?: number;
  name: string;
  kind: 'character' | 'object' | 'asset' | 'collision' | 'mapPiece' | 'unknown';
  model?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  raw?: unknown;
}

interface MapRegionSymbol {
  uri: string;
  entityId?: number;
  name: string;
  shape?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  size?: unknown;
  raw?: unknown;
}
```

## 9. Param export model

```ts
interface ParamExport {
  paramName: string;
  rows: ParamRowSymbol[];
}

interface ParamRowSymbol {
  uri: string;
  paramName: string;
  rowId: number;
  rowName?: string;
  fields?: ParamFieldSymbol[];
  raw?: unknown;
}

interface ParamFieldSymbol {
  name: string;
  type?: string;
  value: string | number | boolean | null;
}
```

## 10. Msg export model

```ts
interface MsgExport {
  category?: string;
  entries: TextEntrySymbol[];
}

interface TextEntrySymbol {
  uri: string;
  category?: string;
  textId: number;
  text: string;
}
```

## 11. Reference model

References are first-class data.

```ts
type ReferenceConfidence = 'high' | 'medium' | 'low';

interface ReferenceEdge {
  fromUri: string;
  toUri: string;
  kind:
    | 'calls_event'
    | 'reads_flag'
    | 'writes_flag'
    | 'references_map_entity'
    | 'references_region'
    | 'references_param_row'
    | 'references_text'
    | 'numeric_match'
    | 'unknown';
  confidence: ReferenceConfidence;
  reason: string;
  evidence: ReferenceEvidence[];
}

interface ReferenceEvidence {
  sourceUri: string;
  excerpt?: string;
  instructionUri?: string;
  fieldName?: string;
  value?: string | number | boolean;
}
```

High confidence is allowed only when the parser or instruction semantics identify the value role.

Medium/low confidence can be used for numeric cross-resource matches, but AI explanations must label them as uncertain.

## 12. SQLite logical schema

Suggested tables:

```text
workspaces
files
event_symbols
event_instructions
map_entities
map_regions
param_rows
param_fields
text_entries
reference_edges
diagnostics
operation_logs
```

FTS tables:

```text
files_fts
text_entries_fts
event_text_fts
param_rows_fts
```

## 13. Event explanation logic

`explain_event(uri)` should not be a free-form hallucination endpoint.

Pipeline:

```text
open event symbol
  -> collect instructions
  -> collect high-confidence references
  -> collect medium/low-confidence references separately
  -> collect diagnostics
  -> generate structured explanation input
  -> AI or template produces explanation with evidence labels
```

The explanation should separate:

- Confirmed facts.
- Likely interpretations.
- Unknowns.
- Diagnostics.

## 14. Patch Engine logic

The Patch Engine is the only module allowed to save mod resource changes.

Patch object:

```ts
interface PatchProposal {
  opId: string;
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: 'plan' | 'normal' | 'fullPermission';
  changes: PatchChange[];
  createdAt: string;
}

interface PatchChange {
  targetUri: string;
  targetPath: string;
  kind: 'text' | 'binary' | 'structured';
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  structuredEdit?: unknown;
}
```

Save pipeline:

```text
create staging area
copy target files into staging
apply patch to staging
run validators on staging
if validation passes, backup originals
atomic replace originals
re-parse changed resources
update index
write operation log
```

Original files must remain untouched until validation passes.

## 15. Validation logic

Validators are pluggable but not a full plugin system yet.

v0.1 validators:

- File exists and is readable.
- Bridge inspect succeeds or returns no worse diagnostics than before.
- Deep export succeeds for supported resources.
- Staged output is not empty unless intentionally allowed.
- Resource kind does not unexpectedly change.

Validation result:

```ts
interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  retryable: boolean;
}
```

## 16. AI tool registry

AI tools must call SoulForge services, not raw filesystem operations.

Initial tools:

```text
search_resources
open_resource
list_events
open_event
find_references
open_map_entity
open_param_row
open_text
explain_event
propose_patch
validate_patch
```

`apply_patch` exists only behind explicit mode checks and still uses the Patch Engine.

## 17. Full-permission mode

Full-permission mode is not raw filesystem permission.

It means:

- AI may run approved tools without asking after every step.
- AI may propose and validate patches automatically.
- AI may apply patches only through Patch Engine.
- AI may retry failed staged patches within a small retry limit.
- AI must stop after repeated validation failures.

## 18. Resource usage policy

The core logic must support low-resource behavior:

- Lazy hash.
- Lazy parse.
- Background job queue.
- Cancellation token for long jobs.
- Process timeout for bridge calls.
- Virtualized UI lists.
- No large binary buffers in React state.
- No all-project embeddings in v0.1.

## 19. Final principle

SoulForge should feel like this:

```text
Stop modding in the dark.
```

It should replace the old workflow:

```text
unpack -> Notepad -> guess ID -> repack -> launch game -> pray
```

with:

```text
open workspace -> inspect evidence -> understand references -> validate change -> save safely -> rollback if needed
```