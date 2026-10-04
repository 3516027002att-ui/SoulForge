// Explicit acceptance-only reader. Compile against an owner-supplied, hash-bound
// SoulsFormatsNEXT assembly; never referenced by a production package.
using SoulsFormats;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
if (args.Length != 3) throw new ArgumentException("DOMAIN SOURCE OUTPUT_JSON");
var bytes = File.ReadAllBytes(args[1]);
if (bytes.Length > 64 * 1024 * 1024) throw new InvalidDataException("Input limit");
if (bytes.AsSpan(0, 4).SequenceEqual("DCX\0"u8) && !bytes.AsSpan(0x28, 4).SequenceEqual("DFLT"u8))
    throw new NotSupportedException("This independent oracle accepts DFLT only, not vendor codecs");
var raw = DCX.Is(bytes) ? DCX.Decompress(bytes) : bytes;
if (raw.Length > 64 * 1024 * 1024) throw new InvalidDataException("Decoded limit");
object target;
object preserved;
if (args[0] == "emevd") {
    var doc = EMEVD.Read(raw);
    var item = doc.Events.Single(e => e.ID == 952787);
    target = new { eventId = item.ID, value = (uint)item.RestBehavior };
    preserved = new { doc.Format, doc.LinkedFileOffsets, strings = Hash(doc.StringData),
        events = doc.Events.Select(e => new { e.ID, rest = e.ID == item.ID ? 0 : (uint)e.RestBehavior,
            instructions = e.Instructions.Select(i => new { i.Bank, i.ID, args = Hash(i.ArgData), i.Layer }),
            parameters = e.Parameters.Select(p => new { p.InstructionIndex, p.TargetStartByte, p.SourceStartByte, p.ByteCount, p.UnkID }) }) };
} else {
    var bnd = BND4.Read(raw);
    BinderFile selected;
    object contents;
    if (args[0] == "param") {
        selected = bnd.Files.Single(f => Stem(f.Name) == "NpcParam");
        var doc = PARAM.Read(selected.Bytes);
        var row = doc.Rows.Single(r => r.ID == 50800000);
        var offset = (long)typeof(PARAM.Row).GetField("DataOffset", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(row)!;
        // Literal acceptance contract: NpcParam s8 ninsatuNum is byte 294.
        // Offset knowledge is shared with the schema, not independently discovered.
        var at = checked((int)offset + 294);
        target = new { table = "NpcParam", rowId = row.ID, fieldId = "ninsatuNum", value = (sbyte)selected.Bytes[at], byteOffset = at,
            expectationScope = "independent PARAM row reader plus explicit shared-schema byte offset; not independent schema discovery" };
        var masked = (byte[])selected.Bytes.Clone(); masked[at] = 0;
        contents = new { maskedBytes = Hash(masked), rowCount = doc.Rows.Count };
    } else if (args[0] == "fmg") {
        selected = bnd.Files.First(f => f.Name.EndsWith(".fmg", StringComparison.OrdinalIgnoreCase) && FMG.Read(f.Bytes).Entries.Any(e => !string.IsNullOrEmpty(e.Text)));
        var doc = FMG.Read(selected.Bytes);
        var item = doc.Entries.First(e => !string.IsNullOrEmpty(e.Text));
        target = new { table = Stem(selected.Name), id = item.ID, value = item.Text };
        contents = doc.Entries.Select(e => new { e.ID, text = e.ID == item.ID ? "<target>" : e.Text }).ToArray();
    } else if (args[0] == "tae") {
        selected = bnd.Files.Single(f => Stem(f.Name) == "a50");
        var doc = TAE.Read(selected.Bytes);
        var anim = doc.Animations.Single(a => a.ID == 2010);
        var item = anim.Events[0];
        target = new { section = "a50", animId = anim.ID, eventIndex = 0, eventType = item.Type, value = item.StartTime * 30, endFrame = item.EndTime * 30 };
        contents = doc.Animations.Select(a => new { a.ID, a.AnimFileName,
            miniHeader = JsonSerializer.SerializeToElement(a.MiniHeader, a.MiniHeader.GetType()),
            events = a.Events.Select((e, index) => new { e.Type, start = a.ID == anim.ID && index == 0 ? 0 : e.StartTime,
                e.EndTime, parameters = Hash(e.GetParameterBytes(false)) }) }).ToArray();
    } else throw new NotSupportedException(args[0]);
    preserved = new { bnd.Version, bnd.Format, bnd.BigEndian, bnd.Unicode, contents,
        entries = bnd.Files.Select(f => new { f.ID, f.Name, f.Flags, bytes = ReferenceEquals(f, selected) ? "<target>" : Hash(f.Bytes) }) };
}
var output = new { schema = "refactor-acceptance-oracle-v1", domain = args[0], sourceSha256 = Hash(bytes), byteLength = bytes.Length,
    oracleAssemblySha256 = Hash(File.ReadAllBytes(typeof(TAE).Assembly.Location)),
    queryAssemblySha256 = Hash(File.ReadAllBytes(Assembly.GetExecutingAssembly().Location)),
    target, preservedSha256 = Hash(JsonSerializer.SerializeToUtf8Bytes(preserved)) };
File.WriteAllText(args[2], JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(output));
static string Hash(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
static string Stem(string path) => Path.GetFileNameWithoutExtension(path.Replace('\\', '/'));
