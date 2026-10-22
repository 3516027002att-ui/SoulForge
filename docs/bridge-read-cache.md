# Bridge infrastructure and oversized read transport

`bridge/commands.json` is the command authority. Run `npm run bridge:commands:generate`
after changing it, and `npm run bridge:commands:check` to verify the generated C#
and TypeScript projections. The daemon reaches the actual service branches during
startup verification; `npm run test:bridge-csharp` also includes a descriptor with
no handler to prove that this verification can fail.

The retained diagnostic/manual commands have these purposes:

- `validate`: inspect a resource and request its native validation diagnostics
- `probe-oodle`: diagnose the configured local decompression runtime
- `inspect-luabnd`: inspect script-container metadata without extraction
- `export-tpf-texture`: export a texture into host-controlled staging
- `export-luabnd`: extract scripts into host-controlled staging

All disk commands require the host's canonical `outputPath`, already checked
against negotiated writable roots. Standalone CLI JSON cannot grant write access
through `outputPath` or `outputDirectory`; the daemon or a trusted host supplies
staging. Diagnostic semantic exports that return JSON do not write files.

## Oversized containers

The 64 MiB native read limit remains in place. DCX and BND containers above that
limit use an optional imported WitchyBND installation for basic, unpack-only
transport. Set `SOULFORGE_LARGE_RESOURCE_UNPACKER` to an absolute executable path
and `SOULFORGE_READ_CACHE_ROOT` to a local cache directory outside game/Mod read
roots. SoulForge does not download, link, or redistribute the tool.

The adapter requests unpack-only, basic BND, passive, single-threaded processing.
Effective WitchyBND settings must disable recursive conversion, DCX-only
conversion and deferred tools. The tool's executable, adjacent runtime libraries,
settings and adapter configuration are included in its identity. Changing source
bytes or this identity selects a new cache. The adapter never passes the original
container as the tool's input: it creates an independent disk snapshot first.

Completed cache publication is atomic. Source changes, tool/config changes,
cancellation, bad XML, links, traversal, duplicate physical aliases or disk-budget
violations leave no accepted partial cache. Hashing and copy/read operations
observe cancellation. The unpack process has a five-minute deadline and bounded
stdout/stderr tails; disk output is checked while it runs. Source snapshots are
limited to 2 GiB, unpack output to 8 GiB and 100,000 filesystem objects, XML/JSON
manifests to 4 MiB, and each native leaf read to 64 MiB.

Container listings keep the existing `index`, `id`, `name`, `uncompressedSize`
fields. Leaf snapshots, extraction receipts and FXR documents also carry original
`sourceUri`, `sourcePath`, physical entry identity and `sourceContainerHash`.
Cached files are checked against their recorded hash before native parsing. The
cache only transports extracted native leaves. Bridge remains their parser.

Results say `readOnly: true` and `containerWriteSupported: false`. They do not
claim that extracted bytes equal the original stored compressed entry or that
outer-container roundtrip/repack was verified. Oversized writer calls are rejected
with `LARGE_RESOURCE_REPACK_UNSUPPORTED`. Repack plus Patch Engine writeback needs
a separate verified design and issue.

WitchyBND's upstream declares GPL-3.0 and documents Windows execution. See its
[license](https://github.com/ividyon/WitchyBND/blob/main/LICENSE),
[configuration/CLI](https://github.com/ividyon/WitchyBND/blob/main/WitchyBND/Configuration.cs),
and [basic BND manifest implementation](https://github.com/ividyon/WitchyBND/blob/main/WitchyBND/Parsers/WBinderParser.cs).
An optional local installation remains a separate program under its own terms;
this decision does not grant redistribution rights. A Windows executable is
reported unsupported on Linux. Linux KRAK decompression still requires a compatible,
authorized native runtime/tool; a game's Windows DLL is not a Linux SDK/license.

## Verification limits

Synthetic C# checks cover cache invalidation, failed/cancelled publication,
metadata/hash/path integrity, disk budgets, DTO compatibility and platform errors.
They do not substitute for the four real oversized-resource suites from issue
#43 on the user's imported tool. Missing tools and unsupported platforms return
structured diagnostics, and never become a successful native validation report.

Doctor targets .NET 10 with self-contained single-file publishing. A Linux
self-contained diagnostic run proves that target works on Linux; it does not prove
that a Windows executable runs on a Windows machine without .NET installed.
