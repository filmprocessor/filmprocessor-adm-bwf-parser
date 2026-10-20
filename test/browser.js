import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {launchSilentBrowser} from '../tools/fp-browser-safety.mjs';
import {serve} from './server.js';
import {wave,xml} from './fixtures.js';
test('browser DOM parses ADM and local-file example shows its programme',{timeout:30000},async()=>{
 const server=await serve({'/examples/inspect.html':new URL('../examples/inspect.html',import.meta.url),'/src/index.js':new URL('../src/index.js',import.meta.url)});
 let browser;
 try{browser=await launchSilentBrowser(chromium);const page=await browser.newPage();await page.goto(server.origin+'/examples/inspect.html');
 await page.locator('#file').setInputFiles({name:'synthetic.wav',mimeType:'audio/wav',buffer:Buffer.from(wave({xml}))});
 await page.waitForFunction(()=>document.getElementById('result').textContent.includes('Synthetic programme'));
 const result=JSON.parse(await page.locator('#result').textContent());assert.equal(result.adm.programme.name,'Synthetic programme');assert.equal(result.format.channelCount,1);
 const invalid=await page.evaluate(async bytes=>{const {parseADMBWF}=await import('/src/index.js');return parseADMBWF(Uint8Array.from(bytes).buffer).adm;},Array.from(new Uint8Array(wave({xml:'<broken'}))));assert.equal(invalid,null);
 }finally{await browser?.close();await server.close();}
});
