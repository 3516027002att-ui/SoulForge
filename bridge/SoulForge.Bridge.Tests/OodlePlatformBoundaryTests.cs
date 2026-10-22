using Xunit;

public sealed class OodlePlatformBoundaryTests
{
    [NonWindowsFact]
    public void WindowsGameRuntimeIsUnavailableOnOtherHostsBeforeFileOrLibraryAccess()
    {
        using var result = OodleRuntimeLocator.Open("a-root-that-does-not-exist", "fixture://krak");
        Assert.Null(result.Session);
        Assert.Equal("platform-unavailable", result.Info.Status);
        Assert.Equal("none", result.Info.Capability);
        Assert.Contains(result.Diagnostics, item => item.Code == "OODLE_PLATFORM_PROVIDER_UNAVAILABLE");
    }

    [NonWindowsFact]
    public void DoctorDoesNotOfferOrPerformWindowsLibraryCopyOnOtherHosts()
    {
        var item = SoulForge.Doctor.OodleDoctor.Inspect(null, null);
        Assert.False(item.Fixable);
        Assert.Equal(SoulForge.Doctor.DoctorStatus.Warn, item.Status);
        var root = Path.Combine(Path.GetTempPath(), "sf-doctor-platform-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "oo2core_6_win64.dll"), "fixture bytes, never loaded");
            var destination = Path.Combine(root, "destination");
            Assert.False(SoulForge.Doctor.OodleDoctor.CopyOodle(root, destination));
            Assert.False(Directory.Exists(destination));
        }
        finally { Directory.Delete(root, true); }
    }
}

public sealed class NonWindowsFactAttribute : FactAttribute
{
    public NonWindowsFactAttribute()
    {
        if (OperatingSystem.IsWindows()) Skip = "The Windows game-library rejection applies to non-Windows hosts.";
    }
}
