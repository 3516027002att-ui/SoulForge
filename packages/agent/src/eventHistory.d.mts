export class BoundedEventHistory<T extends {seq:number}> {
 constructor(options?:{maxBytes?:number;maxEntries?:number});
 append(event:T):void;
 replay(afterSeq?:number):{events:T[];truncated:boolean;firstAvailableSeq:number|null;totalBytes:number};
 clear():void;
}
