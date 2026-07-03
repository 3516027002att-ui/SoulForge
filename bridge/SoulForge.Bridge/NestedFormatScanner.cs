static class NestedFormatScanner
{
    private const int MaxNestedEvidence = 100;

    private static readonly NestedMagicRule[] Rules =
    {
        new("DCX", new byte[] { (byte)'D', (byte)'C', (byte)'X', 0 }),
        new("BND3", new byte[] { (byte)'B', (byte)'N', (byte)'D', (byte)'3' }),
        new("BND4", new byte[] { (byte)'B', (byte)'N', (byte)'D', (byte)'4' }),
        new("EMEVD", new byte[] { (byte)'E', (byte)'V', (byte)'D', 0 }),
        new("FMG", new byte[] { (byte)'F', (byte)'M', (byte)'G', 0 }),
        new("PARAM", new byte[] { (byte)'P', (byte)'A', (byte)'R', (byte)'A' }),
        new("MSB", new byte[] { (byte)'M', (byte)'S', (byte)'B', 0 })
    };

    public static IReadOnlyList<FormatEvidence> Scan(byte[] sample)
    {
        var evidence = new List<FormatEvidence>();
        for (var offset = 1; offset < sample.Length && evidence.Count < MaxNestedEvidence; offset += 1)
        {
            foreach (var rule in Rules)
            {
                if (!StartsWith(sample, offset, rule.Magic)) continue;
                evidence.Add(new FormatEvidence(
                    "nestedMagicCandidate",
                    offset,
                    new
                    {
                        rootFormat = rule.RootFormat,
                        hex = ToHex(sample, offset, rule.Magic.Length),
                        ascii = ToAscii(sample, offset, rule.Magic.Length),
                        source = "bounded-prefix-scan"
                    },
                    "low"));
                break;
            }
        }

        return evidence;
    }

    private static bool StartsWith(byte[] sample, int offset, byte[] magic)
    {
        if (offset < 0 || offset + magic.Length > sample.Length) return false;
        for (var index = 0; index < magic.Length; index += 1)
        {
            if (sample[offset + index] != magic[index]) return false;
        }
        return true;
    }

    private static string ToHex(byte[] sample, int offset, int count)
    {
        return string.Join(" ", sample.Skip(offset).Take(count).Select(value => value.ToString("X2")));
    }

    private static string ToAscii(byte[] sample, int offset, int count)
    {
        return new string(sample.Skip(offset).Take(count).Select(value => value >= 32 && value <= 126 ? (char)value : '.').ToArray());
    }

    private sealed record NestedMagicRule(string RootFormat, byte[] Magic);
}
