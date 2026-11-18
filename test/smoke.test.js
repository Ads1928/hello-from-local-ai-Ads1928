import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp=mkdtempSync(path.join(os.tmpdir(),'agent-catalogue-test-'));
const port=19000+Math.floor(Math.random()*2000);
const url=`http://127.0.0.1:${port}`;
let child;
async function waitForServer(){for(let attempt=0;attempt<60;attempt++){try{const r=await fetch(url+'/health');if(r.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Server failed to start');}

test('catalogue, analytics, login and CRUD', async()=>{
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,DB_PATH:path.join(tmp,'test.sqlite'),APP_SECRET:'for-tests-only-secret-that-is-long-enough-abcde',ADMIN_PASSWORD:'local-test-password-12345',PORT:String(port),NODE_ENV:'test'},stdio:'ignore'});
  try {
    await waitForServer();
    assert.equal((await fetch(url+'/')).status,200);
    const detail=()=>fetch(url+'/tools/chatgpt',{headers:{'User-Agent':'Mozilla/5.0 Test visitor'}});
    await detail();await detail();
    const search=await fetch(url+'/search?q=automation',{headers:{'User-Agent':'Mozilla/5.0 Test visitor'}}); assert.equal(search.status,200);
    const login=await fetch(url+'/admin/login',{method:'POST',body:new URLSearchParams({password:'local-test-password-12345'}),redirect:'manual'});
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
    const dashboard=await fetch(url+'/admin',{headers:{Cookie:cookie}}); const body=await dashboard.text();
    assert.equal(dashboard.status,200);assert.ok(body.includes('Top listings'));
    assert.match(body,/ChatGPT/);
    assert.ok(body.includes('Popular searches'));
    const form=await (await fetch(url+'/admin/listings/new',{headers:{Cookie:cookie}})).text();
    const csrf=form.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];assert.ok(csrf);
    const create=await fetch(url+'/admin/listings/new',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,name:'Test AI Tool',category:'Testing',summary:'A simple test tool',description:'A new test tool entry',website_url:'https://example.com',pricing:'Free',tags:'test',active:'1'}),redirect:'manual'});
    assert.equal(create.status,303);
    const created=await fetch(url+'/tools/test-ai-tool');assert.equal(created.status,200);
    const bad=await fetch(url+'/admin/listings/new',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name:'Hacker'})});assert.equal(bad.status,403);
    const csv=await fetch(url+'/admin/export.csv',{headers:{Cookie:cookie}});assert.equal(csv.status,200);assert.match(await csv.text(),/ChatGPT/);
  } finally { if(child){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}rmSync(tmp,{recursive:true,force:true}); }
});
