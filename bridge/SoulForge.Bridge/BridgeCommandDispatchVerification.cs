internal static class BridgeCommandDispatchVerification
{
    internal static async Task VerifyAsync(IEnumerable<BridgeCommandDescriptor> descriptors)
    {
        var service = new BridgeCommandService();
        foreach (var descriptor in descriptors)
        {
            var result = descriptor.IsServiceDispatch
                ? await service.ProbeDispatchAsync(descriptor.Name)
                : await BridgeDaemonHost.ProbeArtifactDispatchAsync(descriptor.Name);
            var expected = descriptor.IsServiceDispatch ? "BRIDGE_COMMAND_DISPATCH_BOUND" : "BRIDGE_ARTIFACT_REQUEST_INVALID";
            if (!result.Diagnostics.Any(diagnostic => diagnostic.Code == expected))
                throw new InvalidOperationException($"BRIDGE_COMMAND_DISPATCH_REGISTRY_INCOMPLETE: {descriptor.Name}");
        }
    }
}
