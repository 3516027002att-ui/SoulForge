import {check} from './common.mjs';
function matrix(m){check(Array.isArray(m)&&m.length===16&&m.every(Number.isFinite),'MAT4_INVALID');return m;}
export const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
/** Row-major storage, column-vector math. This is an explicit reference convention. */
export function multiply(a,b){matrix(a);matrix(b);return Array.from({length:16},(_,i)=>{
 const r=Math.floor(i/4),c=i%4;let value=0;for(let k=0;k<4;k++)value+=a[r*4+k]*b[k*4+c];return value;
});}
export function inverse(m){matrix(m);const a=Array.from({length:4},(_,r)=>[...m.slice(r*4,r*4+4),...identity().slice(r*4,r*4+4)]);
 for(let c=0;c<4;c++){let p=c;for(let r=c+1;r<4;r++)if(Math.abs(a[r][c])>Math.abs(a[p][c]))p=r;
 check(Math.abs(a[p][c])>1e-12,'MATRIX_SINGULAR');[a[c],a[p]]=[a[p],a[c]];const pivot=a[c][c];
 for(let j=0;j<8;j++)a[c][j]/=pivot;
 for(let r=0;r<4;r++){if(r===c)continue;const factor=a[r][c];for(let j=0;j<8;j++)a[r][j]-=factor*a[c][j];}}
 return a.flatMap(row=>row.slice(4));
}
export function changeBasis(m,c){return multiply(multiply(c,m),inverse(c));}
export function point(m,p){matrix(m);check(p.length===3&&p.every(Number.isFinite),'POINT_INVALID');
 const v=[...p,1],o=Array.from({length:4},(_,r)=>v.reduce((s,x,c)=>s+x*m[r*4+c],0));
 check(Math.abs(o[3])>1e-12,'HOMOGENEOUS_ZERO');return o.slice(0,3).map(x=>x/o[3]);
}
export function determinant3(m){matrix(m);return m[0]*(m[5]*m[10]-m[6]*m[9])-m[1]*(m[4]*m[10]-m[6]*m[8])+m[2]*(m[4]*m[9]-m[5]*m[8]);}
export function normal(m,n){const inv=inverse(m);check(n.length===3&&n.every(Number.isFinite),'NORMAL_INVALID');
 const o=[0,1,2].map(r=>n.reduce((sum,x,c)=>sum+inv[c*4+r]*x,0));const length=Math.hypot(...o);
 check(length>1e-12,'NORMAL_ZERO');return o.map(x=>x/length);
}
export function triangleAfterBasis(indices,c){check(indices.length%3===0,'TRIANGLE_COUNT');
 const out=[...indices];if(determinant3(c)<0)for(let i=0;i<out.length;i+=3)[out[i+1],out[i+2]]=[out[i+2],out[i+1]];return out;
}
export function hasShear(m,tolerance=1e-6){matrix(m);const cols=[0,1,2].map(c=>[m[c],m[4+c],m[8+c]]);
 const normalized=cols.map(v=>{const len=Math.hypot(...v);check(len>1e-12,'ZERO_SCALE');return v.map(x=>x/len);});
 return [[0,1],[0,2],[1,2]].some(([a,b])=>Math.abs(normalized[a].reduce((s,x,k)=>s+x*normalized[b][k],0))>tolerance);
}
