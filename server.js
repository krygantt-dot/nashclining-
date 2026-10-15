'use strict';
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const app = express();
const PORT = Number(process.env.PORT || 10000);
const DB_URL = process.env.DATABASE_URL || '';
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const statuses = ['new','contacted','confirmed','completed','cancelled'];
const defaultPrices = require('./data/defaultPrices.cjs');
const root = __dirname;
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req,res,next) => {
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','strict-origin-when-cross-origin');
  res.set('X-Frame-Options','DENY');
  res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:false, limit:'24kb'}));
const db = DB_URL ? new Pool({
  connectionString:DB_URL, max:5, connectionTimeoutMillis:8000, idleTimeoutMillis:30000,
  ...(process.env.DATABASE_SSL === 'true' ? {ssl:{rejectUnauthorized:true}} : {})
}) : null;
if(db) db.on('error',e=>console.error('PostgreSQL idle connection error:',e.message));
let databaseReady = false;
async function initialize() {
  if(!db) return;
  try {
    await db.query("CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), name VARCHAR(90) NOT NULL, phone VARCHAR(40) NOT NULL, service VARCHAR(180) NOT NULL, city VARCHAR(90) NOT NULL, preferred_date DATE, preferred_time VARCHAR(30), details VARCHAR(2000) NOT NULL DEFAULT '', status VARCHAR(20) NOT NULL DEFAULT 'new')");
    await db.query("CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await db.query("CREATE TABLE IF NOT EXISTS projects (id BIGSERIAL PRIMARY KEY, title VARCHAR(120) NOT NULL, category VARCHAR(100) NOT NULL, description VARCHAR(500) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), before_image BYTEA NOT NULL, before_type VARCHAR(24) NOT NULL, after_image BYTEA NOT NULL, after_type VARCHAR(24) NOT NULL)");
    await db.query('INSERT INTO site_settings(key,value) VALUES ($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', ['prices',JSON.stringify(defaultPrices)]);
    databaseReady = true; console.log('PostgreSQL initialized');
  } catch(err) { databaseReady = false; console.error('PostgreSQL initialization failed:',err.message); }
}
let setup = initialize();
async function needDB(req,res,next) {
  await setup;
  if(!db || !databaseReady) return res.status(503).json({error:'База данных пока не подключена. Позвоните нам или напишите в WhatsApp.'});
  next();
}
const sessions = new Map();
const failed = new Map();
function rateLimit(key,max,windowMs) {
  return (req,res,next) => {
    const id=key+':'+req.ip;const now=Date.now();let entry=failed.get(id);
    if(!entry || entry.reset<now)entry={count:0,reset:now+windowMs};
    entry.count++;failed.set(id,entry);
    if(entry.count>max)return res.status(429).json({error:'Слишком много запросов. Попробуйте позже.'});
    if(failed.size>2000)for(const [k,v]of failed)if(v.reset<now)failed.delete(k);
    next();
  };
}
const loginLimit=rateLimit('login',12,15*60*1000);
const leadLimit=rateLimit('lead',6,60*60*1000);
function safeString(value,max=200){return typeof value==='string'?value.trim().slice(0,max):'';}
function equal(a,b){
  const x=crypto.createHash('sha256').update(String(a)).digest();
  const y=crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x,y);
}
function session(req) {
  const match=(req.headers.cookie||'').match(/(?:^|;\s*)nk_sid=([a-f0-9]{64})(?:;|$)/);
  if(!match)return null;
  const record=sessions.get(match[1]);
  if(!record)return null;
  if(record.expires<Date.now()){sessions.delete(match[1]);return null;}
  return record;
}
function auth(req,res,next){
  if(!ADMIN_PASSWORD)return res.status(503).json({error:'Админ-панель ещё не настроена: установите ADMIN_PASSWORD в Render.'});
  if(!session(req))return res.status(401).json({error:'Требуется вход в админ-панель'});
  next();
}
function checkOrigin(req,res,next) {
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.path.startsWith('/api/admin/')) {
    const origin=req.headers.origin,host=req.get('host');
    if(origin)try{if(new URL(origin).host!==host)return res.status(403).json({error:'Неверный источник запроса'});}
    catch{return res.status(403).json({error:'Неверный источник запроса'});}
  }next();
}
app.use(checkOrigin);
function guard(fn){return(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
async function telegram(message) {
  if(!TELEGRAM_TOKEN||!TELEGRAM_CHAT)return;
  try {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),5000);
    try {
      const r=await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/sendMessage',
        {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT,text:message}),signal:controller.signal});
      if(!r.ok)console.error('Telegram notification error:',r.status);
    }finally{clearTimeout(timeout);}
  }catch(e){console.error('Telegram unavailable:',e.message);}
}
app.get('/health',(req,res)=>res.json({ok:true,db:databaseReady?'ready':'not-configured'}));
app.get('/api/prices',guard(async(req,res)=>{
  if(!databaseReady)return res.json(defaultPrices);
  const result=await db.query("SELECT value FROM site_settings WHERE key='prices'");
  res.set('Cache-Control','no-store');res.json(result.rows[0]?.value||defaultPrices);
}));
app.get('/api/projects',guard(async(req,res)=>{
  if(!databaseReady)return res.json([]);
  const result=await db.query('SELECT id,title,category,description,created_at FROM projects ORDER BY id DESC LIMIT 50');
  res.set('Cache-Control','no-store');res.json(result.rows);
}));
app.get('/api/projects/:id/:side',guard(async(req,res)=>{
  if(!databaseReady)return res.sendStatus(404);
  const id=Number(req.params.id),side=req.params.side;
  if(!Number.isSafeInteger(id)||id<1||!['before','after'].includes(side))return res.sendStatus(404);
  const columns=side==='before'?'before_image AS image,before_type AS mime':'after_image AS image,after_type AS mime';
  const result=await db.query('SELECT '+columns+' FROM projects WHERE id=$1',[id]);
  if(!result.rows.length)return res.sendStatus(404);
  res.type(result.rows[0].mime).set('Cache-Control','public, max-age=3600').send(result.rows[0].image);
}));
app.post('/api/bookings',leadLimit,needDB,guard(async(req,res)=>{
  const {name,phone,service,city,details,preferredDate,preferredTime,website}=req.body||{};
  if(website)return res.status(400).json({error:'Не удалось отправить форму'});
  const n=safeString(name,90),p=safeString(phone,40),s=safeString(service,180),c=safeString(city,90),
    note=safeString(details,2000),date=safeString(preferredDate,10),time=safeString(preferredTime,20);
  if(n.length<2||s.length<2||c.length<2||!(/^\+?[0-9()\s-]{7,25}$/.test(p)))
    return res.status(400).json({error:'Укажите имя, услугу, город и корректный номер телефона.'});
  if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||date<new Date().toISOString().slice(0,10)))
    return res.status(400).json({error:'Проверьте дату записи'});
  if(time&&!/^\d{2}:\d{2}$/.test(time))return res.status(400).json({error:'Неверный формат времени'});
  const r=await db.query('INSERT INTO bookings(name,phone,service,city,preferred_date,preferred_time,details) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[n,p,s,c,date||null,time||null,note]);
  res.status(201).json({ok:true,id:r.rows[0].id,message:'Заявка принята. Мы свяжемся с вами для подтверждения.'});
  void telegram('🧼 Новая заявка #'+r.rows[0].id+'\nУслуга: '+s+'\nКлиент: '+n+'\nТелефон: '+p+'\nГород: '+c+'\nДата: '+(date||'не выбрана')+' '+time+'\nКомментарий: '+note);
}));
app.post('/api/admin/login',loginLimit,(req,res)=>{
  if(!ADMIN_PASSWORD||ADMIN_PASSWORD.length<12)return res.status(503).json({error:'Задайте ADMIN_PASSWORD длиной от 12 символов в Render.'});
  if(!equal(safeString(req.body?.username,100),ADMIN_USER)||!equal(String(req.body?.password||''),ADMIN_PASSWORD))
    return res.status(401).json({error:'Неверный логин или пароль'});
  const token=crypto.randomBytes(32).toString('hex');
  sessions.set(token,{expires:Date.now()+8*60*60*1000});
  res.cookie('nk_sid',token,{httpOnly:true,secure:req.secure,sameSite:'lax',path:'/',maxAge:8*60*60*1000});
  res.json({ok:true});
});
app.post('/api/admin/logout',auth,(req,res)=>{
  const token=(req.headers.cookie||'').match(/(?:^|;\s*)nk_sid=([a-f0-9]{64})/);
  if(token)sessions.delete(token[1]);
  res.clearCookie('nk_sid',{path:'/',sameSite:'lax',secure:req.secure,httpOnly:true});res.json({ok:true});
});
app.get('/api/admin/me',auth,(req,res)=>res.json({ok:true,username:ADMIN_USER}));
app.get('/api/admin/bookings',auth,needDB,guard(async(req,res)=>{
  const status=safeString(req.query.status,30);
  const sql=statuses.includes(status)?'SELECT * FROM bookings WHERE status=$1 ORDER BY created_at DESC LIMIT 300':'SELECT * FROM bookings ORDER BY created_at DESC LIMIT 300';
  const result=await db.query(sql,statuses.includes(status)?[status]:[]);
  res.set('Cache-Control','no-store');res.json(result.rows);
}));
app.patch('/api/admin/bookings/:id',auth,needDB,guard(async(req,res)=>{
  const id=Number(req.params.id),status=safeString(req.body?.status,30);
  if(!Number.isSafeInteger(id)||id<1||!statuses.includes(status))return res.status(400).json({error:'Некорректные данные'});
  const r=await db.query('UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id,status',[status,id]);
  if(!r.rows.length)return res.sendStatus(404);
  res.json(r.rows[0]);
}));
app.delete('/api/admin/bookings/:id',auth,needDB,guard(async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.sendStatus(400);
  await db.query('DELETE FROM bookings WHERE id=$1',[id]);res.json({ok:true});
}));
app.get('/api/admin/stats',auth,needDB,guard(async(req,res)=>{
  const [totals,byService,byCity]=await Promise.all([
    db.query("SELECT count(*)::int AS total, count(*) FILTER(WHERE status='new')::int AS new_count, count(*) FILTER(WHERE created_at >= now()-interval '7 days')::int AS last_week, count(*) FILTER(WHERE status='completed')::int AS completed FROM bookings"),
    db.query('SELECT service,count(*)::int AS count FROM bookings GROUP BY service ORDER BY count DESC LIMIT 8'),
    db.query('SELECT city,count(*)::int AS count FROM bookings GROUP BY city ORDER BY count DESC LIMIT 8')
  ]);
  res.json({totals:totals.rows[0],services:byService.rows,cities:byCity.rows});
}));
function validPrices(v) {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const entries=Object.entries(v);
  if(entries.length<1||entries.length>20)return false;
  return entries.every(([id,c])=>/^[a-z][a-z0-9_-]{0,40}$/.test(id)&&typeof c?.label==='string'&&c.label.length>0&&c.label.length<=90&&
    Array.isArray(c.cards)&&c.cards.length<=30&&c.cards.every(x=>typeof x.name==='string'&&x.name.length<120&&typeof x.desc==='string'&&x.desc.length<500&&
    typeof x.service==='string'&&x.service.length<180&&Array.isArray(x.items)&&x.items.length<=120&&x.items.every(a=>Array.isArray(a)&&a.length===2&&a.every(i=>typeof i==='string'&&i.length<250))));
}
app.get('/api/admin/prices',auth,needDB,guard(async(req,res)=>{
  const r=await db.query("SELECT value FROM site_settings WHERE key='prices'");res.json(r.rows[0]?.value||defaultPrices);
}));
app.put('/api/admin/prices',auth,needDB,guard(async(req,res)=>{
  if(!validPrices(req.body)||JSON.stringify(req.body).length>150000)return res.status(400).json({error:'Некорректный формат прайса'});
  await db.query("INSERT INTO site_settings(key,value,updated_at) VALUES('prices',$1::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(req.body)]);
  res.json({ok:true});
}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:2,fields:5}});
function getMime(file){
  if(!file)return null;
  const b=file.buffer;
  if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return'image/jpeg';
  if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
  if(b.length>=12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return'image/webp';
  return null;
}
app.post('/api/admin/projects',auth,needDB,upload.fields([{name:'before',maxCount:1},{name:'after',maxCount:1}]),guard(async(req,res)=>{
  const title=safeString(req.body.title,120),category=safeString(req.body.category,100),description=safeString(req.body.description,500);
  const before=req.files?.before?.[0],after=req.files?.after?.[0],bType=getMime(before),aType=getMime(after);
  if(!title||!category||!bType||!aType)return res.status(400).json({error:'Введите название, категорию и загрузите два изображения JPG, PNG или WebP'});
  const r=await db.query('INSERT INTO projects(title,category,description,before_image,before_type,after_image,after_type) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[title,category,description,before.buffer,bType,after.buffer,aType]);
  res.status(201).json({ok:true,id:r.rows[0].id});
}));
app.delete('/api/admin/projects/:id',auth,needDB,guard(async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.sendStatus(400);
  await db.query('DELETE FROM projects WHERE id=$1',[id]);res.json({ok:true});
}));
app.get('/admin',(req,res)=>res.sendFile(path.join(root,'admin.html')));
app.get('/privacy',(req,res)=>res.sendFile(path.join(root,'privacy.html')));
app.get('/',(req,res)=>res.sendFile(path.join(root,'index.html')));
app.use('/assets',express.static(path.join(root,'assets'),{index:false,maxAge:'1d'}));
app.use((req,res)=>res.status(404).send('Not found'));
app.use((error,req,res,next)=>{
  if(error instanceof multer.MulterError)return res.status(400).json({error:'Ошибка загрузки: максимум 2 файла по 4 МБ.'});
  console.error(error.message);
  if(req.path.startsWith('/api/'))return res.status(500).json({error:'Внутренняя ошибка. Попробуйте позднее.'});
  res.status(500).send('Server error');
});
if(require.main===module)app.listen(PORT,'0.0.0.0',()=>console.log('Наш Клининг: http://0.0.0.0:'+PORT));
module.exports=app;
