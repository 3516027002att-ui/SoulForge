internal static class BridgeTelemetry
{
    public static long DcxInflateCount;
    public static long BndParseCount;
    public static long ParamParseCount;
    public static long ParamSessionOpenCount;
    public static long ParamStructuralValidationCount;
    public static long ParamSerializedRowsCount;

    public static void Reset()
    {
        System.Threading.Interlocked.Exchange(ref DcxInflateCount, 0);
        System.Threading.Interlocked.Exchange(ref BndParseCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamParseCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamSessionOpenCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamStructuralValidationCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamSerializedRowsCount, 0);
    }

    public static object Snapshot() => new
    {
        dcxInflate = System.Threading.Volatile.Read(ref DcxInflateCount),
        bndParse = System.Threading.Volatile.Read(ref BndParseCount),
        paramParse = System.Threading.Volatile.Read(ref ParamParseCount),
        paramSessionOpen = System.Threading.Volatile.Read(ref ParamSessionOpenCount),
        paramStructuralValidation = System.Threading.Volatile.Read(ref ParamStructuralValidationCount),
        paramSerializedRows = System.Threading.Volatile.Read(ref ParamSerializedRowsCount),
    };
}
