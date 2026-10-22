using System.Buffers.Binary;
using System.Collections;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

// Validation executable only. Every reported route value comes from the
// retained native product record, after bounded original DFLT decoding.
internal static class Program
{
    private const int MaxBytes = 64 * 1024 * 1024;
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static object Get(object value, string name) =>
        value.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.GetValue(value)
        ?? throw new InvalidDataException($"Decoded property {value.GetType().Name}.{name} unavailable.");
    private static int Int(object value, string name) => Convert.ToInt32(Get(value, name));

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 4 || !Path.IsPathFullyQualified(args[0]) || !Path.IsPathFullyQualified(args[1]))
                throw new ArgumentException("Usage: MSBRouteInternalFields <product-dll> <owned-msb.dcx> <original-sha256> <decoded-sha256>");
            if (new FileInfo(args[1]).Length > MaxBytes) throw new InvalidDataException("Original exceeds 64 MiB.");
            var productBytes = File.ReadAllBytes(args[0]);
            var original = File.ReadAllBytes(args[1]);
            if (Hash(original) != args[2]) throw new InvalidDataException("Original SHA mismatch.");
            if (original.Length < 0x4c || !original.AsSpan(0, 4).SequenceEqual("DCX\0"u8) || !original.AsSpan(0x28, 4).SequenceEqual("DFLT"u8))
                throw new InvalidDataException("Only owned DFLT MSB originals are permitted.");
            var expectedLength = BinaryPrimitives.ReadUInt32BigEndian(original.AsSpan(0x1c, 4));
            if (expectedLength > MaxBytes) throw new InvalidDataException("Decoded header exceeds 64 MiB.");
            using var compressed = new MemoryStream(original, 0x4c, original.Length - 0x4c, writable: false);
            using var inflater = new ZLibStream(compressed, CompressionMode.Decompress);
            using var decodedStream = new MemoryStream();
            var buffer = new byte[8192];
            int count;
            while ((count = inflater.Read(buffer)) != 0)
            {
                if (decodedStream.Length + count > expectedLength || decodedStream.Length + count > MaxBytes)
                    throw new InvalidDataException("Decoded stream exceeds bounded expected length.");
                decodedStream.Write(buffer, 0, count);
            }
            var decoded = decodedStream.ToArray();
            if (decoded.Length != expectedLength || Hash(decoded) != args[3]) throw new InvalidDataException("Decoded original identity mismatch.");
            var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(args[0]);
            var nativeType = assembly.GetType("MsbNativeDocument", throwOnError: true)!;
            var read = nativeType.GetMethod("Read", BindingFlags.Public | BindingFlags.Static, new[] { typeof(byte[]) })
                ?? throw new InvalidDataException("Native MSB Read method unavailable.");
            var document = read.Invoke(null, new object[] { decoded })!;
            var routes = ((IEnumerable)Get(document, "Routes")).Cast<object>().Select((route, ordinal) => new
            {
                ordinal, offset = Int(route, "Offset"), name = Get(route, "Name").ToString(),
                typeId = Int(route, "TypeId"), id = Int(route, "Id"), unk08 = Int(route, "Unk08"), unk0C = Int(route, "Unk0C")
            }).ToArray();
            if (routes.Length > 100000) throw new InvalidDataException("Route table exceeds bound.");
            if (Hash(File.ReadAllBytes(args[1])) != args[2] || Hash(File.ReadAllBytes(args[0])) != Hash(productBytes))
                throw new InvalidDataException("Original or product changed during reflection.");
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schema = "soulforge.msb-route-internal-observations.v1", producerAssemblySha256 = Hash(productBytes),
                originalSource = new { path = args[1], sha256 = Hash(original), byteLength = original.Length },
                decodedSource = new { sha256 = Hash(decoded), byteLength = decoded.Length },
                routeCount = routes.Length, routes
            }));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
    }
}
