'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;
process.env.ADMIN_USERNAME = 'smoke-admin';
process.env.ADMIN_PASSWORD = 'smoke-test-password-12345';
const app = require('../server');

test('Сайт и API работают без подключённой базы; закрытые разделы защищены', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const get = path => fetch(url + path);
  const post = (path, data, headers = {}) => fetch(url + path, {
    method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(data)
  });
  try {
    const homepage = await get('/');
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /Наш Клининг|НАШ КЛИНИНГ/i);

    const health = await get('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {ok:true, db:'not-configured'});

    const price = await get('/api/prices');
    assert.equal(price.status, 200);
    const prices = await price.json();
    assert.ok(prices.home && prices.furniture && prices.cars);

    const projects = await get('/api/projects');
    assert.equal(projects.status, 200);
    assert.deepEqual(await projects.json(), []);

    assert.equal((await get('/admin')).status, 200);
    assert.equal((await get('/privacy')).status, 200);
    assert.equal((await get('/api/admin/bookings')).status, 401);

    const badLogin = await post('/api/admin/login', {username:'smoke-admin', password:'wrong'});
    assert.equal(badLogin.status, 401);

    const login = await post('/api/admin/login', {
      username:'smoke-admin',password:'smoke-test-password-12345'
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^nk_sid=/);

    const account = await fetch(url + '/api/admin/me', {headers:{cookie}});
    assert.equal(account.status, 200);
    assert.equal((await account.json()).username, 'smoke-admin');

    const privatePrices = await fetch(url + '/api/admin/prices', {headers:{cookie}});
    assert.equal(privatePrices.status, 503);

    const lead = await post('/api/bookings', {
      name:'Тест',phone:'+375291234567',city:'Минск',service:'Уборка'
    });
    assert.equal(lead.status, 503);
  } finally {
    await new Promise((resolve,reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
