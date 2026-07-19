/**
 * Bridge daemon contract for bounded PARAM row reads.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

interface ParamPageEnvelope {
  rowCount: number;
  rowOffset: number;
  rowLimit: number;
  rowFilterId?: number;
  rowsReturned: number;
  rowsTruncated: boolean;
  payloadsIncluded: boolean;
  payloadOmissionReason?: string;
  rows: Array<{ id: number; dataBase64?: string; dataHash: string }>;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-param-page-'));
  const fixturePath = join(root, 'synthetic.param');
  try {
    await writeFile(fixturePath, createEmbeddedParamFixture());

    const firstPage = await readPage(fixturePath, root, { rowOffset: 0, rowLimit: 1, includePayloads: true });
    if (firstPage.rowCount !== 2
      || firstPage.rowsReturned !== 1
      || firstPage.rows[0]?.id !== 10
      || firstPage.rows[0]?.dataBase64 !== Buffer.from([1, 2, 3, 4]).toString('base64')
      || firstPage.rowsTruncated !== true
      || firstPage.payloadsIncluded !== true) {
      throw new Error(`first page mismatch: ${JSON.stringify(firstPage)}`);
    }

    const secondPage = await readPage(fixturePath, root, { rowOffset: 1, rowLimit: 1, includePayloads: true });
    if (secondPage.rowOffset !== 1
      || secondPage.rowsReturned !== 1
      || secondPage.rows[0]?.id !== 20
      || secondPage.rows[0]?.dataBase64 !== Buffer.from([5, 6, 7, 8]).toString('base64')
      || secondPage.rowsTruncated !== false) {
      throw new Error(`second page mismatch: ${JSON.stringify(secondPage)}`);
    }

    const byId = await readPage(fixturePath, root, {
      rowOffset: 1,
      rowLimit: 1,
      rowId: 10,
      includePayloads: false
    });
    if (byId.rowFilterId !== 10
      || byId.rowOffset !== 0
      || byId.rowsReturned !== 1
      || byId.rows[0]?.id !== 10
      || byId.rows[0]?.dataBase64 !== undefined
      || byId.payloadsIncluded !== false
      || byId.rowsTruncated !== false) {
      throw new Error(`row-id filter mismatch: ${JSON.stringify(byId)}`);
    }

    const invalid = await runBridge<ParamPageEnvelope>({
      command: 'read-param-document',
      filePath: fixturePath,
      allowedRoots: [root],
      timeoutMs: 60_000,
      commandOptions: { rowLimit: 501 }
    });
    if (invalid.parseStatus !== 'failed'
      || !invalid.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_READ_OPTIONS_INVALID')) {
      throw new Error(`invalid rowLimit must fail structurally: ${JSON.stringify(invalid)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'PARAM 服务端分页与按 row ID 有界读取契约验证通过',
      firstPageRows: firstPage.rowsReturned,
      secondPageRows: secondPage.rowsReturned,
      rowIdFilterVerified: true,
      payloadOmissionVerified: true,
      oversizedPageBlocked: true
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

async function readPage(
  fixturePath: string,
  root: string,
  commandOptions: Record<string, unknown>
): Promise<ParamPageEnvelope> {
  const result = await runBridge<ParamPageEnvelope>({
    command: 'read-param-document',
    filePath: fixturePath,
    allowedRoots: [root],
    timeoutMs: 60_000,
    commandOptions
  });
  if (result.parseStatus !== 'partial' || !result.data) {
    throw new Error(`PARAM page read failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

function createEmbeddedParamFixture(): Buffer {
  const headerSize = 0x30;
  const rowHeaderSize = 0x0c;
  const rowCount = 2;
  const rowDataSize = 4;
  const tableEnd = headerSize + rowCount * rowHeaderSize;
  const firstDataOffset = tableEnd;
  const nameOffset = firstDataOffset + rowCount * rowDataSize;
  const rowNameA = Buffer.from('first\0', 'ascii');
  const rowNameB = Buffer.from('second\0', 'ascii');
  const output = Buffer.alloc(nameOffset + rowNameA.length + rowNameB.length);

  output.writeInt32LE(nameOffset, 0);
  output.writeUInt16LE(firstDataOffset, 4);
  output.writeUInt16LE(1, 6);
  output.writeUInt16LE(1, 8);
  output.writeUInt16LE(rowCount, 10);
  Buffer.from('SYNTHETIC_PARAM_ST\0', 'ascii').copy(output, 0x0c);
  output.writeInt32LE(0x200, 0x2c);

  output.writeInt32LE(10, 0x30);
  output.writeInt32LE(firstDataOffset, 0x34);
  output.writeInt32LE(nameOffset, 0x38);
  output.writeInt32LE(20, 0x3c);
  output.writeInt32LE(firstDataOffset + rowDataSize, 0x40);
  output.writeInt32LE(nameOffset + rowNameA.length, 0x44);
  Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).copy(output, firstDataOffset);
  rowNameA.copy(output, nameOffset);
  rowNameB.copy(output, nameOffset + rowNameA.length);
  return output;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
