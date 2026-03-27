const http = require('http');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const PANEL_TOKEN = process.env.PANEL_TOKEN || 'cua';
const EA_TOKEN = process.env.EA_TOKEN || 'cua';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

const state = {
  bots: new Map(), // key -> latest heartbeat
  cmds: new Map(), // key -> pending command
  logs: []
};

function keyOf(id, bot, symbol) {
  return [String(id||'').trim().toLowerCase(), String(bot||'').trim().toLowerCase(), String(symbol||'').trim().toLowerCase()].join('|');
}
function now() { return new Date().toISOString(); }
function send(res, code, obj, extra={}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    ...extra
  });
  res.end(body);
}
function unauthorized(res, msg='BAD_TOKEN') {
  send(res, 401, { ok:false, error:msg, server_time: now() });
}
function panelAuth(reqUrl) {
  return reqUrl.searchParams.get('token') === PANEL_TOKEN;
}
function eaAuth(reqUrl) {
  return reqUrl.searchParams.get('ea_token') === EA_TOKEN;
}
function addLog(type, data){
  state.logs.unshift({ time: now(), type, ...data });
  state.logs = state.logs.slice(0, 200);
}
function sseHeaders(res){
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': ALLOW_ORIGIN
  });
}

const clients = new Set();

function broadcast() {
  const items = [...state.bots.values()].sort((a,b)=>
    String(b.eaUpdate || b.updatedAt).localeCompare(String(a.eaUpdate || a.updatedAt))
  );
  const payload = JSON.stringify({
    ok:true,
    items,
    logs: state.logs.slice(0,30),
    server_time: now()
  });

  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = reqUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  if (path === '/ping') {
    return send(res, 200, { ok:true, server_time: now(), mode:'zero_delay_bridge' });
  }

  if (path === '/stream') {
    if (!panelAuth(reqUrl)) return unauthorized(res);

    sseHeaders(res);
    clients.add(res);

    res.write(`data: ${JSON.stringify({
      ok:true,
      items:[...state.bots.values()],
      logs: state.logs.slice(0,30),
      server_time: now()
    })}\n\n`);

    req.on('close', ()=> clients.delete(res));
    return;
  }

  if (path === '/panel/summary') {
    if (!panelAuth(reqUrl)) return unauthorized(res);
    return send(res, 200, {
      ok:true,
      items:[...state.bots.values()],
      logs: state.logs.slice(0,30),
      server_time: now()
    });
  }

  if (path === '/panel/send') {
    if (!panelAuth(reqUrl)) return unauthorized(res);

    const id = reqUrl.searchParams.get('id') || '';
    const bot = reqUrl.searchParams.get('bot') || '';
    const symbol = reqUrl.searchParams.get('symbol') || '';
    const cmd = (reqUrl.searchParams.get('cmd') || '').trim().toLowerCase();
    const nonce = String(Date.now());
    const key = keyOf(id, bot, symbol);

    const payload = {
      id,
      bot,
      symbol,
      cmd,
      nonce,
      lot1: reqUrl.searchParams.get('lot1') || '',
      lot2: reqUrl.searchParams.get('lot2') || '',
      lot3: reqUrl.searchParams.get('lot3') || '',
      lot4: reqUrl.searchParams.get('lot4') || '',
      lot5: reqUrl.searchParams.get('lot5') || '',
      timemode: reqUrl.searchParams.get('timemode') || '',
      active: true,
      acked: false,
      result: '',
      createdAt: now()
    };

    state.cmds.set(key, payload);
    addLog('panel_send', { key, cmd, nonce });
    broadcast();

    return send(res, 200, { ok:true, queued: payload, server_time: now() });
  }

  if (path === '/ea/heartbeat') {
    if (!eaAuth(reqUrl)) return unauthorized(res, 'BAD_EA_TOKEN');

    const id = reqUrl.searchParams.get('id') || '';
    const bot = reqUrl.searchParams.get('bot') || '';
    const symbol = reqUrl.searchParams.get('symbol') || '';
    const key = keyOf(id, bot, symbol);
    const prev = state.bots.get(key) || {};

    const item = {
      key,
      id,
      bot,
      symbol,
      equity: Number(reqUrl.searchParams.get('equity') || prev.equity || 0),
      balance: Number(reqUrl.searchParams.get('balance') || prev.balance || 0),
      realProfit: Number(reqUrl.searchParams.get('realProfit') || prev.realProfit || 0),
      realPct: Number(reqUrl.searchParams.get('realPct') || prev.realPct || 0),
      dayTotal: Number(reqUrl.searchParams.get('dayTotal') || prev.dayTotal || 0),
      dd: Number(reqUrl.searchParams.get('dd') || prev.dd || 0),
      status: reqUrl.searchParams.get('status') || prev.status || 'RUNNING',
      timeMode: reqUrl.searchParams.get('timeMode') || prev.timeMode || '',
      remoteStatus: reqUrl.searchParams.get('remoteStatus') || prev.remoteStatus || '',
      remoteLast: reqUrl.searchParams.get('remoteLast') || prev.remoteLast || '',
      updatedAt: now(),
      eaUpdate: now()
    };

    state.bots.set(key, item);
    broadcast();

    return send(res, 200, { ok:true, server_time: now() });
  }

  if (path === '/ea/next') {
    if (!eaAuth(reqUrl)) return unauthorized(res, 'BAD_EA_TOKEN');

    const key = keyOf(
      reqUrl.searchParams.get('id') || '',
      reqUrl.searchParams.get('bot') || '',
      reqUrl.searchParams.get('symbol') || ''
    );

    const cmd = state.cmds.get(key);
    if (!cmd || !cmd.active || cmd.acked) {
      return send(res, 200, { ok:true, server_time: now() });
    }

    return send(res, 200, { ok:true, ...cmd, server_time: now() });
  }

  if (path === '/ea/ack') {
    if (!eaAuth(reqUrl)) return unauthorized(res, 'BAD_EA_TOKEN');

    const key = keyOf(
      reqUrl.searchParams.get('id') || '',
      reqUrl.searchParams.get('bot') || '',
      reqUrl.searchParams.get('symbol') || ''
    );
    const nonce = reqUrl.searchParams.get('nonce') || '';
    const result = reqUrl.searchParams.get('result') || 'done';
    const cmd = state.cmds.get(key);

    if (cmd && cmd.nonce === nonce) {
      cmd.acked = true;
      cmd.active = false;
      cmd.result = result;
      cmd.ackAt = now();
      state.cmds.set(key, cmd);

      const bot = state.bots.get(key);
      if (bot) {
        bot.remoteStatus = 'ACK';
        bot.remoteLast = result;
        bot.updatedAt = now();
        state.bots.set(key, bot);
      }

      addLog('ea_ack', { key, nonce, result });
      broadcast();
    }

    return send(res, 200, { ok:true, server_time: now() });
  }

  send(res, 404, { ok:false, error:'NOT_FOUND', server_time: now() });
});

server.listen(PORT, HOST, () => {
  console.log(`Zero-delay bridge running on http://${HOST}:${PORT}`);
});
