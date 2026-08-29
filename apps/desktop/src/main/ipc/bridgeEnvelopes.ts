/**
 * 多个 IPC domain 共用的 Bridge wire envelope 形状（只读投影类型）。
 * 纯类型模块：不含状态与逻辑，避免 domain 之间互相 import 或复制定义。
 */

/** Native BND4 entry fields surfaced by the Bridge `read-dcx-document` envelope. */
export interface NativeBnd4EntryLike {
  index?: number;
  id?: number;
  name?: string;
  flags?: number;
  unknown?: number;
  duplicateOrdinal?: number;
  nameOffset?: number;
  dataOffset?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  contentHash?: string;
}

export interface NativeBnd4DocumentLike {
  format?: string;
  entryCount?: number;
  entries?: NativeBnd4EntryLike[];
  authority?: string;
}

export interface NativeDcxEnvelopeLike {
  format?: string;
  compressionFormat?: string;
  nested?: NativeBnd4DocumentLike;
}
