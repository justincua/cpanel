const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const EA_TOKEN = process.env.EA_TOKEN || 'cua';
const PANEL_TOKEN = process.env.PANEL_TOKEN || '07072000';

function bootFirebase() {
  const hasInline = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (hasInline) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    return;
  }

  throw new Error('Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.');
}

bootFirebase();
const db = admin.database();

function nowIso() {
  return new Date().toISOString();
}

function cleanStr(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  return String(v).trim();
}

function cleanNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function twDayKey(date = new Date()) {
  const tw = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tw.getFullYear();
  const m = String(tw.getMonth() + 1).padStart(2, '0');
  const d = String(tw.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function makeBotKey({ id, bot, symbol }) {
  const safeId = cleanStr(id, '0');
  const safeBot = cleanStr(bot, 'BOT').replace(/[.#$\[\]/]/g, '_');
  const safeSymbol = cleanStr(symbol, 'SYMBOL').replace(/[.#$\[\]/]/g, '_');
  return `${safeId}__${safeBot}__${safeSymbol}`;
}

function pickHeartbeat(query) {
  const base = {
    id: cleanStr(query.id),
    bot: cleanStr(query.bot),
    name: cleanStr(query.name),
    symbol: cleanStr(query.symbol),

    balance: cleanNum(query.balance),
    equity: cleanNum(query.equity),
    freeMargin: cleanNum(query.freeMargin),
    margin: cleanNum(query.margin),
    marginLevel: cleanNum(query.marginLevel),

    realProfit: cleanNum(query.realProfit),
    realPct: cleanNum(query.realPct),
    dayFloating: cleanNum(query.dayFloating),
    dayClosed: cleanNum(query.dayClosed),
    dayTotal: cleanNum(query.dayTotal),
    dayPct: cleanNum(query.dayPct),

    dd: cleanNum(query.dd),
    dayMaxDD: cleanNum(query.dayMaxDD),
    dayWorstEDD: cleanNum(query.dayWorstEDD),

    buyOpen: cleanNum(query.buyOpen),
    sellOpen: cleanNum(query.sellOpen),
    pairOpen: cleanNum(query.pairOpen),
    buyLotsOpen: cleanNum(query.buyLotsOpen),
    sellLotsOpen: cleanNum(query.sellLotsOpen),

    dayBuy: cleanNum(query.dayBuy),
    daySell: cleanNum(query.daySell),
    dayOrders: cleanNum(query.dayOrders),
    dayLots: cleanNum(query.dayLots),
    dayVolume: cleanNum(query.dayVolume),

    trend: cleanStr(query.trend),
    m1: cleanNum(query.m1),
    m5: cleanNum(query.m5),
    m15: cleanNum(query.m15),
    buyScore: cleanNum(query.buyScore),
    sellScore: cleanNum(query.sellScore),

    spread: cleanNum(query.spread),
    atrPts: cleanNum(query.atrPts),
    rsiM1: cleanNum(query.rsiM1),
    adxM1: cleanNum(query.adxM1),
    rsiM5: cleanNum(query.rsiM5),
    adxM5: cleanNum(query.adxM5),

    hedgeRatio: cleanNum(query.hedgeRatio),
    tpUSD: cleanNum(query.tpUSD),
    state: cleanStr(query.state),
    reason: cleanStr(query.reason),
    status: cleanStr(query.status),
    action: cleanStr(query.action),
    autoTrade: cleanStr(query.autoTrade),
    cooldown: cleanStr(query.cooldown),
    targetReached: cleanStr(query.targetReached),

    eaTs: cleanNum(query.ts),
  };

  base.botKey = makeBotKey(base);
  base.dayKey = twDayKey();
  base.serverTime = nowIso();
  base.heartbeatAt = Date.now();
  base.isAlive = true;
  return base;
}

async function getMergedManual(botKey) {
  const snap = await db.ref(`manual/${botKey}`).get();
  return snap.exists() ? snap.val() : {};
}

async function getIgnored(botKey) {
  const snap = await db.ref(`ignoredBots/${botKey}`).get();
  return !!snap.val();
}

async function pruneRecent(botKey, keep = 200) {
  const ref = db.ref(`bots/${botKey}/recentHeartbeats`).orderByKey().limitToLast(keep + 50);
  const snap = await ref.get();
  if (!snap.exists()) return;
  const keys = Object.keys(snap.val() || {});
  if (keys.length <= keep) return;
  const removeKeys = keys.slice(0, keys.length - keep);
  const updates = {};
  for (const k of removeKeys) updates[`bots/${botKey}/recentHeartbeats/${k}`] = null;
  await db.ref().update(updates);
}

app.get('/', (_req, res) => {
  res.json({ ok: true, mode: 'firebase-bridge', server_time: nowIso() });
});

app.get('/ea/heartbeat', async (req, res) => {
  try {
    if (cleanStr(req.query.ea_token) !== EA_TOKEN) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', server_time: nowIso() });
    }

    const hb = pickHeartbeat(req.query);
    if (!hb.id || !hb.bot || !hb.symbol) {
      return res.status(400).json({ ok: false, error: 'MISSING_ID_BOT_SYMBOL', server_time: nowIso() });
    }

    if (await getIgnored(hb.botKey)) {
      return res.json({ ok: true, ignored: true, botKey: hb.botKey, server_time: nowIso() });
    }

    const manual = await getMergedManual(hb.botKey);
    const display = { ...hb, ...(manual.liveOverrides || {}) };

    const updates = {};
    updates[`bots/${hb.botKey}/live`] = display;
    updates[`bots/${hb.botKey}/meta`] = {
      botKey: hb.botKey,
      id: hb.id,
      bot: hb.bot,
      symbol: hb.symbol,
      name: hb.name,
      updatedAt: hb.serverTime,
      updatedTs: hb.heartbeatAt,
    };
    updates[`bots/${hb.botKey}/days/${hb.dayKey}`] = {
      id: hb.id,
      bot: hb.bot,
      symbol: hb.symbol,
      name: hb.name,
      balance: hb.balance,
      equity: hb.equity,
      realProfit: hb.realProfit,
      realPct: hb.realPct,
      dayFloating: hb.dayFloating,
      dayClosed: hb.dayClosed,
      dayTotal: hb.dayTotal,
      dayPct: hb.dayPct,
      dd: hb.dd,
      dayMaxDD: hb.dayMaxDD,
      dayWorstEDD: hb.dayWorstEDD,
      dayBuy: hb.dayBuy,
      daySell: hb.daySell,
      dayOrders: hb.dayOrders,
      dayLots: hb.dayLots,
      dayVolume: hb.dayVolume,
      buyOpen: hb.buyOpen,
      sellOpen: hb.sellOpen,
      pairOpen: hb.pairOpen,
      state: hb.state,
      reason: hb.reason,
      status: hb.status,
      trend: hb.trend,
      updatedAt: hb.serverTime,
      updatedTs: hb.heartbeatAt,
    };

    const recentKey = String(hb.heartbeatAt);
    updates[`bots/${hb.botKey}/recentHeartbeats/${recentKey}`] = hb;
    updates[`indexes/byAccount/${hb.id}/${hb.botKey}`] = true;
    updates[`indexes/byBotName/${hb.bot}/${hb.botKey}`] = true;
    updates[`lastHeartbeat/${hb.botKey}`] = hb.serverTime;

    await db.ref().update(updates);
    pruneRecent(hb.botKey).catch(() => {});

    res.json({ ok: true, botKey: hb.botKey, saved: true, server_time: nowIso() });
  } catch (error) {
    console.error('/ea/heartbeat error', error);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: error.message, server_time: nowIso() });
  }
});

app.get('/ea/next', async (req, res) => {
  try {
    if (cleanStr(req.query.ea_token) !== EA_TOKEN) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', server_time: nowIso() });
    }

    const botKey = makeBotKey(req.query);
    const snap = await db.ref(`commands/${botKey}`).orderByChild('status').equalTo('queued').limitToFirst(1).get();
    if (!snap.exists()) {
      return res.json({ ok: true, cmd: '', server_time: nowIso() });
    }

    const data = snap.val();
    const [nonce, item] = Object.entries(data)[0];
    await db.ref(`commands/${botKey}/${nonce}/status`).set('sent');
    await db.ref(`commands/${botKey}/${nonce}/sentAt`).set(nowIso());

    res.json({
      ok: true,
      nonce,
      cmd: item.cmd || '',
      timemode: item.timemode || '',
      createdAt: item.createdAt || '',
      server_time: nowIso(),
    });
  } catch (error) {
    console.error('/ea/next error', error);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: error.message, server_time: nowIso() });
  }
});

app.get('/ea/ack', async (req, res) => {
  try {
    if (cleanStr(req.query.ea_token) !== EA_TOKEN) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', server_time: nowIso() });
    }

    const botKey = makeBotKey(req.query);
    const nonce = cleanStr(req.query.nonce);
    if (!nonce) {
      return res.status(400).json({ ok: false, error: 'MISSING_NONCE', server_time: nowIso() });
    }

    await db.ref(`commands/${botKey}/${nonce}`).update({
      status: 'acked',
      result: cleanStr(req.query.result),
      ackAt: nowIso(),
    });

    res.json({ ok: true, botKey, nonce, server_time: nowIso() });
  } catch (error) {
    console.error('/ea/ack error', error);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: error.message, server_time: nowIso() });
  }
});

app.get('/panel/summary', async (req, res) => {
  try {
    if (cleanStr(req.query.token) !== PANEL_TOKEN) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', server_time: nowIso() });
    }

    const snap = await db.ref('bots').get();
    const raw = snap.val() || {};
    const items = Object.keys(raw).map((botKey) => ({ botKey, ...(raw[botKey].live || {} ) }));
    items.sort((a, b) => (b.updatedTs || 0) - (a.updatedTs || 0));

    res.json({ ok: true, items, count: items.length, server_time: nowIso() });
  } catch (error) {
    console.error('/panel/summary error', error);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: error.message, server_time: nowIso() });
  }
});

app.post('/panel/cmd', async (req, res) => {
  try {
    const token = cleanStr(req.body.token || req.query.token);
    if (token !== PANEL_TOKEN) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', server_time: nowIso() });
    }

    const botKey = cleanStr(req.body.botKey || req.query.botKey);
    const cmd = cleanStr(req.body.cmd || req.query.cmd);
    const timemode = cleanStr(req.body.timemode || req.query.timemode);
    if (!botKey || !cmd) {
      return res.status(400).json({ ok: false, error: 'MISSING_BOTKEY_OR_CMD', server_time: nowIso() });
    }

    const nonce = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await db.ref(`commands/${botKey}/${nonce}`).set({
      cmd,
      timemode,
      status: 'queued',
      createdAt: nowIso(),
    });

    res.json({ ok: true, botKey, nonce, server_time: nowIso() });
  } catch (error) {
    console.error('/panel/cmd error', error);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: error.message, server_time: nowIso() });
  }
});

app.listen(PORT, () => {
  console.log(`Firebase bridge running on :${PORT}`);
});
