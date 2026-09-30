export class BoundedEventSender<T> {constructor(send:(event:T)=>Promise<void>,options?:{maxBytes?:number;maxEntries?:number});enqueue(event:T):void;flush():Promise<void>}
