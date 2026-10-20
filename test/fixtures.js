export function wave({bits=16,format=1,channels=1,rate=48000,samples=[-1,0,0.5],xml=null,rf64=false,extensible=false}={}) {
 const bps=bits/8;
 const fmt=new Uint8Array(extensible?40:16), f=new DataView(fmt.buffer);
 f.setUint16(0,extensible?0xfffe:format,true);f.setUint16(2,channels,true);f.setUint32(4,rate,true);f.setUint32(8,rate*channels*bps,true);f.setUint16(12,channels*bps,true);f.setUint16(14,bits,true);
 if(extensible){f.setUint16(16,22,true);f.setUint16(18,bits,true);f.setUint32(20,channels===1?4:3,true);f.setUint16(24,format,true);fmt.set([0,0,0,0,16,0,128,0,0,170,0,56,155,113],26);}
 const pcm=new Uint8Array(samples.length*bps),v=new DataView(pcm.buffer);
 samples.forEach((x,i)=>{const p=i*bps;if(format===3)v.setFloat32(p,x,true);else if(bits===16)v.setInt16(p,x*32768,true);else if(bits===32)v.setInt32(p,x*2147483648,true);else {let n=Math.round(x*8388608);pcm[p]=n;pcm[p+1]=n>>8;pcm[p+2]=n>>16;}});
 const chunks=[['fmt ',fmt],...(xml?[['axml',new TextEncoder().encode(xml)]]:[]),['data',pcm]];
 if(rf64){const ds=new Uint8Array(28);new DataView(ds.buffer).setBigUint64(8,BigInt(pcm.length),true);chunks.unshift(['ds64',ds]);}
 const size=12+chunks.reduce((a,[,x])=>a+8+x.length+(x.length%2),0),out=new Uint8Array(size),d=new DataView(out.buffer);
 out.set(new TextEncoder().encode(rf64?'RF64':'RIFF'));d.setUint32(4,rf64?0xffffffff:size-8,true);out.set(new TextEncoder().encode('WAVE'),8);
 let p=12;for(const [id,x] of chunks){out.set(new TextEncoder().encode(id),p);d.setUint32(p+4,rf64&&id==='data'?0xffffffff:x.length,true);out.set(x,p+8);p+=8+x.length+(x.length%2);}
 return out.buffer;
}
export const xml='<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2017"><coreMetadata><format><audioFormatExtended><audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Synthetic programme"/></audioFormatExtended></format></coreMetadata></ebuCoreMain>';
