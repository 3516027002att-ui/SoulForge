import { check, integer } from './common.mjs';
/** Baseline plus ordered writes/appends. No per-operation full-file clone. */
export class BytePatchPlan {
  constructor(baseline, maxLength = 128 * 1024 * 1024) {
    check(Buffer.isBuffer(baseline), 'BUFFER_REQUIRED'); integer(maxLength, 1);
    check(baseline.length <= maxLength, 'MAX_LENGTH');
    this.baseline = Buffer.from(baseline); this.length = baseline.length;
    this.maxLength = maxLength; this.writes = [];
  }
  write(offset, bytes) {
    integer(offset); check(Buffer.isBuffer(bytes) && bytes.length > 0, 'WRITE_EMPTY');
    check(offset <= this.length && bytes.length <= this.length - offset, 'WRITE_OOB');
    this.writes.push({ offset, data: Buffer.from(bytes) });
  }
  append(bytes) {
    check(Buffer.isBuffer(bytes) && bytes.length > 0, 'APPEND_EMPTY');
    check(bytes.length <= this.maxLength - this.length, 'MAX_LENGTH');
    const offset = this.length; this.length += bytes.length;
    this.writes.push({ offset, data: Buffer.from(bytes) }); return offset;
  }
  materialize() {
    const output = Buffer.alloc(this.length); this.baseline.copy(output);
    for (const write of this.writes) write.data.copy(output, write.offset);
    return output;
  }
  retainedBytes() { return this.baseline.length + this.writes.reduce((n,w) => n+w.data.length,0); }
  changedIntervals() {
    const all = this.writes.map(w => [w.offset, w.offset+w.data.length]).sort((a,b) => a[0]-b[0]);
    const merged = [];
    for (const [start,end] of all) {
      const prev = merged.at(-1);
      if (prev && start <= prev[1]) prev[1] = Math.max(prev[1],end);
      else merged.push([start,end]);
    }
    return merged;
  }
  verifyUntouched(output) {
    check(output.length === this.length, 'OUTPUT_LENGTH');
    let start = 0;
    for (const [a,b] of this.changedIntervals()) {
      const end = Math.min(a,this.baseline.length);
      if (end > start) check(this.baseline.subarray(start,end).equals(output.subarray(start,end)), 'UNTOUCHED_CHANGED');
      start = Math.min(Math.max(start,b),this.baseline.length);
    }
    check(this.baseline.subarray(start).equals(output.subarray(start,this.baseline.length)), 'UNTOUCHED_CHANGED');
    return true;
  }
}
