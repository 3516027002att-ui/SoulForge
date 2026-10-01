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
}

public sealed class NonWindowsFactAttribute : FactAttribute
{
    public NonWindowsFactAttribute()
    {
        if (OperatingSystem.IsWindows()) Skip = "The Windows game-library rejection applies to non-Windows hosts.";
    }
}
