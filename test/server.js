import http from 'node:http';
import {readFile} from 'node:fs/promises';
export async function serve(files) {
 const server=http.createServer(async(req,res)=>{
  const url=files[new URL(req.url,'http://localhost').pathname];
  if(!url){res.writeHead(404);res.end();return;}
  try{const body=await readFile(url);res.setHeader('Content-Type',String(url).endsWith('.wasm')?'application/wasm':String(url).endsWith('.html')?'text/html':'text/javascript');res.end(body);}catch{res.writeHead(500);res.end('Missing build artifact');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>server.close(r))};
}
