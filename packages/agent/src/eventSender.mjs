/** Bounded asynchronous event drain. Producers fail closed if consumers cannot keep up. */
export class BoundedEventSender {
  constructor(send, {maxBytes=2_097_152,maxEntries=4096}={}) {
    this.send=send;this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.queue=[];
    this.bytes=0;this.entries=0;this.drainPromise=null;this.failure=null;
  }
  enqueue(event) {
    if(this.failure)throw this.failure;
    const bytes=Buffer.byteLength(JSON.stringify(event),'utf8');
    if(this.bytes+bytes>this.maxBytes || this.entries>=this.maxEntries)throw Object.assign(new Error('Agent event consumer cannot keep up with its bounded queue.'),{code:'AGENT_EVENT_QUEUE_BUDGET_EXCEEDED'});
    this.queue.push({event,bytes});this.bytes+=bytes;this.entries++;
    this.startDrain();
  }
  startDrain() {
    if(this.drainPromise || !this.queue.length || this.failure)return;
    const drain=this.drain();this.drainPromise=drain;
    drain.then(()=>{this.drainPromise=null;this.startDrain();},error=>{this.failure=error;this.drainPromise=null;});
  }
  async drain() {
    while(this.queue.length){const entry=this.queue.shift();await this.send(entry.event);this.bytes-=entry.bytes;this.entries--;}
  }
  async flush() { while(this.drainPromise || this.queue.length){if(this.failure)throw this.failure;this.startDrain();await this.drainPromise;}if(this.failure)throw this.failure; }
}
