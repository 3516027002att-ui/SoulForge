import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Pure acceptance contracts. No Bridge launch, native parsing or filesystem I/O.
export function classifyNativeRead(result) {
  const diagnostic = result?.diagnostics?.find(item => item.severity === 'error') ?? result?.diagnostics?.[0];
  const detail = { code: diagnostic?.code ?? 'BRIDGE_READ_RESULT', message: diagnostic?.message ?? '' };
  if (result?.parseStatus === 'failed' || diagnostic?.severity === 'error') return { ...detail, status: 'failed' };
  if (result?.parseStatus === 'unsupported' || result?.parseStatus === 'unparsed') return { ...detail, status: 'unavailable' };
  if (!['ok', 'parsed', 'partial'].includes(result?.parseStatus) || result.data === null || result.data === undefined)
    return { status: 'failed', code: 'BRIDGE_READ_DATA_MISSING', message: 'An executed read must return a recognized envelope and data.' };
  return { ...detail, status: 'passed' };
}

export function summarizeNativeReads(rows) {
  const counts = Object.fromEntries(['passed', 'failed', 'unavailable', 'not_run'].map(status => [status, rows.filter(row => row.status === status).length]));
  const skippedLegs = rows.flatMap((row, index) => ['unavailable', 'not_run'].includes(row.status)
    ? [`${row.file ?? row.relativePath ?? row.family ?? index}:${row.status}`] : []);
  if (rows.some(row => !Object.hasOwn(counts, row.status))) throw new Error('NATIVE_READ_STATUS_INVALID');
  const status = counts.failed ? 'failed' : counts.unavailable ? 'unavailable'
    : counts.not_run || !counts.passed ? 'not_run' : 'passed';
  return { ok: status === 'passed' ? true : status === 'failed' ? false : null, status, counts, skippedLegs,
    ...(!counts.passed && ['unavailable', 'not_run'].includes(status) ? { skipped: true } : {}) };
}

export function verifyFileCoverage(inputs, processed) {
  const digest = values => createHash('sha256').update(JSON.stringify([...values].sort())).digest('hex');
  const duplicates = values => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  const inputSet = new Set(inputs), processedSet = new Set(processed);
  const missing = inputs.filter(file => !processedSet.has(file)), unexpected = processed.filter(file => !inputSet.has(file));
  const duplicateInputs = duplicates(inputs), duplicateProcessed = duplicates(processed);
  return { ok: !missing.length && !unexpected.length && !duplicateInputs.length && !duplicateProcessed.length,
    inputCount: inputs.length, processedCount: processed.length, inputSetSha256: digest(inputs), processedSetSha256: digest(processed),
    missing, unexpected, duplicateInputs, duplicateProcessed };
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function validCacheReceipt(result, { file, sourceHash, sourceSize, sourceUnchanged }) {
  const data = result.data, origin = pathToFileURL(file).href;
  if (result.parseStatus !== 'partial' || !result.diagnostics?.some(item => item.code === 'LARGE_RESOURCE_READ_ONLY_CACHE')
    || !hash(sourceHash) || sourceUnchanged !== true || result.sourcePath !== file || result.sourceUri !== origin
    || data.format !== 'DCX' || data.sourceHash !== sourceHash || data.sourceSize !== sourceSize || !(sourceSize > 64 * 1024 * 1024)
    || data.readOnly !== true || data.provenance?.readOnly !== true || data.provenance?.containerWriteSupported !== false
    || data.provenance?.unpacker !== 'user-imported-standalone-WitchyBND'
    || data.provenance?.sourceContainerHash !== sourceHash || !hash(data.provenance?.unpackerIdentity)
    || data.roundTrip?.byteIdentical !== false || data.roundTrip?.payloadIdentical !== false
    || !Number.isSafeInteger(data.entryCount) || data.entryCount < 1 || !Array.isArray(data.entries) || data.entries.length !== data.entryCount
    || data.nested?.format !== 'BND4' || data.nested.entryCount !== data.entryCount
    || !Array.isArray(data.nested.entries) || data.nested.entries.length !== data.entryCount) return false;
  const validEntry = (entry, index) => {
    if (!entry || entry.index !== index || entry.entryIndex !== index || !Number.isSafeInteger(entry.id) || entry.entryId !== entry.id
      || typeof entry.name !== 'string' || !entry.name || entry.entryName !== entry.name
      || !Number.isSafeInteger(entry.duplicateOrdinal) || entry.duplicateOrdinal < 0
      || !Number.isSafeInteger(entry.contentSize) || entry.contentSize < 0 || entry.size !== entry.contentSize || entry.uncompressedSize !== entry.contentSize
      || !hash(entry.contentHash) || entry.sourceContainerHash !== sourceHash || entry.sourcePath !== file) return false;
    const prefix = `${origin}#bnd/entry/${index}/child/`;
    try { return typeof entry.sourceUri === 'string' && entry.sourceUri.startsWith(prefix) && decodeURIComponent(entry.sourceUri.slice(prefix.length)) === entry.name; }
    catch { return false; }
  };
  return data.entries.every((entry, index) => {
    const nested = data.nested.entries[index];
    return validEntry(entry, index) && validEntry(nested, index)
      && ['id', 'name', 'duplicateOrdinal', 'contentSize', 'contentHash', 'sourceUri'].every(field => entry[field] === nested[field]);
  });
}

export function classifyDcxRead(result, context) {
  const read = classifyNativeRead(result);
  if (read.status !== 'passed') return read;
  const { variants } = context;
  const data = result?.data;
  if (result.diagnostics?.some(item => item.code === 'LARGE_RESOURCE_READ_ONLY_CACHE') || data?.readOnly === true) {
    return validCacheReceipt(result, context)
      ? { status: 'passed', kind: 'read-only-cache', entryCount: data.entryCount, containerWriteSupported: false, outerRoundTripVerified: false }
      : { status: 'failed', code: 'LARGE_RESOURCE_CACHE_RECEIPT_INVALID' };
  }
  if (data?.compressionFormat === 'DFLT' && data.roundTrip?.payloadIdentical === true && data.roundTrip?.variantIdentical === true) {
    if (!variants.has(data.variant)) return { status: 'failed', code: 'UNRECOGNIZED_BRIDGE_VARIANT' };
    if (data.nested?.format === 'BND4' && data.nested?.roundTrip?.entriesIdentical === true
      && (data.nested?.crud?.allPassed !== true || data.nestedDcxRebuildVerified !== true)) return { status: 'failed', code: 'BND4_CRUD_ROUNDTRIP_FAILED' };
    return { status: 'passed', kind: 'dflt-roundtrip', variant: data.variant };
  }
  if (data?.compressionFormat === 'KRAK' && /^[a-f0-9]{64}$/u.test(data.payloadHash ?? '')) {
    if (!variants.has(data.variant)) return { status: 'failed', code: 'UNRECOGNIZED_BRIDGE_VARIANT' };
    if (data.nested?.format === 'BND4' && (data.nested?.crud?.allPassed !== true
      || data.nested?.fieldPreservation?.headerUnknownBytesPreserved !== true
      || data.nested?.fieldPreservation?.entryHeaderFieldsPreserved !== true
      || data.nested?.fieldPreservation?.storedBytesPreserved !== true)) return { status: 'failed', code: 'KRAK_BND4_PRESERVATION_OR_CRUD_FAILED' };
    return { status: 'passed', kind: 'krak-native-read', variant: data.variant };
  }
  return { status: 'failed', code: result?.diagnostics?.[0]?.code ?? 'UNEXPECTED_RESULT' };
}

export async function* collectNativeReads(paths, limit, readOne) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('NATIVE_READ_CONCURRENCY_INVALID');
  const inFlight = new Map(); let nextIndex = 0;
  const start = () => {
    if (nextIndex === paths.length) return;
    const index = nextIndex++, file = paths[index];
    const pending = Promise.resolve().then(() => readOne(file)).then(value => {
      if (value?.file !== file) throw new Error('NATIVE_READ_RECEIPT_IDENTITY_MISMATCH');
      return { index, value };
    }).catch(error => ({ index, value: { file, error } }));
    inFlight.set(index, pending);
  };
  for (let i = 0; i < limit; i++) start();
  while (inFlight.size > 0) {
    const done = await Promise.race(inFlight.values());
    // Completed work remains in the map until consumed, including during yield.
    inFlight.delete(done.index); start(); yield done.value;
  }
}
