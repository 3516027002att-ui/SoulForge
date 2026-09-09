internal static class BridgeTelemetry
{
    public static long DcxInflateCount;
    public static long BndParseCount;
    // ParseCount historically meant "projection/session creation" in the map
    // service. Keep the parser counter separate so a repeated page request can
    // prove that the native FLVER parser was not re-entered.
    public static long FlverParseCount;
    public static long MapGeometryProjectionCount;
    public static long MapTypedPositionDecodeCount;
    public static long MapTypedNormalDecodeCount;
    public static long MapTypedUvDecodeCount;
    public static long MapTypedIndexReadCount;
    public static long FlverBase64EncodeCount;
    public static long FlverBase64DecodeCount;
    public static long ParamParseCount;
    public static long ParamDecodedRowsCount;
    public static long ParamSessionOpenCount;
    public static long ParamStructuralValidationCount;
    public static long ParamSerializedRowsCount;

    public static void Reset()
    {
        System.Threading.Interlocked.Exchange(ref DcxInflateCount, 0);
        System.Threading.Interlocked.Exchange(ref BndParseCount, 0);
        System.Threading.Interlocked.Exchange(ref FlverParseCount, 0);
        System.Threading.Interlocked.Exchange(ref MapGeometryProjectionCount, 0);
        System.Threading.Interlocked.Exchange(ref MapTypedPositionDecodeCount, 0);
        System.Threading.Interlocked.Exchange(ref MapTypedNormalDecodeCount, 0);
        System.Threading.Interlocked.Exchange(ref MapTypedUvDecodeCount, 0);
        System.Threading.Interlocked.Exchange(ref MapTypedIndexReadCount, 0);
        System.Threading.Interlocked.Exchange(ref FlverBase64EncodeCount, 0);
        System.Threading.Interlocked.Exchange(ref FlverBase64DecodeCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamParseCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamDecodedRowsCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamSessionOpenCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamStructuralValidationCount, 0);
        System.Threading.Interlocked.Exchange(ref ParamSerializedRowsCount, 0);
    }

    public static object Snapshot() => new
    {
        dcxInflate = System.Threading.Volatile.Read(ref DcxInflateCount),
        bndParse = System.Threading.Volatile.Read(ref BndParseCount),
        flverParse = System.Threading.Volatile.Read(ref FlverParseCount),
        mapGeometryProjection = System.Threading.Volatile.Read(ref MapGeometryProjectionCount),
        mapTypedPositionDecode = System.Threading.Volatile.Read(ref MapTypedPositionDecodeCount),
        mapTypedNormalDecode = System.Threading.Volatile.Read(ref MapTypedNormalDecodeCount),
        mapTypedUvDecode = System.Threading.Volatile.Read(ref MapTypedUvDecodeCount),
        mapTypedIndexRead = System.Threading.Volatile.Read(ref MapTypedIndexReadCount),
        flverBase64Encode = System.Threading.Volatile.Read(ref FlverBase64EncodeCount),
        flverBase64Decode = System.Threading.Volatile.Read(ref FlverBase64DecodeCount),
        paramParse = System.Threading.Volatile.Read(ref ParamParseCount),
        paramDecodedRows = System.Threading.Volatile.Read(ref ParamDecodedRowsCount),
        paramSessionOpen = System.Threading.Volatile.Read(ref ParamSessionOpenCount),
        paramStructuralValidation = System.Threading.Volatile.Read(ref ParamStructuralValidationCount),
        paramSerializedRows = System.Threading.Volatile.Read(ref ParamSerializedRowsCount),
    };
}
