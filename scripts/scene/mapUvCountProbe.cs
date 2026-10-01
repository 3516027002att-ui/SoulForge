// Validation only: call the actual compiled getter without reflection per call.
using System.Diagnostics;
using System.Reflection;
using System.Reflection.Emit;
using System.Security.Cryptography;
using System.Text.Json;

var producer = Path.GetFullPath(args[0]);
var input = Path.GetFullPath(args[1]);
var expected = int.Parse(args[2]);
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
var producerHash = Hash(File.ReadAllBytes(producer));
var source = File.ReadAllBytes(input);
var assembly = Assembly.LoadFrom(producer);
var type = assembly.GetType("FlverNativeDocument", true)!;
var document = type.GetMethod("Read", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, new object[] { source })!;
var descriptor = type.GetMethod("GetMeshGeometryDescriptor", BindingFlags.NonPublic | BindingFlags.Instance)!
    .Invoke(document, new object[] { 0 })!;
var getter = descriptor.GetType().GetProperty("UvSetCount", BindingFlags.NonPublic | BindingFlags.Instance)!.GetMethod!;
var invoke = new DynamicMethod("ReadActualUvCount", typeof(int), new[] { typeof(object) }, typeof(Program).Module, true);
var il = invoke.GetILGenerator();
il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Castclass, descriptor.GetType()); il.Emit(OpCodes.Call, getter); il.Emit(OpCodes.Ret);
var count = (Func<object, int>)invoke.CreateDelegate(typeof(Func<object, int>));
for (var i = 0; i < 1000; i++) if (count(descriptor) != expected) throw new Exception("UV_SET_COUNT_WRONG");
const int calls = 25_000;
var watch = new Stopwatch();
var before = GC.GetAllocatedBytesForCurrentThread();
watch.Start(); long sum = 0;
for (var i = 0; i < calls; i++) sum += count(descriptor);
watch.Stop();
var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
if (sum != (long)calls * expected) throw new Exception("UV_SET_COUNT_CHANGED");
if (Hash(File.ReadAllBytes(producer)) != producerHash || Hash(File.ReadAllBytes(input)) != Hash(source))
    throw new Exception("PRODUCER_OR_INPUT_CHANGED");
var passed = allocated < 64 * 1024;
Console.WriteLine(JsonSerializer.Serialize(new { passed, producerHash, sourceHash = Hash(source), calls,
    uvSetCount = expected, allocatedBytes = allocated, wallMs = watch.Elapsed.TotalMilliseconds,
    allocationLimit = 64 * 1024, scope = "Compiled native UV-count getter; no per-call reflection or GPU" }));
Environment.ExitCode = passed ? 0 : 1;
