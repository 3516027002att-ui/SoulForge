using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace SoulForge.Doctor;

public sealed class OllamaTagResponse
{
    [JsonPropertyName("models")]
    public List<OllamaModelEntry>? Models { get; set; }
}

public sealed class OllamaModelEntry
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("size")]
    public long Size { get; set; }
}

public static class AiDoctor
{
    public static async Task<DoctorItem> InspectAsync()
    {
        var item = new DoctorItem
        {
            Key = "ai_service",
            Title = "AI 模型服务 (Ollama 本地大模型 / DeepSeek)",
            Fixable = false
        };

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
            var response = await client.GetAsync("http://127.0.0.1:11434/api/tags");
            if (response.IsSuccessStatusCode)
            {
                var data = await response.Content.ReadFromJsonAsync<OllamaTagResponse>();
                var modelNames = data?.Models?.Select(m => m.Name).ToList() ?? new List<string>();

                if (modelNames.Count > 0)
                {
                    item.Status = DoctorStatus.Pass;
                    item.Message = $"本地 Ollama 服务正常运行中，发现 {modelNames.Count} 个可用模型: {string.Join(", ", modelNames.Take(3))}";
                    item.Details = new { provider = "ollama", url = "http://127.0.0.1:11434", models = modelNames };
                    return item;
                }
                else
                {
                    item.Status = DoctorStatus.Pass;
                    item.Message = "本地 Ollama 正在运行，但尚未下载模型 (例如可执行 ollama run deepseek-r1:8b)";
                    item.Details = new { provider = "ollama", url = "http://127.0.0.1:11434", models = Array.Empty<string>() };
                    return item;
                }
            }
        }
        catch
        {
            // 本地未启动 Ollama
        }

        item.Status = DoctorStatus.Pass;
        item.Message = "未检测到本地 Ollama 服务 (可选)；SoulForge 也支持直接配置 DeepSeek / OpenAI API Key。";
        item.Details = new { provider = "cloud_or_none" };
        return item;
    }
}
