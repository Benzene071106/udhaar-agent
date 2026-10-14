// Real WhatsApp through Twilio: owner and customers on their own phones, voice notes, and the pay page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/server.js');
const { twilioSignature } = require('../server/whatsapp.js');
const C = require('../core/agent-core.js');

const TODAY = '2026-10-08';
const PUBLIC = 'https://gupta.example.org';
const OWNER = '+919800000001', JUDGE = '+919812345678';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }

// Stands in for Twilio's API (and a speech-to-text server): records every send.
function fakeFetch(opts) {
  opts = opts || {};
  const sent = [], calls = [];
  const f = async (url, init) => {
    url = String(url); calls.push({ url, init });
    if (url.includes('/Messages.json')) {
      const p = new URLSearchParams(init.body);
      sent.push({ to: p.get('To'), body: p.get('Body') });
      return new Response('{}', { status: 201 });
    }
    if (url.includes('/Media/')) return new Response(Buffer.from('OggS fake audio'), { status: 200 });
    if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: opts.heard || '' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  f.sent = sent; f.calls = calls;
  f.to = (num) => sent.filter((s) => s.to === 'whatsapp:' + num).map((s) => s.body);
  f.clear = () => { sent.length = 0; };
  return f;
}

function waServer(extraEnv, fetchOpts) {
  const fetch = fakeFetch(fetchOpts);
  const env = Object.assign({
    SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-wa-')),
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    OWNER_WHATSAPP: OWNER, PUBLIC_URL: PUBLIC, WA_JOIN_CODE: 'join shiny-tiger'
  }, extraEnv || {});
  const server = createServer({ env, today: () => TODAY, fetch });
  return { server, fetch };
}

// What Twilio would POST for one incoming WhatsApp message, correctly signed.
async function inbound(base, server, fields, opts) {
  const params = Object.assign({ MessageSid: 'SM' + Math.random().toString(16).slice(2), NumMedia: '0' }, fields);
  const sig = opts && opts.badSig ? 'nope' : twilioSignature('secret-token', PUBLIC + '/whatsapp', params);
  const r = await fetch(base + '/whatsapp', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params).toString() });
  await server.idle();
  return r;
}
const from = (num) => 'whatsapp:' + num;

test('the stage demo: a judge joins, gets an item-wise bill, says haan, pays cash, the owner confirms on WhatsApp', async () => {
  const { server, fetch: tw } = waServer();
  const base = await listen(server);
  try {
    // 1. a new number says hi and becomes a customer under its WhatsApp name
    let r = await inbound(base, server, { From: from(JUDGE), ProfileName: 'Rohit Sharma 🔥', Body: 'hi' });
    assert.equal(r.status, 200);
    assert.match(tw.to(JUDGE)[0], /Namaste Rohit Sharma 🙏 Aap .* khate se jud gaye/);
    assert.match(tw.to(OWNER)[0], /Rohit Sharma WhatsApp par jud gaye \(naya khata\)/);
    const rohit = server.getState().customers.find((c) => c.phone === '9812345678');
    assert.ok(rohit && rohit.wa);
    tw.clear();

    // 2. the owner speaks the bill the way they say it while packing
    await inbound(base, server, { From: from(OWNER), Body: 'Rohit ji cheeni 2 kilo 90, tel 1 litre 180' });
    assert.match(tw.to(OWNER).join('\n'), /Rohit/);
    const bill = tw.to(JUDGE).join('\n');
    assert.match(bill, /Cheeni 2 kilo = ₹90/i);
    assert.match(bill, /₹270/);
    assert.match(bill, /Jawab dijiye: \*Haan\* ya \*Galat\*/);
    tw.clear();

    // 3. one word back marks the entry as checked by the customer
    await inbound(base, server, { From: from(JUDGE), Body: 'Haan' });
    assert.match(tw.to(JUDGE)[0], /sahi bataya/);
    assert.ok(server.getState().txns.find((t) => t.custId === rohit.id && t.custOk));
    tw.clear();

    // 4. cash at the counter: the customer says so, the owner is asked right away
    await inbound(base, server, { From: from(JUDGE), Body: 'cash de diya' });
    assert.match(tw.to(JUDGE)[0], /₹270 cash note kar liya/);
    assert.match(tw.to(OWNER).pop(), /⏳ Rohit Sharma: ₹270 cash \(grahak ne bataya\)\nJawab: \*haan\* ✅ ya \*nahi\* ❌/);
    tw.clear();

    // 5. "haan" from the owner settles it; the customer gets a receipt
    await inbound(base, server, { From: from(OWNER), Body: 'haan' });
    assert.match(tw.to(OWNER)[0], /₹270 cash jama. Khata clear ✅/);
    assert.match(tw.to(JUDGE)[0], /cash mil gaya, dukaandaar ne confirm kiya/);
    assert.equal(C.balance(server.getState(), rohit.id), 0);
  } finally { server.close(); }
});

test('webhooks without a valid Twilio signature are refused, and nothing is written', async () => {
  const { server, fetch: tw } = waServer();
  const base = await listen(server);
  try {
    const r = await inbound(base, server, { From: from(OWNER), Body: 'Rohit 500 udhaar' }, { badSig: true });
    assert.equal(r.status, 403);
    assert.equal(server.getState().txns.length, 0);
    assert.equal(tw.sent.length, 0);
  } finally { server.close(); }
  // no Twilio token configured: the endpoint does not exist
  const plain = createServer({ env: { SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-wa-')) }, today: () => TODAY });
  const b2 = await listen(plain);
  try { assert.equal((await fetch(b2 + '/whatsapp', { method: 'POST', body: 'a=b' })).status, 404); } finally { plain.close(); }
});

test('an owner voice note is transcribed, echoed back, and written to the khata', async () => {
  const { server, fetch: tw } = waServer({ STT_URL: 'https://stt.example.org/v1', STT_KEY: 'k' }, { heard: 'Rohit ji ne 2 kilo cheeni li 90 rupaye' });
  const base = await listen(server);
  try {
    await inbound(base, server, { From: from(JUDGE), ProfileName: 'Rohit', Body: 'hi' });
    tw.clear();
    await inbound(base, server, { From: from(OWNER), Body: '', NumMedia: '1', MediaContentType0: 'audio/ogg', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1' });
    const toOwner = tw.to(OWNER);
    assert.equal(toOwner[0], '🎙️ Suna: "Rohit ji ne 2 kilo cheeni li 90 rupaye"');
    const stt = tw.calls.find((c) => c.url.endsWith('/audio/transcriptions'));
    assert.equal(stt.init.headers.authorization, 'Bearer k');
    assert.equal(stt.init.body.get('language'), 'hi');
    const t = server.getState().txns.pop();
    assert.equal(t.amount, 90);
    assert.equal(server.getState().messages.filter((m) => m.from === 'owner').pop().source, 'voice');
    assert.match(tw.to(JUDGE).join('\n'), /₹90/);
  } finally { server.close(); }
});

test('voice notes without speech-to-text, and media from anywhere but Twilio, are refused politely', async () => {
  const { server, fetch: tw } = waServer({ STT_URL: 'https://stt.example.org/v1' });
  const base = await listen(server);
  try {
    await inbound(base, server, { From: from(OWNER), NumMedia: '1', MediaContentType0: 'audio/ogg', MediaUrl0: 'https://evil.example.com/x.ogg' });
    assert.match(tw.to(OWNER)[0], /Awaaz saaf samajh nahi aayi/);
    assert.ok(!tw.calls.some((c) => c.url.startsWith('https://evil')));
  } finally { server.close(); }
  const s2 = waServer();
  const b2 = await listen(s2.server);
  try {
    await inbound(b2, s2.server, { From: from(OWNER), NumMedia: '1', MediaContentType0: 'audio/ogg', MediaUrl0: 'https://api.twilio.com/x/Media/ME1' });
    assert.match(s2.fetch.to(OWNER)[0], /Voice note abhi chalu nahi hai/);
  } finally { s2.server.close(); }
});

test('customers who never wrote to the shop are never messaged, and the web page does not echo to the owner', async () => {
  const { server, fetch: tw } = waServer({ SHOP: 'gupta' });
  const base = await listen(server);
  try {
    const sharma = server.getState().customers.find((c) => /sharma/i.test(c.name) && c.phone);
    assert.ok(sharma, 'the demo shop has customers with numbers typed in by the owner');
    const r = await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'owner', args: { text: sharma.name + ' ne 340 ka saaman liya' } }) });
    assert.equal(r.status, 200);
    await server.idle();
    assert.equal(tw.sent.length, 0, 'no cold messages to typed-in numbers, nothing to the owner for a web action');

    // once Sharma writes in, the next entry reaches their phone
    await inbound(base, server, { From: from('+91' + sharma.phone), ProfileName: 'S', Body: 'hi' });
    assert.match(tw.to('+91' + sharma.phone)[0], /jud gaye/);
    assert.match(tw.to(OWNER)[0], new RegExp(sharma.name + ' WhatsApp par jud gaye\\.'));
    tw.clear();
    await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'owner', args: { text: sharma.name + ' ne 60 ka doodh liya' } }) });
    await server.idle();
    assert.match(tw.to('+91' + sharma.phone).join('\n'), /₹60 udhaar/);
    assert.equal(tw.to(OWNER).length, 0);
  } finally { server.close(); }
});

test('a customer can say galat hai; the owner settles it with one word', async () => {
  const { server, fetch: tw } = waServer();
  const base = await listen(server);
  try {
    await inbound(base, server, { From: from(JUDGE), ProfileName: 'Rohit', Body: 'hi' });
    await inbound(base, server, { From: from(OWNER), Body: 'Rohit 500 udhaar' });
    tw.clear();
    await inbound(base, server, { From: from(JUDGE), Body: 'galat hai' });
    assert.match(tw.to(JUDGE)[0], /aapka sawaal dukaandaar ko bhej diya/);
    assert.match(tw.to(OWNER).join('\n'), /⏳ Rohit ne ₹500 udhaar .* ko galat bataya/);
    tw.clear();
    await inbound(base, server, { From: from(OWNER), Body: 'nahi' }); // ❌ = the owner's mistake: entry removed
    assert.match(tw.to(OWNER)[0], /Galti theek ki/);
    assert.match(tw.to(JUDGE)[0], /entry hata di gayi/);
  } finally { server.close(); }
});

test('the pay page needs the secret link, shows the live baaki, and offers cash on equal terms', async () => {
  const { server } = waServer();
  const base = await listen(server);
  try {
    await inbound(base, server, { From: from(JUDGE), ProfileName: 'Rohit', Body: 'hi' });
    await inbound(base, server, { From: from(OWNER), Body: 'Rohit 500 udhaar' });
    const st = server.getState(), c = st.customers.find((x) => x.phone === '9812345678');
    assert.equal((await fetch(base + '/pay/' + c.id + '.0000000000000000')).status, 404);
    assert.equal((await fetch(base + '/pay/' + c.id)).status, 404);
    // the link's secret is made on first use and kept with the khata
    const tok = require('crypto').createHmac('sha256', server.getState().paySecret).update(c.id).digest('hex').slice(0, 16);
    const r = await fetch(base + '/pay/' + c.id + '.' + tok);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /₹500/);
    assert.match(html, /upi:\/\/pay\?pa=/);
    assert.match(html, /cash de diya/);
    // the stage QR opens WhatsApp with the Sandbox join words typed in
    const j = await (await fetch(base + '/join')).text();
    assert.match(j, /<svg/);
    assert.match(j, /wa\.me\/14155238886\?text=join%20shiny-tiger/);
  } finally { server.close(); }
});

test('short replies: one-word yes/no only, real sentences stay sentences', () => {
  for (const s of ['haan', 'Haan ji', 'sahi hai', '✅', 'हाँ', 'ok', 'mil gaya']) assert.equal(C.shortAnswer(s), 'yes', s);
  for (const s of ['galat hai', 'Galat', 'nahi', '❌', 'गलत', 'nahi mila']) assert.equal(C.shortAnswer(s), 'no', s);
  for (const s of ['cash de diya', 'kal dunga', 'Friday tak de dunga bhai pakka', '']) assert.equal(C.shortAnswer(s), null, s);
});
