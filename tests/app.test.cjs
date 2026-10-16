'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const net=require('node:net');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
let child,base;
function freePort(){
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const port=server.address().port;
      server.close(()=>resolve(port));
    });
  });
}
async function request(uri,options){
  const response=await fetch(base+uri,options);
  const body=await response.text();
  let json;try{json=JSON.parse(body)}catch{}
  return {status:response.status,body,json,headers:response.headers};
}
test.before(async()=>{
  const port=await freePort();base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['server.js'],{
    cwd:root,env:{...process.env,PORT:String(port),DATABASE_URL:'',OPENAI_API_KEY:'',ADMIN_PASSWORD:'a-strong-test-only-password',NODE_ENV:'test'},
    stdio:['ignore','pipe','pipe']
  });
  let logs='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs+=String(b).slice(0,1000)});
  for(let i=0;i<70;i++){
    if(child.exitCode!==null)throw Error('Server exited prematurely: '+logs);
    try{const res=await request('/health');if(res.status===200)return}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  child.kill();throw Error('Server never started: '+logs);
});
test.after(()=>{if(child&&!child.killed)child.kill()});
test('Health: app starts without DATABASE_URL',async()=>{
  const r=await request('/health');
  assert.equal(r.status,200);
  assert.equal(r.json.ok,true);
  assert.notEqual(r.json.db,'ready');
});
test('Homepage: Russian cleaning business site is served',async()=>{
  const r=await request('/');
  assert.equal(r.status,200);
  assert.match(r.body,/Наш Клининг/);
  assert.match(r.body,/id="orderForm"/);
});
test('Default pricing includes the original BYN prices',async()=>{
  const r=await request('/api/prices');
  assert.equal(r.status,200);
  assert.ok(Array.isArray(r.json.home.cards));
  assert.match(JSON.stringify(r.json),/BYN/);
});
test('Booking fails safely without database instead of pretending success',async()=>{
  const r=await request('/api/bookings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Тест',phone:'+375291234567',city:'Минск',service:'Уборка кухни'})});
  assert.equal(r.status,503);
});
test('Anonymous visitors cannot access private bookings',async()=>{
  const r=await request('/api/admin/bookings');
  assert.equal(r.status,401);
});
test('Wrong admin credentials are rejected',async()=>{
  const r=await request('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'wrong-password'})});
  assert.equal(r.status,401);
});
test('Admin interface is available for login',async()=>{
  const r=await request('/admin');
  assert.equal(r.status,200);
  assert.match(r.body,/<html/);
});
test('Privacy information is available',async()=>{
  const r=await request('/privacy');
  assert.equal(r.status,200);
  assert.match(r.body,/персональных данных/i);
});
test('AI requires server-side API key',async()=>{
  const r=await request('/api/ai/status');
  assert.equal(r.status,200);
  assert.equal(r.json.enabled,false);
});
