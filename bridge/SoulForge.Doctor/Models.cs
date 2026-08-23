using System.Text.Json.Serialization;

namespace SoulForge.Doctor;

public enum DoctorStatus
{
    Pass,
    Warn,
    Fail
}

public sealed class DoctorItem
{
    [JsonPropertyName("key")]
    public string Key { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public DoctorStatus Status { get; set; } = DoctorStatus.Pass;

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("details")]
    public object? Details { get; set; }

    [JsonPropertyName("fixable")]
    public bool Fixable { get; set; }

    [JsonPropertyName("fixDescription")]
    public string? FixDescription { get; set; }
}

public sealed class DoctorReport
{
    [JsonPropertyName("timestamp")]
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;

    [JsonPropertyName("overallStatus")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public DoctorStatus OverallStatus { get; set; } = DoctorStatus.Pass;

    [JsonPropertyName("detectedSekiroPath")]
    public string? DetectedSekiroPath { get; set; }

    [JsonPropertyName("detectedModsPath")]
    public string? DetectedModsPath { get; set; }

    [JsonPropertyName("items")]
    public List<DoctorItem> Items { get; set; } = new();
}

public sealed class AutoFixActionRecord
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;
}

public sealed class AutoFixResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("actions")]
    public List<AutoFixActionRecord> Actions { get; set; } = new();

    [JsonPropertyName("sekiroPath")]
    public string? SekiroPath { get; set; }

    [JsonPropertyName("modsPath")]
    public string? ModsPath { get; set; }
}
