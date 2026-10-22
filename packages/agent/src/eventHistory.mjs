/** Replay is an explicitly bounded window, not a second durable session transcript. */
export class BoundedEventHistory {
    constructor({ maxBytes = 2097152, maxEntries = 4096 } = {}) { this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.entries = []; this.totalBytes = 0; this.droppedThrough = 0; }
    append(event) {
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (bytes > this.maxBytes) {
            this.droppedThrough = Math.max(this.droppedThrough, event.seq);
            return;
        }
        this.entries.push({ event, bytes });
        this.totalBytes += bytes;
        while (this.totalBytes > this.maxBytes || this.entries.length > this.maxEntries) {
            const removed = this.entries.shift();
            this.totalBytes -= removed.bytes;
            this.droppedThrough = Math.max(this.droppedThrough, removed.event.seq);
        }
    }
    replay(afterSeq = 0) { return { events: this.entries.filter(entry => entry.event.seq > afterSeq).map(entry => entry.event), truncated: afterSeq < this.droppedThrough, firstAvailableSeq: this.entries[0]?.event.seq ?? null, totalBytes: this.totalBytes }; }
    clear() { this.entries = []; this.totalBytes = 0; this.droppedThrough = 0; }
}
