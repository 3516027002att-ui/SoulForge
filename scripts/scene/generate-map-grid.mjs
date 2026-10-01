import {writeFile} from 'node:fs/promises';
// Validation-only indexed grid with explicit normals; never overwrite inputs.
if (!process.argv[2]) throw new Error('Usage: node scripts/scene/generate-map-grid.mjs <new-owned-output.flver> [--uv]');
const includeUv=process.argv.includes('--uv');
const size=256,count=size*size,triangles=(size-1)*(size-1)*2,stride=includeUv?32:24;
const refs=includeUv?316:296,dataStart=refs+8,indexOffset=count*stride,indexCount=triangles*3;
const bytes=Buffer.alloc(dataStart+indexOffset+indexCount*2),i32=(at,n)=>bytes.writeInt32LE(n,at);
bytes.write('FLVER\0');bytes.write('L\0',6);i32(8,0x20014);i32(12,dataStart);i32(16,bytes.length-dataStart);
for(const at of [32,36,64,68,80,84])i32(at,1);bytes[72]=16;
bytes.writeFloatLE(size-1,52);bytes.writeFloatLE(size-1,60);i32(132,-1);i32(144,-1);
i32(160,1);i32(164,refs);i32(168,1);i32(172,refs+4);i32(184,indexCount);i32(188,indexOffset);i32(200,16);
i32(216,stride);i32(220,count);i32(232,indexOffset);i32(240,includeUv?3:2);i32(252,256);i32(264,2);
i32(280,12);i32(284,2);i32(288,3);
if(includeUv){i32(300,24);i32(304,1);i32(308,5);}
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const at=dataStart+(y*size+x)*stride;bytes.writeFloatLE(x,at);bytes.writeFloatLE(y,at+8);bytes.writeFloatLE(1,at+16);if(includeUv){bytes.writeFloatLE(x/(size-1),at+24);bytes.writeFloatLE(y/(size-1),at+28);}}
let out=dataStart+indexOffset;
for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){const a=y*size+x,b=a+1,c=a+size,d=c+1;for(const i of[a,c,b,b,c,d]){bytes.writeUInt16LE(i,out);out+=2;}}
await writeFile(process.argv[2],bytes,{flag:'wx'});console.log(JSON.stringify({size,vertices:count,triangles,bytes:bytes.length}));
