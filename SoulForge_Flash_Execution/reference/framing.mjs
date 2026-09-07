import {check,integer} from './common.mjs';
/** Byte-based incremental NDJSON. Host must read bounded chunks (for example <=64KiB). */
export class BoundedLines {
  constructor(limit){integer(limit,1);this.limit=limit;this.buffer=Buffer.allocUnsafe(Math.min(limit,4096));this.bytes=0;this.failed=false;this.decoder=new TextDecoder('utf-8',{fatal:true});}
  push(chunk){
    check(!this.failed,'FRAMER_CLOSED');check(Buffer.isBuffer(chunk),'BUFFER_REQUIRED');const lines=[];let start=0;
    try{
      for(let i=0;i<chunk.length;i++){
        if(chunk[i]!==10)continue;
        this.add(chunk.subarray(start,i));
        let length=this.bytes;if(length>0&&this.buffer[length-1]===13)length--;
        lines.push(this.decoder.decode(this.buffer.subarray(0,length)));this.bytes=0;start=i+1;
      }
      this.add(chunk.subarray(start));return lines;
    }catch(error){this.failed=true;this.buffer=Buffer.alloc(0);this.bytes=0;throw error;}
  }
  add(part){
    if(part.length===0)return;
    check(part.length<=this.limit-this.bytes,'FRAME_TOO_LARGE');
    const needed=this.bytes+part.length;
    if(needed>this.buffer.length){
      const capacity=Math.min(this.limit,Math.max(needed,Math.max(1,this.buffer.length)*2));
      const grown=Buffer.allocUnsafe(capacity);this.buffer.copy(grown,0,0,this.bytes);this.buffer=grown;
    }
    part.copy(this.buffer,this.bytes);this.bytes=needed;
  }
  end(){check(!this.failed,'FRAMER_CLOSED');check(this.bytes===0,'FRAME_MISSING_NEWLINE');}
}
