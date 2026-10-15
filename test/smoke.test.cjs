'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../server.js');

test('HTML frontend and admin scripts parse without syntax errors', () => {
  for(const file of ['index.html','admin.html']) {
    const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    assert.match(html, /<html\b/i);
    const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(inline.length>0,file+' has scripts');
    for(const s of inline)assert.doesNotThrow(()=>new Function(s[1]),file+' JS syntax');
  }
});
test('public pages, health endpoint and protected admin API', async(t) => {
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  for(const route of ['/','/admin','/privacy','/health','/api/prices','/api/projects']) {
    const response=await fetch(base+route);
    assert.equal(response.status,200,'GET '+route);
  }
  const me=await fetch(base+'/api/admin/me');
  assert.ok([401,503].includes(me.status),'Admin API must never be public');
  const health=await(await fetch(base+'/health')).json();
  assert.equal(health.ok,true);
});
