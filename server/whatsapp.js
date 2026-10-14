// Real WhatsApp for one shop, through Twilio (the WhatsApp Sandbox works for a demo; a WhatsApp Business number later).
//
// Inbound:  Twilio POSTs every message to /whatsapp. The owner's number talks to the agent (text or voice note);
//           any other number is a customer. A new number becomes a customer under its WhatsApp name.
// Outbound: every message the agent writes to the owner or to a customer is sent on WhatsApp, whether it came from
//           a WhatsApp message, the web page, or the scheduler. Customers get messages only after they wrote first.
//
// Environment:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   Twilio account (the token also checks that webhooks really come from Twilio)
//   TWILIO_WHATSAPP_FROM                    the shop's WhatsApp sender, e.g. whatsapp:+14155238886 (Sandbox)
//   OWNER_WHATSAPP                          the shop owner's own number, e.g. +919876543210
//   PUBLIC_URL                              this server's public https address (webhook signature check, pay links)
//   WA_JOIN_CODE                            Sandbox join words, e.g. "join shiny-tiger"; shown as a QR at /join
//   STT_URL, STT_KEY, STT_MODEL, STT_LANGUAGE   OpenAI-compatible speech-to-text for voice notes
//                                           (/audio/transcriptions; e.g. Whisper on a GPU). Unset = voice notes are refused politely.
//   ELEVENLABS_API_KEY                      customers also get each bill and reminder as a Hindi voice note (ElevenLabs);
//   ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL   unset = text only. Default model eleven_multilingual_v2.
'use strict';
const crypto = require('crypto');
const C = require('../core/agent-core.js');

const MAX_AUDIO = 16 * 1024 * 1024;
const digits = (s) => String(s || '').replace(/\D/g, '');
const phone10 = (s) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : null; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Twilio's request signature: HMAC-SHA1 of the full URL plus every POST field (sorted by name), base64. */
function twilioSignature(token, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
function sameString(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createWhatsapp(o) {
  const env = o.env, fetchImpl = o.fetch;
  const sid = env.TWILIO_ACCOUNT_SID || '', token = env.TWILIO_AUTH_TOKEN || '';
  const sender = env.TWILIO_WHATSAPP_FROM || '';
  const api = (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, '');
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const owner = phone10(env.OWNER_WHATSAPP);
  const ownerTo = digits(env.OWNER_WHATSAPP);
  const sttUrl = (env.STT_URL || '').replace(/\/+$/, '');
  const stats = { enabled: !!(token && owner), sending: !!(sid && token && sender), stt: !!sttUrl, received: 0, sent: 0, failed: 0, lastError: null };

  // ---------------------------------------------------------------- outbound
  let outQueue = Promise.resolve();
  // While a webhook is being answered, text for the person who wrote is collected and returned in the webhook's
  // TwiML reply instead of the Messages API: the Sandbox accepts a reply to an inbound message without a template
  // (the API answers 21654 "ContentSid Required" for Sandbox senders on newer accounts).
  let capture = null;
  function sendNow(to, body, mediaUrl) {
    if (capture && capture.open && to === capture.to && body && !mediaUrl) { capture.msgs.push(String(body).slice(0, 1590)); stats.sent++; return Promise.resolve(); }
    if (!stats.sending || !to) return Promise.resolve();
    const form = new URLSearchParams({ From: sender, To: 'whatsapp:+' + to });
    if (body) form.set('Body', String(body).slice(0, 1590));
    if (mediaUrl) form.set('MediaUrl', mediaUrl);
    return fetchImpl(api + '/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
      method: 'POST', body: form.toString(),
      headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }
    }).then(async (r) => {
      if (!r.ok) throw new Error('Twilio HTTP ' + r.status + ' ' + String(await r.text().catch(() => '')).slice(0, 160));
      stats.sent++;
    }).catch((e) => { stats.failed++; stats.lastError = String(e.message || e).slice(0, 200); });
  }
  // In order, one after another, so a bill never arrives after its receipt.
  function queueSend(to, body) { outQueue = outQueue.then(() => sendNow(to, body)); return outQueue; }

  // ---------------------------------------------------------------- Hindi voice notes (ElevenLabs)
  // For customers who listen more than they read: the bill and the reminder also arrive as a short voice note in the
  // shop's name. The text always goes first; if the voice fails, the text alone is enough.
  const tts = { key: env.ELEVENLABS_API_KEY || '', voice: env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM', model: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    api: (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '') };
  stats.voiceNotes = !!(tts.key && publicUrl);
  const media = new Map(); // id -> { buf, at }; kept an hour so Twilio can fetch it, never written to disk
  const MEDIA_TTL = 60 * 60 * 1000;
  function keepMedia(buf) {
    const now = Date.now();
    for (const [k, v] of media) if (now - v.at > MEDIA_TTL || media.size > 200) media.delete(k);
    const id = crypto.randomBytes(12).toString('hex');
    media.set(id, { buf, at: now });
    return id;
  }
  function getMedia(id) { const m = media.get(id); return m && Date.now() - m.at <= MEDIA_TTL ? m.buf : null; }
  const say = (n) => Math.round(n) + ' रुपये';
  const UNIT_WORD = { kg: 'kilo', g: 'gram', l: 'litre', ml: 'ml', pkt: 'packet', pc: '', pav: 'pav', dozen: 'dozen' };
  /** What the voice note says: short, in Hindi, in the shop's name. Null for messages that stay text only. */
  function voiceScript(state, m) {
    const c = state.customers.find((x) => x.id === m.to);
    if (!c) return null;
    const shop = state.shop.name, bal = Math.max(0, C.balance(state, c.id));
    if (m.kind === 'reminder' && m.amount > 0)
      return 'नमस्ते ' + c.name + '। ' + shop + ' से बोल रहे हैं। आपके खाते में ' + say(m.amount) + ' बाकी हैं। जब सुविधा हो, दुकान पर नकद या UPI से दे दीजिए। पैसे दे दिए हों तो "cash de diya" लिख दीजिए। धन्यवाद।';
    if (m.kind === 'entry-check') {
      const t = state.txns.find((x) => x.id === m.txnId);
      if (!t) return null;
      const items = (t.lines || []).filter((l) => l.price > 0).map((l) => l.name + (l.qty ? ' ' + l.qty + (l.unit ? ' ' + (UNIT_WORD[l.unit] || l.unit) : '') : '') + ', ' + say(l.price)).join('; ');
      return 'नमस्ते ' + c.name + '। ' + shop + ' से। आज आपके खाते में ' + say(t.amount) + (t.type === 'credit' ? ' उधार' : ' जमा') + ' लिखे गए' + (items ? ': ' + items : '') +
        '। कुल बाकी ' + say(bal) + '। सही है तो "हाँ" लिखिए, गलत हो तो "गलत"।';
    }
    return null;
  }
  async function speak(text) {
    const r = await fetchImpl(tts.api + '/v1/text-to-speech/' + encodeURIComponent(tts.voice) + '?output_format=mp3_44100_128', {
      method: 'POST', headers: { 'xi-api-key': tts.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: tts.model })
    });
    if (!r.ok) throw new Error('ElevenLabs HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  function queueVoice(to, script) {
    if (!stats.voiceNotes || !stats.sending || !script) return;
    outQueue = outQueue.then(async () => {
      try { const id = keepMedia(await speak(script)); stats.voiceSent = (stats.voiceSent || 0) + 1; await sendNow(to, '', publicUrl + '/media/' + id + '.mp3'); }
      catch (e) { stats.voiceFailed = (stats.voiceFailed || 0) + 1; stats.lastError = String(e.message || e).slice(0, 200); }
    });
  }

  function payToken(state, custId) {
    if (!state.paySecret) state.paySecret = crypto.randomBytes(16).toString('hex');
    return crypto.createHmac('sha256', env.PAY_SECRET || state.paySecret).update(custId).digest('hex').slice(0, 16);
  }
  function payUrl(state, custId) { return publicUrl ? publicUrl + '/pay/' + custId + '.' + payToken(state, custId) : null; }

  /** The WhatsApp version of a message: the same words, plus how to answer. */
  function waText(state, m) {
    let t = m.text;
    if (m.kind === 'entry-check' || m.kind === 'statement') t += '\n\nJawab dijiye: *Haan* ya *Galat*';
    if (m.kind === 'consent-ask') t += '\n\nJawab dijiye: *Haan* ya *Nahi*';
    if (m.kind === 'reminder' && m.amount > 0) { const u = payUrl(state, m.to); if (u) t += '\nUPI se dena ho toh: ' + u; }
    return t;
  }
  function recipient(state, to) {
    if (to === 'owner') return ownerTo || null;
    const c = state.customers.find((x) => x.id === to);
    return c && c.wa && c.phone ? (c.waTo || '91' + c.phone) : null; // only numbers that wrote to us first
  }

  /**
   * Send everything the agent wrote since `from` (an index into state.messages), then, if the owner has cash claims
   * or "galat hai" questions waiting, ask about the oldest one (one at a time, answered with haan / nahi).
   */
  function deliver(state, from, pre, opts) {
    if (!stats.enabled) return;
    const skipOwner = !!(opts && opts.skipOwner); // the owner is looking at the web page already
    for (const t of pre || []) queueSend(ownerTo, t);
    for (const m of state.messages.slice(from)) {
      if (m.from !== 'agent' || (skipOwner && m.to === 'owner')) continue;
      const to = recipient(state, m.to);
      if (to) { queueSend(to, waText(state, m)); if (m.to !== 'owner') queueVoice(to, voiceScript(state, m)); }
    }
    const next = C.pendingClaims(state)[0];
    if (next && state.waAsked !== next.id && !skipOwner) {
      state.waAsked = next.id;
      queueSend(ownerTo, '⏳ ' + C.claimLabel(state, next) + '\nJawab: *haan* ✅ ya *nahi* ❌' + (C.pendingClaims(state).length > 1 ? ' (' + C.pendingClaims(state).length + ' baaki)' : ''));
    }
  }

  // ---------------------------------------------------------------- voice notes
  async function transcribe(url, type) {
    if (!sttUrl) return null;
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)twilio\.com$/.test(u.hostname)) throw new Error('media not from Twilio');
    const r = await fetchImpl(url, { headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64') } });
    if (!r.ok) throw new Error('media HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_AUDIO) throw new Error('voice note too long');
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: type || 'audio/ogg' }), 'voice.' + ((/audio\/(\w+)/.exec(type || '') || [])[1] || 'ogg'));
    fd.append('model', env.STT_MODEL || 'whisper-1');
    if (env.STT_LANGUAGE !== 'auto') fd.append('language', env.STT_LANGUAGE || 'hi');
    // A Hinglish example nudges the model to write the way shopkeepers talk, in Roman letters.
    fd.append('prompt', 'Sharma ji ne cheeni 2 kilo 90, tel 180 liya, kal denge. Pappu 200 cash de gaya.');
    const headers = env.STT_KEY ? { authorization: 'Bearer ' + env.STT_KEY } : {};
    const s = await fetchImpl(sttUrl + '/audio/transcriptions', { method: 'POST', headers, body: fd });
    if (!s.ok) throw new Error('STT HTTP ' + s.status);
    const j = await s.json();
    return String(j.text || '').trim().slice(0, 500);
  }

  // ---------------------------------------------------------------- inbound
  /** True when the request really comes from Twilio. */
  function verify(req, params) {
    if (!token) return false;
    const url = (publicUrl || 'https://' + req.headers.host) + req.url;
    return sameString(req.headers['x-twilio-signature'], twilioSignature(token, url, params));
  }

  // The latest question this customer can answer with one word: an entry or monthly hisaab to check, or a lender's ask.
  function openQuestion(state, cust, answer) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.to !== cust.id || m.from !== 'agent') continue;
      if (m.kind === 'consent-ask') return C.consentOf(state, cust.id).status === 'requested' ? { kind: 'consent' } : null;
      if (m.kind === 'entry-check' || m.kind === 'statement') {
        if (!m.answer || (m.answer === 'auto' && answer === 'no')) return { kind: 'check', msgId: m.id };
      }
    }
    return null;
  }

  /** One inbound WhatsApp message. `act` is the server's action runner; the caller runs this one at a time. */
  async function handle(params, act, getState, save) {
    stats.received++;
    const from = phone10(params.From);
    if (!from || !stats.enabled) return;
    let text = String(params.Body || '').trim().slice(0, 500);
    const audio = +params.NumMedia > 0 && /^audio\//.test(params.MediaContentType0 || '') ? params.MediaUrl0 : null;
    const pre = [];
    let state = getState();
    let start = state.messages.length;

    if (audio) {
      let heard = null;
      try { heard = await transcribe(audio, params.MediaContentType0); } catch (e) { stats.lastError = String(e.message || e).slice(0, 200); }
      if (!heard) {
        const sorry = sttUrl ? '🎙️ Awaaz saaf samajh nahi aayi. Ek baar phir boliye, ya likh kar bhejiye 🙏' : '🎙️ Voice note abhi chalu nahi hai. Likh kar bhejiye 🙏';
        return queueSend(from === owner ? ownerTo : digits(params.From), sorry);
      }
      text = heard;
      if (from === owner) pre.push('🎙️ Suna: "' + heard + '"');
    }

    if (from === owner) {
      const open = C.pendingClaims(state), yn = C.shortAnswer(text);
      const ask = open.find((k) => k.id === state.waAsked) || open[0];
      if (yn && ask && !state.pending) await act('confirm', { claimId: ask.id, ok: yn === 'yes' });
      else if (text) await act('owner', { text, source: audio ? 'voice' : 'text' });
      state = getState();
      return deliver(state, Math.min(start, state.messages.length), pre);
    }

    const j = C.customerFromWhatsapp(state, from, params.ProfileName);
    const cust = j.cust;
    if (digits(params.From).length > 10) cust.waTo = digits(params.From);
    if (j.joined) {
      save();
      // "hi" / "join ..." only joins; a real message ("cash de diya") is also answered
      if (!text || /^(hi|hii+|hello|helo|hey|namaste|namaskar|join\b.*|start)\W*$/i.test(text)) return deliver(state, start);
    }
    const yn = C.shortAnswer(text), q = yn && openQuestion(state, cust, yn);
    if (q && q.kind === 'consent') await act('consentAnswer', { custId: cust.id, yes: yn === 'yes' });
    else if (q) await act('customerCheck', { custId: cust.id, msgId: q.msgId, ok: yn === 'yes' });
    else if (text) await act('customer', { custId: cust.id, text });
    state = getState();
    return deliver(state, Math.min(start, state.messages.length));
  }

  // ---------------------------------------------------------------- pages
  function page(title, body) {
    return '<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#1d1b16;margin:0;padding:24px 16px;display:flex;justify-content:center}main{max-width:420px;width:100%;text-align:center}' +
      'h1{font-size:22px;margin:0 0 6px}p{color:#5b564b;line-height:1.5}.amt{font-size:40px;font-weight:700;margin:12px 0}a.btn{display:block;background:#1f7a4d;color:#fff;text-decoration:none;padding:16px;border-radius:12px;font-size:18px;font-weight:600;margin:16px 0}' +
      '.qr svg{width:100%;max-width:300px;height:auto;background:#fff;padding:12px;border-radius:12px}.note{font-size:14px}</style></head><body><main>' + body + '</main></body></html>';
  }
  /** A customer's own pay page: today's baaki and a one-tap UPI button. No scanner, no typing the amount. */
  function payPage(state, ref) {
    const m = /^([A-Za-z0-9]{1,20})\.([0-9a-f]{16})$/.exec(ref || '');
    const c = m && state.customers.find((x) => x.id === m[1]);
    if (!c || !sameString(m[2], payToken(state, c.id))) return null;
    const bal = Math.max(0, Math.round(C.balance(state, c.id)));
    return page(state.shop.name, '<h1>' + esc(state.shop.name) + '</h1><p>' + esc(c.name) + ' ji, aapka baaki</p><div class="amt">' + esc(C.rupees(bal)) + '</div>' +
      (bal > 0 && state.shop.upiId ? '<a class="btn" href="' + esc(C.upiLink(state, c, bal)) + '">UPI app se dein</a>' : '') +
      '<p class="note">Cash dena ho toh dukaan par de dijiye aur WhatsApp par likhiye "cash de diya". Dono barabar hain.</p>');
  }
  /** Stage page: scan with any phone camera, WhatsApp opens with the join words typed in. */
  function joinPage(state) {
    const num = digits(sender);
    if (!num) return null;
    const link = 'https://wa.me/' + num + '?text=' + encodeURIComponent(env.WA_JOIN_CODE || 'Namaste');
    const qr = require('../vendor/qrcode-generator.js')(0, 'M');
    qr.addData(link); qr.make();
    return page('Khate se judiye', '<h1>' + esc(state.shop.name) + '</h1><p>Phone ke camera se scan kijiye. WhatsApp khulega, bas Send dabaiye.</p><div class="qr">' + qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) + '</div>' +
      (env.WA_JOIN_CODE ? '<p class="note">Jud jaane ke baad ek "hi" bhejiye. Aap is dukaan ke grahak ban jayenge.</p>' : '') + '<p class="note">' + esc(link) + '</p>');
  }

  /**
   * Handle one inbound message and return the texts meant for its sender, for the TwiML reply. After `waitMs` the
   * webhook has to answer; anything for the sender after that goes out through the Messages API as usual.
   */
  function handleForReply(params, act, getState, save, waitMs) {
    const c = { to: digits(params.From), msgs: [], open: true };
    capture = c;
    const done = handle(params, act, getState, save).then(() => outQueue);
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(r, waitMs || 12000); });
    const replied = Promise.race([done, timeout]).then(() => { clearTimeout(timer); c.open = false; if (capture === c) capture = null; return c.msgs.slice(); });
    return { replied, done };
  }
  function twiml(msgs) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response>' + msgs.map((m) => '<Message>' + esc(m) + '</Message>').join('') + '</Response>';
  }

  return { stats, verify, handle, handleForReply, twiml, deliver, payPage, joinPage, getMedia, idle: () => outQueue };
}

module.exports = { createWhatsapp, twilioSignature, phone10 };
