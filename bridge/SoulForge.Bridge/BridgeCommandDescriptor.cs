/// <summary>
/// The daemon's command description source. A descriptor is both the public
/// capability projection and the admission record used before BridgeCommandService
/// is called. Keeping the handler binding here makes an advertised command,
/// a dispatchable command and a disk-writing command one auditable projection.
/// </summary>
internal sealed class BridgeCommandDescriptor
{
    public required string Name { get; init; }
    public required string Effect { get; init; }
    public required bool Advertised { get; init; }
    public required IReadOnlyList<string> RequiredInputFields { get; init; }
    public required bool RequiresOutputPath { get; init; }
    public required string CostClass { get; init; }
    public required string CancelMode { get; init; }
    public required string Handler { get; init; }

    public bool IsServiceDispatch => string.Equals(
        Handler,
        "BridgeCommandService.ExecuteAsync",
        StringComparison.Ordinal);
}

internal static class BridgeCommandDescriptorCatalog
{
    private const string ServiceHandler = "BridgeCommandService.ExecuteAsync";
    private const string ArtifactHandler = "BridgeDaemonHost.DaemonState.ReadArtifactAsync";

    private static readonly IReadOnlyList<BridgeCommandDescriptor> Definitions =
        new[]
        {
            Read("inspect", "interactive"),
            Read("validate", "interactive"),
            Read("probe-oodle", "interactive"),
            Read("probe-document-locator", "interactive"),
            Read("read-dcx-document", "foreground"),
            Read("list-bnd4-entries", "foreground"),
            Read("snapshot-bnd4-child", "foreground"),
            Export("extract-bnd4-child", "foreground", requiresOutputPath: true),
            Write("write-bnd4", "foreground"),
            Read("inventory-asset-resources", "background"),
            Read("read-fmg-document", "foreground"),
            Write("write-fmg", "foreground"),
            Read("read-param-document", "background"),
            Write("write-param", "foreground"),
            Read("read-gparam-document", "background"),
            Write("write-gparam", "foreground"),
            Read("read-text-catalog", "foreground"),
            Read("read-emevd-document", "background"),
            Write("write-emevd", "foreground"),
            Read("read-msb-document", "background"),
            Write("write-msb", "foreground"),
            Read("read-tpf-document", "foreground"),
            Export("export-tpf-texture", "foreground", requiresOutputPath: true),
            Read("read-tpf-texture-preview", "interactive"),
            Write("write-tpf-texture-replace", "foreground"),
            Read("read-tae-document", "background"),
            Read("read-tae-event-params", "interactive"),
            Read("read-tae-animation-clip", "foreground"),
            Read("sample-tae-animation-pose", "interactive"),
            new BridgeCommandDescriptor
            {
                 Name = "read-bridge-artifact",
                 Effect = "read",
                 Advertised = true,
                RequiredInputFields = new[] { "command", "filePath", "options.artifactToken", "options.offset", "options.length" },
                RequiresOutputPath = false,
                CostClass = "interactive",
                CancelMode = "cooperative",
                Handler = ArtifactHandler
            },
            Read("read-chrbnd-flver-preview", "foreground"),
            Read("read-map-part-flver-preview", "foreground"),
            Read("read-map-static-geometry", "background"),
            Read("read-flver-document", "foreground"),
            Write("write-flver", "foreground"),
            Read("read-flver-mesh", "foreground"),
            Read("read-flver-skeleton", "foreground"),
            Read("read-flver-texture-slots", "foreground"),
            Read("read-flver-dummies", "foreground"),
            Read("read-esd-document", "foreground"),
            Write("write-esd-document", "foreground"),
            Write("write-tae-document", "foreground"),
            Write("write-fxr-document", "foreground"),
            Read("read-mtd-document", "foreground"),
            Write("write-mtd-document", "foreground"),
            Read("read-fxr-document", "foreground"),
            Read("list-ffxbnd-entries", "foreground"),
            Read("read-luabnd-document", "foreground"),
            Read("inspect-luabnd", "interactive"),
            Read("read-luabnd-script", "foreground"),
            Read("read-hks-source", "foreground"),
            Read("compile-hks-source", "foreground"),
            Write("write-luabnd-script", "foreground"),
            Export("export-luabnd", "background", requiresOutputPath: true),
            Export("export-event", "background"),
            Export("export-map", "background"),
            Export("export-param", "background"),
            Export("export-msg", "background")
        };

    private static readonly IReadOnlyDictionary<string, BridgeCommandDescriptor> ByName =
        Definitions.ToDictionary(item => item.Name, StringComparer.OrdinalIgnoreCase);

    public static IReadOnlyList<BridgeCommandDescriptor> All => Definitions;

    public static IReadOnlyList<BridgeCommandDescriptor> AdvertisedDescriptors { get; } =
        Definitions.Where(item => item.Advertised).ToArray();

    public static string[] AdvertisedCommands { get; } =
        AdvertisedDescriptors.Select(item => item.Name).ToArray();

    public static IReadOnlySet<string> DispatchCommands { get; } =
        new HashSet<string>(Definitions.Select(item => item.Name), StringComparer.OrdinalIgnoreCase);

    public static IReadOnlySet<string> DiskWritingCommands { get; } =
        new HashSet<string>(
            Definitions.Where(item => item.RequiresOutputPath).Select(item => item.Name),
            StringComparer.OrdinalIgnoreCase);

    public static bool TryGet(string command, out BridgeCommandDescriptor descriptor) =>
        ByName.TryGetValue(command.Trim(), out descriptor!);

    public static void Verify()
    {
        if (Definitions.Count == 0 || ByName.Count != Definitions.Count)
            throw new InvalidOperationException("BRIDGE_COMMAND_DESCRIPTOR_REGISTRY_INVALID: command names must be non-empty and unique.");

        foreach (var descriptor in Definitions)
        {
            if (string.IsNullOrWhiteSpace(descriptor.Name)
                || string.IsNullOrWhiteSpace(descriptor.Handler)
                || descriptor.RequiredInputFields.Count == 0)
            {
                throw new InvalidOperationException($"BRIDGE_COMMAND_DESCRIPTOR_INVALID: {descriptor.Name}");
            }
            if (descriptor.RequiresOutputPath && descriptor.Effect is not ("write" or "export"))
            {
                throw new InvalidOperationException(
                    $"BRIDGE_COMMAND_DESCRIPTOR_OUTPUT_EFFECT_INVALID: {descriptor.Name}");
            }
            if (descriptor.IsServiceDispatch is false && !string.Equals(descriptor.Handler, ArtifactHandler, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"BRIDGE_COMMAND_DESCRIPTOR_HANDLER_UNKNOWN: {descriptor.Name} -> {descriptor.Handler}");
            }
        }

        var advertised = AdvertisedDescriptors.Select(item => item.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!advertised.SetEquals(AdvertisedCommands))
            throw new InvalidOperationException("BRIDGE_COMMAND_DESCRIPTOR_ADVERTISEMENT_DRIFT");

        var diskWriting = Definitions
            .Where(item => item.RequiresOutputPath)
            .Select(item => item.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!diskWriting.SetEquals(DiskWritingCommands))
            throw new InvalidOperationException("BRIDGE_COMMAND_DESCRIPTOR_DISK_WRITE_DRIFT");
    }

    private static BridgeCommandDescriptor Read(string name, string costClass) =>
        Create(name, "read", costClass, requiresOutputPath: false);

    private static BridgeCommandDescriptor Write(string name, string costClass) =>
        Create(name, "write", costClass, requiresOutputPath: true);

    private static BridgeCommandDescriptor Export(
        string name,
        string costClass,
        bool requiresOutputPath = false) =>
        Create(name, "export", costClass, requiresOutputPath);

    private static BridgeCommandDescriptor Create(
        string name,
        string effect,
        string costClass,
        bool requiresOutputPath) => new()
        {
            Name = name,
            Effect = effect,
            Advertised = true,
            RequiredInputFields = requiresOutputPath
                ? new[] { "command", "filePath", "options.outputPath" }
                : new[] { "command", "filePath" },
            RequiresOutputPath = requiresOutputPath,
            CostClass = costClass,
            CancelMode = "cooperative",
            Handler = ServiceHandler
        };
}
