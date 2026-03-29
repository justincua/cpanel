const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 3000);
const EA_TOKEN = String(process.env.EA_TOKEN || '').trim();
const PANEL_TOKEN = String(process.env.PANEL_TOKEN || '').trim();
const ADMIN_PIN = String(process.env.ADMIN_PIN || '07072000').trim();
const HEARTBEAT_TTL_MS = Number(process.env.HEARTBEAT_TTL_MS || 15000);
const COMMAND_TTL_MS = Number(process.env.COMMAND_TTL_MS || 300000);
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 43200000);
const STATE_FILE = path.join(process.cwd(), 'bridge_state.json');

const bots = new Map();
const commands = new Map();
const adminSessions = new Map();
const hiddenBots = new Set();

function nowIso(){ return new Date().toISOString(); }
function safeText(v, d=''){ return v === undefined || v === null ? d : String(v).trim(); }
function safeNum(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function randomToken(){ return crypto.randomBytes(24).toString('hex'); }
function addLog(type, message, extra={}){ console.log(JSON.stringify({ time: nowIso(), type, message, ...extra })); }
function botKeyOf({ id, bot, symbol }){ return `${safeText(id)}__${safeText(bot).toLowerCase()}__${safeText(symbol).toUpperCase()}`; }

function saveState(){
  try{
    const json = {
      bots: [...bots.entries()],
      hiddenBots: [...hiddenBots],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(json), 'utf8');
  }catch(err){
    console.error('[STATE_SAVE_ERR]', err.message);
  }
}

function loadState(){
  try{
    if(!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const json = JSON.parse(raw || '{}');
    if(Array.isArray(json.bots)){
      for(const [key, value] of json.bots) bots.set(key, value);
    }
    if(Array.isArray(json.hiddenBots)){
      for(const key of json.hiddenBots) hiddenBots.add(key);
    }
  }catch(err){
    console.error('[STATE_LOAD_ERR]', err.message);
  }
}

function authEa(req, res){
  const token = safeText(req.query.ea_token || req.body?.ea_token);
  if(!EA_TOKEN || token !== EA_TOKEN){
    res.status(401).json({ ok:false, error:'UNAUTHORIZED_EA', server_time:nowIso() });
    return false;
  }
  return true;
}
function authPanel(req, res){
  const token = safeText(req.query.token || req.body?.token);
  if(!PANEL_TOKEN || token !== PANEL_TOKEN){
    res.status(401).json({ ok:false, error:'UNAUTHORIZED_PANEL', server_time:nowIso() });
    return false;
  }
  return true;
}
function authAdminSession(req, res){
  const sessionToken = safeText(req.query.session_token || req.body?.session_token);
  const data = adminSessions.get(sessionToken);
  if(!sessionToken || !data){
    res.status(403).json({ ok:false, error:'FORBIDDEN_ADMIN_SESSION', server_time:nowIso() });
    return false;
  }
  if(Date.now() > data.expiresAt){
    adminSessions.delete(sessionToken);
    res.status(403).json({ ok:false, error:'ADMIN_SESSION_EXPIRED', server_time:nowIso() });
    return false;
  }
  data.lastSeenAt = Date.now();
  return true;
}

function publicBotShape(b){
  const updatedMs = Date.parse(b.updatedAt || nowIso());
  const ageMs = Math.max(0, Date.now() - updatedMs);
  const heartbeat_state = ageMs <= HEARTBEAT_TTL_MS ? 'online' : ageMs <= HEARTBEAT_TTL_MS * 2 ? 'slow' : 'offline';
  return {
    id: b.id,
    bot: b.bot,
    symbol: b.symbol,
    name: b.name,
    balance: b.balance,
    equity: b.equity,
    totalcapital: b.totalcapital,
    startcapital: b.startcapital,
    aftercapital: b.aftercapital,
    afterprofit: b.afterprofit,
    todaypct: b.todaypct,
    realProfit: b.realProfit,
    realPct: b.realPct,
    dayTotal: b.dayTotal,
    closedpnl: b.closedpnl,
    floatingpnl: b.floatingpnl,
    buy: b.buy,
    sell: b.sell,
    orders: b.orders,
    lots: b.lots,
    dd: b.dd,
    ddcurrent: b.ddcurrent,
    edd: b.edd,
    score: b.score,
    trend: b.trend,
    basketmode: b.basketmode,
    m5trend: b.m5trend,
    m15trend: b.m15trend,
    m30trend: b.m30trend,
    buyscore: b.buyscore,
    sellscore: b.sellscore,
    status: b.status,
    statusvi: b.statusvi,
    statusreason: b.statusreason,
    autotrade: b.autotrade,
    timeMode: b.timeMode,
    runlot1: b.runlot1,
    runlot2: b.runlot2,
    runlot3: b.runlot3,
    runlot4: b.runlot4,
    runlot5: b.runlot5,
    remotestatus: b.remotestatus,
    remotelast: b.remotelast,
    scope: b.scope,
    eaupdate: b.eaupdate,
    heartbeatms: b.heartbeatms,
    ts: b.ts,
    firstSeenAt: b.firstSeenAt,
    updatedAt: b.updatedAt,
    ageMs,
    heartbeat_state,
    hidden: hiddenBots.has(b.key),
    server_time: nowIso(),
  };
}

function upsertBotFromHeartbeat(req){
  const src = { ...req.query, ...req.body };
  const id = safeText(src.id);
  const bot = safeText(src.bot);
  const symbol = safeText(src.symbol);
  const key = botKeyOf({ id, bot, symbol });
  const prev = bots.get(key) || {};
  const next = {
    key,
    id,
    bot,
    symbol,
    name: safeText(src.name, prev.name || ''),
    balance: safeNum(src.balance, prev.balance || 0),
    equity: safeNum(src.equity, prev.equity || 0),
    totalcapital: safeNum(src.totalcapital, prev.totalcapital || safeNum(src.balance, 0)),
    startcapital: safeNum(src.startcapital, prev.startcapital || 0),
    aftercapital: safeNum(src.aftercapital, prev.aftercapital || safeNum(src.equity, 0)),
    afterprofit: safeNum(src.afterprofit, prev.afterprofit || 0),
    todaypct: safeNum(src.todaypct, prev.todaypct || 0),
    realProfit: safeNum(src.realProfit ?? src.realprofit, prev.realProfit || 0),
    realPct: safeNum(src.realPct ?? src.realpct, prev.realPct || 0),
    dayTotal: safeNum(src.dayTotal ?? src.daytotal, prev.dayTotal || 0),
    closedpnl: safeNum(src.closedpnl, prev.closedpnl || 0),
    floatingpnl: safeNum(src.floatingpnl, prev.floatingpnl || 0),
    buy: safeNum(src.buy, prev.buy || 0),
    sell: safeNum(src.sell, prev.sell || 0),
    orders: safeNum(src.orders, prev.orders || 0),
    lots: safeNum(src.lots, prev.lots || 0),
    dd: safeNum(src.dd, prev.dd || 0),
    ddcurrent: safeNum(src.ddcurrent, prev.ddcurrent || 0),
    edd: safeNum(src.edd, prev.edd || 0),
    score: safeNum(src.score, prev.score || 0),
    trend: safeText(src.trend, prev.trend || ''),
    basketmode: safeText(src.basketmode, prev.basketmode || ''),
    m5trend: safeNum(src.m5trend, prev.m5trend || 0),
    m15trend: safeNum(src.m15trend, prev.m15trend || 0),
    m30trend: safeNum(src.m30trend, prev.m30trend || 0),
    buyscore: safeNum(src.buyscore, prev.buyscore || 0),
    sellscore: safeNum(src.sellscore, prev.sellscore || 0),
    status: safeText(src.status, prev.status || ''),
    statusvi: safeText(src.statusvi, prev.statusvi || ''),
    statusreason: safeText(src.statusreason, prev.statusreason || ''),
    autotrade: safeText(src.autotrade, prev.autotrade || ''),
    timeMode: safeText(src.timeMode || src.timemode, prev.timeMode || ''),
    runlot1: safeNum(src.runlot1, prev.runlot1 || 0),
    runlot2: safeNum(src.runlot2, prev.runlot2 || 0),
    runlot3: safeNum(src.runlot3, prev.runlot3 || 0),
    runlot4: safeNum(src.runlot4, prev.runlot4 || 0),
    runlot5: safeNum(src.runlot5, prev.runlot5 || 0),
    remotestatus: safeText(src.remotestatus, prev.remotestatus || ''),
    remotelast: safeText(src.remotelast, prev.remotelast || ''),
    scope: safeText(src.scope, prev.scope || ''),
    eaupdate: safeText(src.eaupdate, prev.eaupdate || ''),
    heartbeatms: safeNum(src.heartbeatms, prev.heartbeatms || 0),
    ts: safeText(src.ts, prev.ts || String(Math.floor(Date.now()/1000))),
    firstSeenAt: prev.firstSeenAt || nowIso(),
    updatedAt: nowIso(),
    raw: src,
  };
  bots.set(key, next);
  saveState();
  return next;
}

function cleanupCommands(){
  const now = Date.now();
  for(const [key, item] of commands.entries()){
    const age = now - Date.parse(item.createdAt);
    if(item.done || age > COMMAND_TTL_MS) commands.delete(key);
  }
}
function cleanupAdminSessions(){
  const now = Date.now();
  for(const [token, item] of adminSessions.entries()){
    if(now > item.expiresAt) adminSessions.delete(token);
  }
}
setInterval(cleanupCommands, 30000).unref();
setInterval(cleanupAdminSessions, 60000).unref();

app.get('/', (_req, res) => res.json({ ok:true, service:'ea-full-heartbeat-bridge', server_time:nowIso() }));
app.get('/health', (_req, res) => {
  res.json({
    ok:true,
    bots:bots.size,
    visible_bots:[...bots.values()].filter(b => !hiddenBots.has(b.key)).length,
    hidden_bots:hiddenBots.size,
    queued_commands:[...commands.values()].filter(x => !x.done).length,
    admin_sessions:adminSessions.size,
    server_time:nowIso(),
  });
});

app.get('/ea/heartbeat', (req, res) => {
  if(!authEa(req, res)) return;
  const bot = upsertBotFromHeartbeat(req);
  addLog('heartbeat', 'EA heartbeat received', {
    id: bot.id,
    bot: bot.bot,
    symbol: bot.symbol,
    balance: bot.balance,
    equity: bot.equity,
    dayTotal: bot.dayTotal,
    dd: bot.dd,
    status: bot.status,
    timeMode: bot.timeMode,
    hidden: hiddenBots.has(bot.key),
  });
  res.json({ ok:true, server_time:nowIso(), mode:'zero_delay_bridge', bot:publicBotShape(bot) });
});

app.get('/ea/next', (req, res) => {
  if(!authEa(req, res)) return;
  const key = botKeyOf({ id:req.query.id, bot:req.query.bot, symbol:req.query.symbol });
  const item = commands.get(key);
  if(!item || item.done){
    return res.json({ ok:true, server_time:nowIso() });
  }
  item.lastPolledAt = nowIso();
  res.json({
    ok:true,
    nonce:item.nonce,
    cmd:item.cmd,
    lot1:item.lot1,
    lot2:item.lot2,
    lot3:item.lot3,
    lot4:item.lot4,
    lot5:item.lot5,
    timemode:item.timemode,
    createdAt:item.createdAt,
    server_time:nowIso(),
  });
});

app.get('/ea/ack', (req, res) => {
  if(!authEa(req, res)) return;
  const key = botKeyOf({ id:req.query.id, bot:req.query.bot, symbol:req.query.symbol });
  const nonce = safeText(req.query.nonce);
  const result = safeText(req.query.result);
  const item = commands.get(key);
  if(!item){
    return res.json({ ok:true, ack:false, reason:'NO_COMMAND', server_time:nowIso() });
  }
  if(item.nonce && nonce && item.nonce !== nonce){
    return res.json({ ok:true, ack:false, reason:'NONCE_MISMATCH', server_time:nowIso() });
  }
  item.done = true;
  item.result = result || 'done';
  item.ackedAt = nowIso();
  commands.set(key, item);
  addLog('ack', 'EA acknowledged command', { id:req.query.id, bot:req.query.bot, symbol:req.query.symbol, nonce, result:item.result });
  res.json({ ok:true, ack:true, server_time:nowIso() });
});

app.get('/panel/summary', (req, res) => {
  if(!authPanel(req, res)) return;
  const q = safeText(req.query.q).toLowerCase();
  const items = [...bots.values()]
    .filter(b => !hiddenBots.has(b.key))
    .map(publicBotShape)
    .filter(b => {
      if(!q) return true;
      return [b.id, b.bot, b.symbol, b.name].some(v => safeText(v).toLowerCase().includes(q));
    })
    .sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const totals = items.reduce((acc, b) => {
    acc.totalBots += 1;
    if(b.heartbeat_state === 'online') acc.online += 1;
    if(b.status === 'RUNNING') acc.running += 1;
    if(b.status === 'PAUSED') acc.paused += 1;
    const profit = safeNum(b.aftercapital, b.equity) - safeNum(b.startcapital, b.totalcapital || b.balance);
    const base = safeNum(b.startcapital, b.totalcapital || b.balance);
    acc.monthProfit += profit;
    acc.monthPct += base > 0 ? (profit / base) * 100 : 0;
    return acc;
  }, { totalBots:0, online:0, running:0, paused:0, monthProfit:0, monthPct:0 });
  res.json({ ok:true, items, totals, hidden:hiddenBots.size, server_time:nowIso() });
});

app.get('/panel/bot', (req, res) => {
  if(!authPanel(req, res)) return;
  const key = botKeyOf({ id:req.query.id, bot:req.query.bot, symbol:req.query.symbol });
  const item = bots.get(key);
  if(!item || hiddenBots.has(key)){
    return res.status(404).json({ ok:false, error:'BOT_NOT_FOUND', server_time:nowIso() });
  }
  res.json({ ok:true, item:publicBotShape(item), server_time:nowIso() });
});

app.post('/panel/admin/unlock', (req, res) => {
  if(!authPanel(req, res)) return;
  const pin = safeText(req.body?.pin || req.query.pin);
  if(!pin || pin !== ADMIN_PIN){
    return res.status(403).json({ ok:false, error:'WRONG_ADMIN_PIN', server_time:nowIso() });
  }
  const sessionToken = randomToken();
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(sessionToken, { createdAt:Date.now(), lastSeenAt:Date.now(), expiresAt });
  addLog('admin', 'Admin unlocked session', { expiresAt:new Date(expiresAt).toISOString() });
  res.json({
    ok:true,
    session_token:sessionToken,
    expires_at_ms:expiresAt,
    expires_at:new Date(expiresAt).toISOString(),
    server_time:nowIso(),
  });
});

app.post('/panel/admin/lock', (req, res) => {
  if(!authPanel(req, res)) return;
  const sessionToken = safeText(req.body?.session_token || req.query.session_token);
  if(sessionToken) adminSessions.delete(sessionToken);
  res.json({ ok:true, locked:true, server_time:nowIso() });
});

app.post('/panel/command', (req, res) => {
  if(!authPanel(req, res)) return;
  if(!authAdminSession(req, res)) return;
  const src = { ...req.query, ...req.body };
  const id = safeText(src.id);
  const bot = safeText(src.bot);
  const symbol = safeText(src.symbol);
  const cmd = safeText(src.cmd).toLowerCase();
  if(!id || !bot || !symbol || !cmd){
    return res.status(400).json({ ok:false, error:'MISSING_FIELDS', need:['id','bot','symbol','cmd'], server_time:nowIso() });
  }
  const key = botKeyOf({ id, bot, symbol });
  if(hiddenBots.has(key)){
    return res.status(400).json({ ok:false, error:'BOT_HIDDEN', server_time:nowIso() });
  }
  const allowed = new Set(['close_all','close_buy','close_sell','close_loss','close_loss_first','apply_lots','set_lots','time_on','time_off','mode_247']);
  if(!allowed.has(cmd)){
    return res.status(400).json({ ok:false, error:'INVALID_CMD', server_time:nowIso() });
  }
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const item = {
    id, bot, symbol, cmd, nonce,
    lot1: src.lot1 !== undefined ? safeNum(src.lot1, 0) : undefined,
    lot2: src.lot2 !== undefined ? safeNum(src.lot2, 0) : undefined,
    lot3: src.lot3 !== undefined ? safeNum(src.lot3, 0) : undefined,
    lot4: src.lot4 !== undefined ? safeNum(src.lot4, 0) : undefined,
    lot5: src.lot5 !== undefined ? safeNum(src.lot5, 0) : undefined,
    timemode: safeText(src.timemode),
    createdAt: nowIso(),
    lastPolledAt: null,
    ackedAt: null,
    result: null,
    done: false,
  };
  commands.set(key, item);
  addLog('command', 'Panel command queued', { id, bot, symbol, cmd, nonce });
  res.json({ ok:true, queued:true, item, server_time:nowIso() });
});

app.post('/panel/bot/delete', (req, res) => {
  if(!authPanel(req, res)) return;
  if(!authAdminSession(req, res)) return;
  const id = safeText(req.body?.id || req.query.id);
  const bot = safeText(req.body?.bot || req.query.bot);
  const symbol = safeText(req.body?.symbol || req.query.symbol);
  if(!id || !bot || !symbol){
    return res.status(400).json({ ok:false, error:'MISSING_FIELDS', need:['id','bot','symbol'], server_time:nowIso() });
  }
  const key = botKeyOf({ id, bot, symbol });
  hiddenBots.add(key);
  saveState();
  res.json({ ok:true, deleted:true, hidden_key:key, server_time:nowIso() });
});

app.post('/panel/bot/restore', (req, res) => {
  if(!authPanel(req, res)) return;
  if(!authAdminSession(req, res)) return;
  const id = safeText(req.body?.id || req.query.id);
  const bot = safeText(req.body?.bot || req.query.bot);
  const symbol = safeText(req.body?.symbol || req.query.symbol);
  if(!id || !bot || !symbol){
    return res.status(400).json({ ok:false, error:'MISSING_FIELDS', need:['id','bot','symbol'], server_time:nowIso() });
  }
  const key = botKeyOf({ id, bot, symbol });
  hiddenBots.delete(key);
  saveState();
  res.json({ ok:true, restored:true, hidden_key:key, server_time:nowIso() });
});

app.get('/panel/hidden', (req, res) => {
  if(!authPanel(req, res)) return;
  if(!authAdminSession(req, res)) return;
  const items = [...hiddenBots].map(key => {
    const item = bots.get(key);
    if(item) return publicBotShape(item);
    const [id, bot, symbol] = key.split('__');
    return { id, bot, symbol, hidden:true };
  });
  res.json({ ok:true, items, server_time:nowIso() });
});

app.use((req, res) => {
  res.status(404).json({ ok:false, error:'NOT_FOUND', server_time:nowIso(), path:req.path });
});

loadState();
app.listen(PORT, () => {
  console.log(`[START] server listening on ${PORT}`);
});
