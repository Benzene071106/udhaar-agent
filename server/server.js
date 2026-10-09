// Udhaar Agent: one shop's agent as a small web server. Zero dependencies (Node 18+).
// One instance = one shop. On Agent37 each shop gets its own sandbox running this file on port 8000.
//
// Environment:
//   PORT                   default 8000
//   SHOP                   demo shop to seed: gupta | balaji (default gupta)
//   DATA_DIR               where the shop's khata is saved (default ./data)
//   AGENT37_LLM_PROXY_URL  OpenAI-compatible LLM router; Agent37 sets this on every instance
//   AGENT37_MANAGED_TOKEN  bearer token for that router; Agent37 sets it and renews it on restart
//   LLM_MODEL              optional model id for the router; unset = the router's default model
//   LLM_TIMEOUT_MS         default 8000; after this the offline rules answer instead
//   REAL_CLOCK             1 = the agent's own scheduler: each new calendar day it runs the morning reminders,
//                          and at EVENING_HOUR (default 21) it sends the evening summary and cash batch
//   OTHER_SHOPS            optional "Name|https://url,Name|https://url" for the shop switcher
//
// Without the LLM variables, or when the LLM call fails, the offline Hinglish rule parser answers.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const C = require('../core/agent-core.js');

const ROOT = path.join(__dirname, '..');
const MAX_BODY = 16 * 1024;

function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function parseOtherShops(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, url] = s.split('|').map((x) => (x || '').trim());
    return /^https?:\/\//.test(url || '') ? { name, url } : null;
  }).filter(Boolean);
}

function createServer(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const shopId = C.DEMO_SHOPS[env.SHOP] ? env.SHOP : 'gupta';
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const file = path.join(dataDir, shopId + '.json');
  const llmUrl = (env.AGENT37_LLM_PROXY_URL || '').replace(/\/+$/, '');
  const model = env.LLM_MODEL || null; // null: let the router pick its default
  const timeoutMs = +env.LLM_TIMEOUT_MS || 8000;
  const others = parseOtherShops(env.OTHER_SHOPS);
  const fetchImpl = opts.fetch || globalThis.fetch;
  const today = opts.today || localToday;

  fs.mkdirSync(dataDir, { recursive: true });
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { state = null; }
  if (!state || !state.shop) { state = C.freshShop(shopId, today()); save(); }

  function save() {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  const engine = { llm: !!llmUrl, model: model || 'router default', lastError: null, llmCalls: 0, llmFallbacks: 0 };

  // The token is read at call time: Agent37 issues a new one whenever the sandbox restarts.
  async function understand(text) {
    const rules = C.parseOwnerMessage(text, state.today);
    if (!llmUrl || rules.intent === 'choice' || C.looksLikeUpiSms(text)) return rules;
    const p = C.llmRequestParts(text, state);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    engine.llmCalls++;
    try {
      const headers = { 'content-type': 'application/json' };
      if (env.AGENT37_MANAGED_TOKEN) headers.authorization = 'Bearer ' + env.AGENT37_MANAGED_TOKEN;
      const res = await fetchImpl(llmUrl + '/chat/completions', {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({
          ...(model ? { model } : {}), temperature: 0, max_tokens: 300,
          messages: [
            { role: 'system', content: p.system + '\nReply with only a JSON object with exactly these keys: intent, name, items, amount, due_date, phone. JSON schema: ' + JSON.stringify(p.schema) },
            { role: 'user', content: text }
          ]
        })
      });
      if (!res.ok) throw new Error('LLM HTTP ' + res.status);
      const j = await res.json();
      const content = (((j.choices || [])[0] || {}).message || {}).content || '';
      const m = String(content).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('LLM reply had no JSON');
      const out = JSON.parse(m[0]);
      if (p.schema.properties.intent.enum.indexOf(out.intent) < 0) throw new Error('LLM intent not allowed: ' + out.intent);
      engine.lastError = null;
      return C.intentFromLlm(out, text);
    } catch (e) {
      engine.llmFallbacks++;
      engine.lastError = e.name === 'AbortError' ? 'LLM timeout' : String(e.message || e).slice(0, 200);
      return rules;
    } finally { clearTimeout(timer); }
  }

  function snapshot(extra) {
    return Object.assign({
      state, dashboard: C.dashboard(state, 30), shopId,
      engine: { llm: engine.llm, model: engine.model, lastError: engine.lastError },
      others
    }, extra || {});
  }

  function pageHtml() {
    const html = fs.readFileSync(path.join(ROOT, 'dist/udhaar-agent-standalone.html'), 'utf8');
    const cfg = '<script>window.UDHAAR_SERVER=' + JSON.stringify({ shopId, others }).replace(/</g, '\\u003c') + ';</script>';
    return html.replace('<body>', '<body>\n' + cfg);
  }

  function send(res, code, body, type) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(buf);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      // Past the limit, keep draining (so the client still gets the 413) but stop keeping bytes.
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      req.on('end', () => size > MAX_BODY ? reject(Object.assign(new Error('body too large'), { code: 413 })) : resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // One action at a time, so two quick taps can't interleave on the same khata.
  let queue = Promise.resolve();
  function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

  async function act(action, args) {
    if (action === 'reset') { state = C.freshShop(shopId, today()); save(); return snapshot({ freshTxn: null }); }
    if (C.ACTIONS.indexOf(action) < 0) throw Object.assign(new Error('unknown action'), { code: 400 });
    const a = Object.assign({}, args);
    delete a.intent; // never trust an intent from the browser
    if (action === 'owner' && !C.looksLikeUpiSms(String(a.text || ''))) a.intent = await understand(String(a.text || '').slice(0, 500));
    let out;
    try { out = C.runAction(state, action, a); } catch (e) { throw Object.assign(e, { code: 400 }); }
    save();
    return snapshot({ freshTxn: out.freshTxn, result: out.result });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, shop: shopId, llm: engine.llm, scheduler: env.REAL_CLOCK === '1', llmCalls: engine.llmCalls, llmFallbacks: engine.llmFallbacks });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot());
      if (req.method === 'POST' && url.pathname === '/api/act') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' });
        if (+req.headers['content-length'] > MAX_BODY) { res.setHeader('connection', 'close'); return send(res, 413, { error: 'body too large' }); }
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'body too large' : 'bad JSON' }); }
        const out = await serial(() => act(String(body.action || ''), body.args || {}));
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e.code >= 400 && e.code < 500 ? e.code : 500;
      return send(res, code, { error: code === 500 ? 'server error' : e.message });
    }
  });
  // The agent's own scheduler. The demo's "Agle din" button only moves the shop's clock forward,
  // so the real date never pulls the khata backwards.
  const evening = +env.EVENING_HOUR || 21;
  const hourNow = opts.hour || (() => new Date().getHours());
  function tick() {
    const ran = [];
    return serial(() => {
      const now = today();
      for (let i = 0; i < 31 && state.today < now; i++) { C.runAction(state, 'nextDay'); ran.push('nextDay'); }
      if (hourNow() >= evening && state.eveningSentFor !== state.today && state.today === now) { C.runAction(state, 'closeDay'); ran.push('closeDay'); }
      if (ran.length) save();
      return ran;
    });
  }
  let timer = null;
  if (env.REAL_CLOCK === '1') { timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000); timer.unref(); server.on('close', () => clearInterval(timer)); }
  server.tick = tick;
  server.getState = () => state;
  server.engine = engine;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = +process.env.PORT || 8000;
  createServer().listen(port, '0.0.0.0', () => {
    console.log('Udhaar Agent (' + (process.env.SHOP || 'gupta') + ') on :' + port + ', LLM ' + (process.env.AGENT37_LLM_PROXY_URL ? 'via router' : 'off (rules only)'));
  });
}
