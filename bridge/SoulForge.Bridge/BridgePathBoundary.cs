internal static class BridgePathBoundary
{
    public static BridgePathBoundaryResult Verify(string candidatePath, IReadOnlyList<string> allowedRoots)
    {
        if (string.IsNullOrWhiteSpace(candidatePath) || !Path.IsPathFullyQualified(candidatePath))
        {
            return BridgePathBoundaryResult.Failed("BRIDGE_PATH_INVALID", "Bridge filePath must be an absolute path.");
        }

        var lexicalCandidate = Path.GetFullPath(candidatePath);
        foreach (var configuredRoot in allowedRoots)
        {
            var lexicalRoot = Path.GetFullPath(configuredRoot);
            if (!IsInside(lexicalRoot, lexicalCandidate)) continue;

            var physicalRoot = ResolveExistingPath(lexicalRoot);
            var relative = Path.GetRelativePath(lexicalRoot, lexicalCandidate);
            var current = lexicalRoot;
            var escaped = false;

            foreach (var segment in relative.Split(
                new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.GetFullPath(Path.Combine(current, segment));
                if (!File.Exists(current) && !Directory.Exists(current)) break;
                var physicalCurrent = ResolveExistingPath(current);
                if (IsInside(physicalRoot, physicalCurrent)) continue;
                escaped = true;
                break;
            }

            if (!escaped)
            {
                return new BridgePathBoundaryResult(true, lexicalCandidate, string.Empty, string.Empty);
            }
            return BridgePathBoundaryResult.Failed(
                "BRIDGE_REPARSE_POINT_ESCAPE",
                "Bridge request path crosses a link or junction outside the allowed roots.");
        }

        return BridgePathBoundaryResult.Failed(
            "BRIDGE_PATH_OUTSIDE_ALLOWED_ROOTS",
            "Bridge request path is outside the negotiated allowed roots.");
    }

    public static string ResolveExistingPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        FileSystemInfo info = Directory.Exists(fullPath)
            ? new DirectoryInfo(fullPath)
            : new FileInfo(fullPath);
        if (!info.Exists) return fullPath;
        var target = info.ResolveLinkTarget(returnFinalTarget: true);
        return Path.GetFullPath(target?.FullName ?? info.FullName);
    }

    private static bool IsInside(string root, string candidate)
    {
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(candidate));
        return relative == "."
            || (!relative.Equals("..", comparison)
                && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", comparison)
                && !Path.IsPathFullyQualified(relative));
    }
}

internal sealed record BridgePathBoundaryResult(
    bool Ok,
    string CanonicalPath,
    string Code,
    string Message)
{
    public static BridgePathBoundaryResult Failed(string code, string message) =>
        new(false, string.Empty, code, message);
}
