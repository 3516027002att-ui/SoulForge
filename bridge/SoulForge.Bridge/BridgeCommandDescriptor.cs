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

    private static readonly IReadOnlyList<BridgeCommandDescriptor> Definitions = BridgeCommandDefinitions.All;

    private static readonly IReadOnlyDictionary<string, BridgeCommandDescriptor> ByName =
        Definitions.ToDictionary(item => item.Name, StringComparer.OrdinalIgnoreCase);

    public static IReadOnlyList<BridgeCommandDescriptor> All => Definitions;

    public static IReadOnlyList<BridgeCommandDescriptor> AdvertisedDescriptors { get; } =
        Definitions.Where(item => item.Advertised).ToArray();

    public static string[] AdvertisedCommands { get; } =
        AdvertisedDescriptors.Select(item => item.Name).ToArray();

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

}
