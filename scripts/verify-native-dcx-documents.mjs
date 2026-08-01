import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2] ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT ?? 'mods');
const executable = resolve('bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe');
const files = (await walk(root)).filter((path) => extname(path).toLowerCase() === '.dcx');
const variants = new Map();
const failures = [];
let dfltVerified = 0;
let krakBlocked = 0;
let krakReadVerified = 0;
let nestedBnd4Verified = 0;
let nestedBnd4Entries = 0;
let krakNestedBnd4Verified = 0;
let krakNestedBnd4Entries = 0;
for (const file of files) {
  try {
    const { stdout } = await execFileAsync(executable, ['read-dcx-document', file], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000
    });
    const result = JSON.parse(stdout);
    const data = result.data;
    if (data?.compressionFormat === 'DFLT' && data.roundTrip?.payloadIdentical === true
      && data.roundTrip?.variantIdentical === true) {
      dfltVerified += 1;
      variants.set(data.variant, (variants.get(data.variant) ?? 0) + 1);
      if (data.nested?.format === 'BND4' && data.nested?.roundTrip?.entriesIdentical === true) {
        if (data.nested?.crud?.allPassed !== true || data.nestedDcxRebuildVerified !== true) {
          failures.push({ file: relative(file), code: 'BND4_CRUD_ROUNDTRIP_FAILED' });
          continue;
        }
        nestedBnd4Verified += 1;
        nestedBnd4Entries += data.nested.entryCount;
      }
    } else if (data?.compressionFormat === 'KRAK'
      && typeof data.payloadHash === 'string'
      && /^[a-f0-9]{64}$/u.test(data.payloadHash)) {
      krakReadVerified += 1;
      variants.set(data.variant, (variants.get(data.variant) ?? 0) + 1);
      if (data.nested?.format === 'BND4') {
        const fieldPreservation = data.nested.fieldPreservation;
        if (data.nested?.crud?.allPassed !== true
          || !fieldPreservation
          || fieldPreservation.headerUnknownBytesPreserved !== true
          || fieldPreservation.entryHeaderFieldsPreserved !== true
          || fieldPreservation.storedBytesPreserved !== true) {
          failures.push({ file: relative(file), code: 'KRAK_BND4_PRESERVATION_OR_CRUD_FAILED' });
          continue;
        }
        krakNestedBnd4Verified += 1;
        krakNestedBnd4Entries += data.nested.entryCount;
      }
    } else failures.push({ sample: redact(file), code: result.diagnostics?.[0]?.code ?? 'UNEXPECTED_RESULT' });
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    let result;
    try { result = JSON.parse(stdout); } catch { result = undefined; }
    const message = result?.diagnostics?.[0]?.message ?? String(error);
    if (/Oodle|KRAK|运行库/.test(message)) krakBlocked += 1;
    else failures.push({ sample: redact(file), code: result?.diagnostics?.[0]?.code ?? 'PROCESS_FAILED' });
  }
}
if (dfltVerified === 0 || failures.length > 0) {
  console.error(JSON.stringify({ ok: false, files: files.length, dfltVerified, krakReadVerified, krakBlocked, krakNestedBnd4Verified, krakNestedBnd4Entries, variants: Object.fromEntries(variants), failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    message: '真实 DCX 文档完整读取与 DFLT payload roundtrip 验证通过',
    files: files.length,
    dfltVerified,
    krakReadVerified,
    krakBlocked,
    krakNestedBnd4Verified,
    krakNestedBnd4Entries,
    nestedBnd4Verified,
    nestedBnd4Entries,
    variants: Object.fromEntries([...variants].sort()),
    failures
  }, null, 2));
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
function redact(path) {
  return `sample-${createHash('sha256').update(relative(path)).digest('hex').slice(0, 12)}`;
}
function relative(path) { return path.slice(root.length + 1).replaceAll('\\', '/'); }
