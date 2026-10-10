/*
 * Udhaar Agent core: one instance of this state = one shop's agent.
 * Pure JS, no dependencies. Runs in the browser (window.UdhaarCore) and in Node (require).
 *
 * Pipeline: owner message (voice transcript or text, Hindi / Hinglish / English)
 *   -> parseOwnerMessage() (rule-based; an LLM parser can produce the same intent shape)
 *   -> applyIntent() mutates the ledger and returns messages to send
 * Plus: UPI notification matching, scheduled reminders, evening summary, credit scores.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UdhaarCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- dates
  const DAY = 86400000;
  const toDate = (iso) => new Date(iso + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (isoStr, n) => iso(new Date(toDate(isoStr).getTime() + n * DAY));
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY); // b - a
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS_HI = ['Ravivar', 'Somvar', 'Mangalvar', 'Budhvar', 'Guruvar', 'Shukravar', 'Shanivar'];
  const fmtDate = (isoStr) => { const d = toDate(isoStr); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
  const fmtDay = (isoStr) => WEEKDAYS_HI[toDate(isoStr).getUTCDay()] + ' (' + fmtDate(isoStr) + ')';
  const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

  // ------------------------------------------------- Devanagari -> Latin
  const DV_VOWELS = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऋ': 'ri', 'ऑ': 'o' };
  const DV_MATRAS = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ृ': 'ri', 'ॉ': 'o' };
  const DV_CONS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
    'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'k', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y'
  };
  const DV_DIGITS = '०१२३४५६७८९';
  function transliterate(text) {
    let out = '';
    const chars = Array.from(text.normalize('NFC'));
    for (let i = 0; i < chars.length; i++) {
      let c = chars[i];
      if (chars[i + 1] === '़' && DV_CONS[c + '़']) { c = c + '़'; i++; }
      else if (chars[i + 1] === '़') i++;
      const di = DV_DIGITS.indexOf(c);
      if (di >= 0) { out += di; continue; }
      if (DV_VOWELS[c]) { out += DV_VOWELS[c]; continue; }
      if (DV_MATRAS[c]) { out += DV_MATRAS[c]; continue; }
      if (c === 'ं' || c === 'ँ') { out += 'n'; continue; }
      if (c === 'ः') { out += 'h'; continue; }
      if (c === '्') continue;
      if (c === '।' || c === '॥') { out += '.'; continue; }
      if (DV_CONS[c]) {
        out += DV_CONS[c];
        const next = chars[i + 1];
        const nextIsMark = next && (DV_MATRAS[next] || next === '्' || next === '़');
        if (!nextIsMark) {
          // inherent vowel, dropped at the end of a word (schwa deletion)
          const endOfWord = !next || !/[ऀ-ॿ]/.test(next);
          if (!endOfWord) out += 'a';
        }
        continue;
      }
      out += c;
    }
    return out;
  }

  // phonetic normalisation so "Sharmaa", "sharma", "शर्मा" all match
  function normWord(w) {
    return w.toLowerCase()
      .replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u')
      .replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/ph/g, 'f')
      .replace(/ck/g, 'k').replace(/([a-z])\1+/g, '$1');
  }

  function tokenize(text) {
    const t = transliterate(String(text))
      .replace(/₹/g, ' rs ')
      .replace(/(\d),(?=\d)/g, '$1')
      .replace(/(\d)(?=[a-zA-Z])/g, '$1 ')
      .replace(/([a-zA-Z])(?=\d)/g, '$1 ')
      .replace(/[^a-zA-Z0-9.@\s]/g, ' ')
      .replace(/\.(?!\d)/g, ' ');
    let display = t.split(/\s+/).filter(Boolean);
    // words that came from Devanagari read better without doubled final vowels: "pappoo" -> "pappu", "aataa" -> "aata"
    if (/[\u0900-\u097F]/.test(String(text))) display = display.map((w) => w.replace(/aa$/, 'a').replace(/oo$/, 'u').replace(/ee$/, 'i'));
    const norm = display.map(normWord);
    return { display, norm, text: ' ' + norm.join(' ') + ' ' };
  }

  // ------------------------------------------------------------ lexicon
  const HONORIFICS = new Set(['ji', 'jee', 'bhai', 'bhaiya', 'bhaya', 'didi', 'aunty', 'anti', 'aunti', 'uncle', 'ankal', 'sahab', 'saheb', 'sab', 'sir', 'madam', 'mam', 'seth', 'ben', 'bahen', 'behen', 'chacha', 'chachi', 'mama', 'mami', 'kaka', 'kaki', 'dada', 'dadi', 'babu', 'bhabhi', 'bhabi', 'mausi', 'bhau', 'kaku', 'tai', 'amma']
    .map(normWord));
  const STOP = new Set(('aj abhi bhai are arey arre ha han haan ok okay acha accha suno sun vo voh yeh ye please plz aur or phir fir to toh ' +
    'hamare apne mere mera meri hamara vala vale vali wala wale wali hai h he hain tha thi the ho hoga hogi hua hui ' +
    'kitna kitne kitni baki baaki bakaya balance hisab hisaab khata khate khatha dikha dikhao batao bata bolo bol ' +
    'ne ko ka ki ke se me mein mai main par pe tak liye liya lie le lekar gaya gaye gai gayi diya diye die di de do dena dega degi denge dunga ' +
    'saman samaan saaman sauda udhar udhaar udhari credit likh likho likhna likhdo jama chuka chukaya chukta vapas wapas lauta lautaya ' +
    'payment paid pay kiya kiye kie kar karo kardo clear received mil mila mile bhej bheja bheje bhejo ' +
    'yad yaad remind reminder tagada takaja message msg sabko sab sabka sabhi total kul kon kaun list summary report ' +
    'galti galat cancel undo hata hatao delete mita number no phone mobile lo lena dena ' +
    'rs rupe rupaye rupaya rupay rupees rupee inr kal parso parson parason din hafte hafta mahine mahina agle next tarikh tarik date ' +
    'took bought gave paid owes has have the a an for of from to on by is was rupees worth items stuff things today tomorrow week ' +
    'somvar mangalvar budhvar guruvar shukravar shanivar ravivar itvar monday tuesday wednesday thursday friday saturday sunday ' +
    'subah sham shaam rat raat dopahar ek do tin teen char panch chhe sat aath ath nau das sau hajar hazar dedh dhai sade sadhe ' +
    'hundred thousand one two three four five six seven eight nine ten hello hi namaste namaskar help madad kya')
    .split(/\s+/).map(normWord));

  const RX = {
    undo: /\s(galti|galat|cancel|undo|hata do|hatao|hata dena|delete|mita do)\s/,
    help: /^\s(help|madad|hi|hello|namaste|namaskar|kya kar sakte)\s/,
    remind: /\s(yad|remind|reminder|tagada|takaja|message bhej|msg bhej|bol do|yad dila)\s/,
    all: /\s(sab|sabka|sabko|sabhi|total|kul|kon kon|kaun kaun|list|summary|report|aj ka hisab|pura hisab|sare)\s/,
    query: /\s(kitna|kitne|hisab|baki|balance|bakaya|dikha|dikhao|batao|owes|how much)\s/,
    strongPay: /\s(cash|nakad|nakd|nagad|naqad|jama|chuka|chukaya|chukta|vapas|lauta|lautaya|lotaya|payment|paid|clear|received|mil gaya|mil gaye|mil gai|mil gae|bhej diya|bhej diye|bhej die|gave|pay kiya|pay kar diya|pay kar die)\s/,
    credit: /\s(liya|liye|lie|le gaya|le gaye|le gai|le gae|le gayi|le liya|saman|samaan|sauda|udhar|udhari|khate me|khate mein|khata me|likh|likho|likh do|likhdo|credit|bought|took|uthaya|le ke gaya|lekar gaya|leke gaya)\s/,
    weakPay: /\s(de diya|de diye|de die|de dia|de gaya|de gaye|de gae|de gai|de gayi|diye|diya|die|dia)\s/
  };

  // ------------------------------------------------------------ numbers
  const NUMWORDS = {
    ek: 1, one: 1, do: 2, two: 2, tin: 3, three: 3, char: 4, four: 4, panch: 5, five: 5, chhe: 6, che: 6, chah: 6, six: 6,
    sat: 7, seven: 7, ath: 8, eight: 8, nau: 9, nine: 9, das: 10, ten: 10, gyarah: 11, barah: 12, terah: 13, chaudah: 14,
    pandrah: 15, solah: 16, satrah: 17, atharah: 18, unis: 19, bis: 20, twenty: 20, pachis: 25, tis: 30, thirty: 30,
    chalis: 40, forty: 40, pachas: 50, fifty: 50, satar: 70, asi: 80, nabe: 90
  };
  const MULT = { sau: 100, hundred: 100, hajar: 1000, thousand: 1000, k: 1000 };

  const UNITS = /^(kilo|kg|kilogram|gram|gm|g|ltr|litre|liter|lit|l|ml|packet|paket|pkt|dozen|darjan|darjen|piece|pis|pcs|pc|bori|bag|bottle|botal|katta|pav|pau|ader|adha|dibba|dabba|box|tray|kartan|carton)$/;
  const MONEY_AFTER = /^(ka|ke|ki|rs|rupe|rupaye|rupaya|rupay|rupees|rupee|inr)$/;
  function extractAmount(tok, skipIdx) {
    const n = tok.norm;
    // digits first: prefer a number marked as money ("340 ka", "rs 340"), never a quantity ("2 kilo")
    const cands = [];
    for (let i = 0; i < n.length; i++) {
      if (skipIdx.has(i)) continue;
      const m = /^(\d+(?:\.\d+)?)$/.exec(n[i]);
      if (!m) continue;
      if (/^\d{10,}$/.test(m[1])) continue; // phone numbers
      let v = parseFloat(m[1]);
      const nx = n[i + 1] || '', pv = n[i - 1] || '';
      if (UNITS.test(nx)) continue;
      let score = 0;
      if (MULT[nx]) { v *= MULT[nx]; score += 1; }
      const after = MULT[nx] ? (n[i + 2] || '') : nx;
      if (MONEY_AFTER.test(after) || /^(rs|inr)$/.test(pv)) score += 2;
      cands.push({ amount: v, idx: i, score });
    }
    if (cands.length) { cands.sort((a, b) => b.score - a.score || b.amount - a.amount); return cands[0]; }
    // number words, only when anchored by sau/hajar or followed by rs/rupaye
    let total = 0, cur = 0, started = false, anchored = false, half = 0, start = -1;
    for (let i = 0; i < n.length; i++) {
      const w = n[i];
      if (w === 'sade' || w === 'sadhe') { half = 0.5; started = true; if (start < 0) start = i; continue; }
      if (w === 'dedh') { cur = 1.5; started = true; if (start < 0) start = i; continue; }
      if (w === 'dhai') { cur = 2.5; started = true; if (start < 0) start = i; continue; }
      if (NUMWORDS[w] != null) { cur += NUMWORDS[w] + half; half = 0; started = true; if (start < 0) start = i; continue; }
      if (MULT[w] && started) {
        if (MULT[w] === 1000) { total += (cur || 1) * 1000; cur = 0; } else { cur = (cur || 1) * 100; }
        anchored = true; continue;
      }
      if (started) {
        if (/^(rs|rupe|rupaye|rupaya|rupay|rupees|rupee)$/.test(w)) anchored = true;
        if (anchored) return { amount: total + cur, idx: start };
        total = 0; cur = 0; started = false; half = 0; start = -1;
      }
    }
    if (started && anchored) return { amount: total + cur, idx: start };
    return null;
  }

  // ---------------------------------------------------------- due dates
  const WEEKDAY_WORDS = [
    [/\s(ravivar|itvar|etvar|sunday)\s/, 0], [/\s(somvar|monday)\s/, 1], [/\s(mangalvar|mangal|tuesday)\s/, 2],
    [/\s(budhvar|budh|wednesday)\s/, 3], [/\s(guruvar|brihaspativar|virvar|thursday)\s/, 4],
    [/\s(shukravar|shukra|friday)\s/, 5], [/\s(shanivar|shani|saturday)\s/, 6]
  ];
  function extractDue(tok, today) {
    const t = tok.text, n = tok.norm, skip = new Set();
    let m;
    for (let i = 0; i < n.length; i++) {
      if (/^\d{1,2}$/.test(n[i]) && /^(tarikh|tarik|tarakh|date)$/.test(n[i + 1] || '')) {
        const day = parseInt(n[i], 10); skip.add(i);
        const d = toDate(today);
        let target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
        if (iso(target) <= today) target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day));
        return { due: iso(target), skip };
      }
      if (/^\d{1,2}$/.test(n[i]) && /^(din|days|day)$/.test(n[i + 1] || '')) {
        skip.add(i); return { due: addDays(today, parseInt(n[i], 10)), skip };
      }
    }
    for (const [rx, wd] of WEEKDAY_WORDS) if (rx.test(t)) {
      let diff = (wd - toDate(today).getUTCDay() + 7) % 7; if (diff === 0) diff = 7;
      return { due: addDays(today, diff), skip };
    }
    if (/\s(kal|tomorrow)\s/.test(t)) return { due: addDays(today, 1), skip };
    if (/\s(parso|parson|parason)\s/.test(t)) return { due: addDays(today, 2), skip };
    if (/\s(agle hafte|next week|ek hafte|hafte me|hafte bad|hafta)\s/.test(t)) return { due: addDays(today, 7), skip };
    if ((m = /\s(mahine ke end|mahine ke ant|month end|salary)\s/.exec(t))) {
      const d = toDate(today); return { due: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))), skip };
    }
    if (/\s(agle mahine|next month|mahine me|mahine bad)\s/.test(t)) return { due: addDays(today, 30), skip };
    return { due: null, skip };
  }

  // -------------------------------------------------------------- names
  const PARTICLES = ['ne', 'ko', 'ka', 'ki', 'ke', 'se', 'took', 'paid', 'bought', 'gave', 'owes', 'has'];
  const isNameish = (w) => /^[a-z]{2,}$/.test(w) && (!STOP.has(w) || HONORIFICS.has(w));
  function extractName(tok) {
    const n = tok.norm, d = tok.display;
    const grab = (end) => {
      let s = end;
      while (s > 0 && end - s < 3 && isNameish(n[s - 1])) s--;
      const words = n.slice(s, end);
      if (!words.some((w) => !HONORIFICS.has(w))) return null;
      return { start: s, end, display: d.slice(s, end), norm: words };
    };
    for (const p of PARTICLES) {
      for (let i = 0; i < n.length; i++) if (n[i] === p) { const g = grab(i); if (g) return g; }
    }
    // no particle: first run of name-ish words
    for (let i = 0; i < n.length; i++) if (isNameish(n[i]) && !HONORIFICS.has(n[i])) {
      let e = i; while (e < n.length && e - i < 3 && isNameish(n[e])) { e++; if (HONORIFICS.has(n[e - 1])) break; }
      return { start: i, end: e, display: d.slice(i, e), norm: n.slice(i, e) };
    }
    return null;
  }
  const nameKey = (normWords) => {
    const core = normWords.filter((w) => !HONORIFICS.has(w));
    return (core.length ? core : normWords).join(' ');
  };
  const prettyName = (displayWords) => displayWords.map((w) => {
    const lw = w.toLowerCase();
    return HONORIFICS.has(normWord(lw)) ? lw : lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');

  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  function findCustomers(state, key) {
    if (!key) return [];
    const exact = state.customers.filter((c) => c.key === key);
    if (exact.length) return exact;
    const kt = key.split(' ');
    const partial = state.customers.filter((c) => {
      const ct = c.key.split(' ');
      return kt.every((w) => ct.includes(w)) || ct.every((w) => kt.includes(w));
    });
    if (partial.length) return partial;
    return state.customers.filter((c) => {
      const tol = key.length >= 7 ? 2 : key.length >= 4 ? 1 : 0;
      const ct = c.key.split(' ');
      const close = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && lev(a, b) <= (a.length >= 7 ? 2 : 1));
      return lev(c.key, key) <= tol || kt.every((k) => ct.some((w) => close(w, k))) || ct.every((w) => kt.some((k) => close(w, k)));
    });
  }

  // -------------------------------------------------------------- items
  /** What was bought: words that are not the name, amount, date or grammar ("2 kilo cheeni, tel"). */
  function extractItems(tok, used) {
    const n = tok.norm, d = tok.display, parts = [];
    let cur = [];
    const flush = () => { if (cur.length) parts.push(cur.join(' ')); cur = []; };
    for (let i = 0; i < n.length; i++) {
      const w = n[i];
      if (used.has(i)) { flush(); continue; }
      if (w === 'aur' || w === 'and' || w === 'or') { flush(); continue; }
      if (/^\d+(\.\d+)?$/.test(w) && UNITS.test(n[i + 1] || '')) { cur.push(d[i]); continue; }
      if (UNITS.test(w) && /^\d/.test(n[i - 1] || '')) { cur.push(d[i].toLowerCase()); continue; }
      if (/^[a-z]{2,}$/.test(w) && !STOP.has(w) && !HONORIFICS.has(w) && !MULT[w] && NUMWORDS[w] == null) { cur.push(d[i].toLowerCase()); continue; }
      flush();
    }
    flush();
    return parts.join(', ');
  }

  // -------------------------------------------------------------- parse
  /** Rule-based parser. Returns an intent object; an LLM parser should return the same shape. */
  function parseOwnerMessage(text, today) {
    const tok = tokenize(text);
    const t = tok.text;
    const dueInfo = extractDue(tok, today);
    const amt = extractAmount(tok, dueInfo.skip);
    const nm = extractName(tok);
    const phone = (/\b([6-9]\d{9})\b/.exec(tok.norm.join(' ')) || [])[1] || null;
    const used = new Set(dueInfo.skip);
    if (nm) for (let i = nm.start; i < nm.end; i++) used.add(i);
    if (amt) { used.add(amt.idx); if (MULT[tok.norm[amt.idx + 1]]) used.add(amt.idx + 1); }
    const out = {
      items: extractItems(tok, used),
      intent: 'unknown', name: nm ? prettyName(nm.display) : null, nameKey: nm ? nameKey(nm.norm) : null,
      amount: amt ? amt.amount : null, dueDate: dueInfo.due, phone, raw: text, parser: 'rules'
    };
    if (/^\s*(\d{1,2})\s*$/.test(text)) { out.intent = 'choice'; out.choice = parseInt(text, 10); return out; }
    if (RX.undo.test(t)) out.intent = 'undo';
    else if (phone && out.name) out.intent = 'set_phone';
    else if (RX.remind.test(t)) out.intent = out.name && !RX.all.test(t) ? 'remind' : 'remind_all';
    else if (out.amount != null && out.amount > 0) {
      if (RX.strongPay.test(t)) out.intent = 'payment';
      else if (RX.credit.test(t)) out.intent = 'credit';
      else if (RX.weakPay.test(t) && /\sne\s/.test(t)) out.intent = 'payment';
      else out.intent = out.name ? 'credit' : 'unknown';
    } else if (RX.all.test(t)) out.intent = 'summary';
    else if (RX.query.test(t)) out.intent = out.name ? 'query' : 'summary';
    else if (RX.help.test(t)) out.intent = 'help';
    else if (dueInfo.due && out.name) out.intent = 'promise';
    if (out.intent === 'summary' && out.name && RX.query.test(t) && !RX.all.test(t)) out.intent = 'query';
    return out;
  }

  // -------------------------------------------------------------- state
  function createState(opts) {
    opts = opts || {};
    return {
      version: 1,
      shop: Object.assign({ id: 'shop-001', name: 'Gupta Kirana Store', owner: 'Rakesh Gupta', upiId: 'guptakirana@upi', defaultDays: 7, tone: 'polite' }, opts.shop || {}),
      today: opts.today || iso(new Date()),
      seqs: {},
      customers: [], txns: [], messages: [], log: [], pending: null, seenUpiRefs: [], lastAction: null, cashClaims: [], eveningSentFor: null
    };
  }
  const nextId = (state, p) => { state.seqs = state.seqs || {}; state.seqs[p] = (state.seqs[p] || 0) + 1; return p + String(state.seqs[p]).padStart(3, '0'); };

  function balance(state, custId) {
    let b = 0;
    for (const t of state.txns) if (t.custId === custId && !t.voided) b += t.type === 'credit' ? t.amount : -t.amount;
    return Math.round(b * 100) / 100;
  }
  const totalOutstanding = (state) => state.customers.reduce((s, c) => s + Math.max(0, balance(state, c.id)), 0);

  const claims = (state) => (state.cashClaims = state.cashClaims || []);
  /** Cash the customer says they paid, waiting for the owner's tap. Not counted in the balance until confirmed. */
  const pendingCash = (state, custId) => claims(state).filter((k) => k.custId === custId && k.status === 'pending' && k.type !== 'credit' && k.type !== 'check').reduce((s, k) => s + k.amount, 0);

  function addCustomer(state, name, key, extra) {
    const c = Object.assign({ id: nextId(state, 'C'), name, key, phone: null, vpas: [], dueDate: null, lastReminder: null, reminderLevel: 0, createdAt: state.today }, extra || {});
    state.customers.push(c);
    return c;
  }
  const getCust = (state, id) => state.customers.find((c) => c.id === id);

  function emit(state, out, to, text, meta) {
    const msg = Object.assign({ id: nextId(state, 'M'), to, from: 'agent', text, date: state.today, ts: Date.now() }, meta || {});
    state.messages.push(msg); out.push(msg); return msg;
  }
  function log(state, kind, text) { state.log.push({ date: state.today, ts: Date.now(), kind, text }); }

  function upiLink(state, c, amount) {
    return 'upi://pay?pa=' + encodeURIComponent(state.shop.upiId) + '&pn=' + encodeURIComponent(state.shop.name) +
      '&am=' + Math.round(amount) + '&cu=INR&tn=' + encodeURIComponent('UDH-' + c.id);
  }

  // ---------------------------------------------------- apply an intent
  function recordOwnerMessage(state, text, source) {
    state.messages.push({ id: nextId(state, 'M'), to: 'agent', from: 'owner', text, source: source || 'text', date: state.today, ts: Date.now() });
  }

  function applyIntent(state, intent) {
    const out = [];
    const reply = (text, meta) => emit(state, out, 'owner', text, meta);

    // answer to a pending "which one?" question
    if (state.pending && (intent.intent === 'choice' || intent.intent === 'unknown' || intent.intent === 'query')) {
      const p = state.pending;
      let chosen = null;
      if (intent.intent === 'choice' && intent.choice >= 1 && intent.choice <= p.options.length) chosen = p.options[intent.choice - 1];
      else if (intent.nameKey) { const f = findCustomers(state, intent.nameKey).filter((c) => p.options.includes(c.id)); if (f.length === 1) chosen = f[0].id; }
      if (intent.intent === 'choice' && p.allowNew && intent.choice === p.options.length + 1) chosen = '__new__';
      if (chosen) {
        state.pending = null;
        if (p.type === 'upi') return out.concat(settleUpi(state, p.upi, getCust(state, chosen), 'owner-confirmed'));
        const a = p.action;
        if (chosen === '__new__') { const c = addCustomer(state, a.name, a.nameKey); return out.concat(execute(state, Object.assign({}, a), c, reply)); }
        return out.concat(execute(state, a, getCust(state, chosen), reply));
      }
    }
    if (intent.intent !== 'choice') state.pending = null;

    switch (intent.intent) {
      case 'help':
        reply('Namaste ' + state.shop.owner.split(' ')[0] + ' ji 🙏 Main aapka Udhaar Agent hoon. Bas bolkar bhejiye:\n' +
          '• "Sharma ji ne 340 ka saaman liya, Shukravar ko denge"\n• "Pappu ne 200 jama kiye"\n• "Verma ji ka kitna baaki hai?"\n' +
          '• "Sabka hisaab batao"\n• "Iqbal bhai ko yaad dila do"\n• "Galti ho gayi, last wala cancel"\nCash mile toh bas boliye "Sharma 200 cash". UPI aaye toh SMS forward kar dijiye. Main khate mein jama kar dunga.');
        return out;
      case 'summary':
        reply(summaryText(state, 'now'));
        return out;
      case 'remind_all': {
        const due = state.customers.filter((c) => balance(state, c.id) > 0);
        if (!due.length) { reply('Kisi ka kuch baaki nahi hai. 🎉'); return out; }
        let sent = 0, noPhone = [];
        for (const c of due) { if (c.phone) { sendReminder(state, out, c, Math.max(1, c.reminderLevel || 1), 'owner-request'); sent++; } else noPhone.push(c.name); }
        reply('📨 ' + sent + ' logon ko reminder bhej diya.' + (noPhone.length ? '\nInka number nahi hai: ' + noPhone.join(', ') + '. Number bhej dijiye.' : ''));
        return out;
      }
      case 'undo': {
        const la = state.lastAction;
        const tx = la && state.txns.find((t) => t.id === la.txnId && !t.voided);
        if (!tx) { reply('Cancel karne ke liye koi haal ki entry nahi mili.'); return out; }
        tx.voided = true; state.lastAction = null;
        const c = getCust(state, tx.custId);
        log(state, 'undo', 'Voided ' + tx.type + ' ' + rupees(tx.amount) + ' for ' + c.name);
        reply('↩️ Hata diya: ' + c.name + ' ka ' + rupees(tx.amount) + ' ' + (tx.type === 'credit' ? 'udhaar' : 'jama') + '. Ab baaki: ' + rupees(balance(state, c.id)) + '.');
        return out;
      }
      case 'unknown':
        reply('Maaf kijiye, samajh nahi aaya 🙏 Aise boliye: "Sharma ji ne 340 ka saaman liya" ya "Pappu ne 200 jama kiye". (Help ke liye "help" likhein.)');
        return out;
    }

    // customer-specific intents
    if (!intent.nameKey) { reply('Kiska khata? Naam ke saath boliye, jaise "Sharma ji ne 340 ka saaman liya".'); return out; }
    const matches = findCustomers(state, intent.nameKey);
    if (matches.length > 1) {
      state.pending = { type: 'action', options: matches.map((c) => c.id), action: intent, allowNew: intent.intent === 'credit' };
      reply('"' + intent.name + '" naam ke ' + matches.length + ' khate hain. Kaun se?\n' +
        matches.map((c, i) => (i + 1) + '. ' + c.name + ' (baaki ' + rupees(balance(state, c.id)) + ')').join('\n') +
        (intent.intent === 'credit' ? '\n' + (matches.length + 1) + '. Naya khata banao' : '') + '\nNumber bhejiye.');
      return out;
    }
    let cust = matches[0];
    if (!cust) {
      if (intent.intent === 'credit') { cust = addCustomer(state, intent.name, intent.nameKey); log(state, 'customer', 'New khata: ' + cust.name); }
      else { reply(intent.name + ' ka koi khata nahi mila. Udhaar likhna ho toh boliye: "' + intent.name + ' ne 200 ka saaman liya".'); return out; }
    }
    return out.concat(execute(state, intent, cust, reply));
  }

  function execute(state, intent, cust, reply) {
    const out = []; // reply() pushes into the caller's list; reminders land here
    switch (intent.intent) {
      case 'credit': {
        // a new entry keeps an existing future promise, but never inherits a date that has already passed
        const due = intent.dueDate || (cust.dueDate && cust.dueDate > state.today && balance(state, cust.id) > 0 ? cust.dueDate : addDays(state.today, state.shop.defaultDays));
        const tx = { id: nextId(state, 'T'), custId: cust.id, type: 'credit', amount: intent.amount, items: intent.items || '', date: state.today, dueDate: due, note: intent.raw || '', source: intent.source || 'text', parser: intent.parser || 'rules' };
        state.txns.push(tx);
        cust.dueDate = due; cust.reminderLevel = 0; cust.lastReminder = null;
        state.lastAction = { txnId: tx.id };
        log(state, 'credit', cust.name + ' +' + rupees(intent.amount) + ' (due ' + fmtDate(due) + ')');
        let text = '✅ Likh liya: ' + cust.name + ', ' + rupees(intent.amount) + ' udhaar' + (intent.items ? ' (' + intent.items + ')' : '') + '.\nKul baaki: ' + rupees(balance(state, cust.id)) + '\n📅 ' +
          (intent.dueDate ? 'Wada: ' + fmtDay(due) + '. Usi din yaad dila dunga.' : fmtDay(due) + ' ko yaad dila dunga (koi tareekh nahi boli thi).');
        if (!cust.phone) text += '\n📱 ' + cust.name + ' ka WhatsApp number bhej dijiye, reminder ke liye. Jaise: "' + cust.name + ' ka number 98xxxxxxxx"';
        reply(text);
        break;
      }
      case 'payment': {
        const isCash = /\b(cash|nakad|nakd|nagad|naqad)\b|नकद|कैश/i.test(intent.raw || '');
        const tx = { id: nextId(state, 'T'), custId: cust.id, type: 'payment', amount: intent.amount, date: state.today, note: intent.raw || '', source: isCash ? 'cash' : (intent.source || 'text'), via: intent.source || 'text', parser: intent.parser || 'rules' };
        state.txns.push(tx); state.lastAction = { txnId: tx.id };
        // the owner logging cash also answers the customer's own claim, so it is never counted twice
        const claim = claims(state).find((k) => k.custId === cust.id && k.status === 'pending');
        if (claim) { claim.status = 'confirmed'; claim.resolvedOn = state.today; claim.txnId = tx.id; }
        const bal = balance(state, cust.id);
        if (bal <= 0) { cust.dueDate = null; cust.reminderLevel = 0; }
        log(state, 'payment', cust.name + ' -' + rupees(intent.amount));
        reply('✅ ' + cust.name + ' ne ' + rupees(intent.amount) + (isCash ? ' cash' : '') + ' jama kiye.' + (claim ? ' (Unka cash wala message bhi isi se confirm ho gaya.)' : '') + '\n' + (bal > 0 ? 'Abhi baaki: ' + rupees(bal) : bal < 0 ? 'Advance: ' + rupees(-bal) : 'Khata clear 🎉'));
        break;
      }
      case 'query': {
        const bal = balance(state, cust.id);
        const recent = state.txns.filter((t) => t.custId === cust.id && !t.voided).slice(-4)
          .map((t) => '  ' + fmtDate(t.date) + ': ' + (t.type === 'credit' ? '+' : '−') + rupees(t.amount)).join('\n');
        const sc = customerScore(state, cust.id);
        reply('📒 ' + cust.name + '\nBaaki: ' + rupees(bal) + (cust.dueDate && bal > 0 ? ' (wada ' + fmtDate(cust.dueDate) + ')' : '') +
          (recent ? '\nPichli entries:\n' + recent : '') + '\nBharosa score: ' + sc.score + ' (' + sc.label + ')');
        break;
      }
      case 'remind': {
        const bal = balance(state, cust.id);
        if (bal <= 0) { reply(cust.name + ' ka kuch baaki nahi hai.'); break; }
        if (!cust.phone) { reply(cust.name + ' ka number nahi hai. Bhej dijiye: "' + cust.name + ' ka number 98xxxxxxxx"'); break; }
        sendReminder(state, out, cust, Math.max(1, cust.reminderLevel || 1), 'owner-request');
        reply('📨 ' + cust.name + ' ko ' + rupees(bal) + ' ka reminder bhej diya, UPI link ke saath.');
        break;
      }
      case 'set_phone':
        cust.phone = intent.phone;
        log(state, 'customer', cust.name + ' phone saved');
        reply('📱 ' + cust.name + ' ka number save kar liya. Ab reminder seedha unke WhatsApp par jayega.');
        break;
      case 'promise':
        cust.dueDate = intent.dueDate; cust.reminderLevel = 0;
        reply('📅 Theek hai, ' + cust.name + ' ka naya wada: ' + fmtDay(intent.dueDate) + '.');
        break;
      default:
        reply('Samajh nahi aaya 🙏');
    }
    return out;
  }

  /** Full pipeline for an owner message: rule parse (or a supplied intent), record, apply. */
  function handleOwnerMessage(state, text, opts) {
    opts = opts || {};
    recordOwnerMessage(state, text, opts.source);
    const intent = opts.intent || parseOwnerMessage(text, state.today);
    intent.source = opts.source || 'text';
    intent.raw = text;
    const out = applyIntent(state, intent);
    return { intent, messages: dedupe(out) };
  }
  const dedupe = (arr) => arr.filter((m, i) => arr.indexOf(m) === i);

  // ------------------------------------------------------------ reminders
  function reminderText(state, c, level) {
    const bal = balance(state, c.id);
    const shop = state.shop.name;
    const first = c.name;
    if (level <= 1) return 'Namaste ' + first + ' 🙏\n' + shop + ' se yaad dilana tha: aapka ' + rupees(bal) + ' baaki hai' +
      (c.dueDate ? ' (aapne ' + fmtDate(c.dueDate) + ' ka bola tha)' : '') + '.\nJab sahuliyat ho, dukaan par cash ya UPI, jaise aapko theek lage. Cash de diya ho toh bas "Cash de diya" daba dijiye. Dhanyavaad!';
    if (level === 2) return first + ', ' + shop + ' se dobara yaad dila rahe hain 🙏 ' + rupees(bal) + ' abhi baaki hai.\nHo sake toh aaj de dijiye, ya bata dijiye kab tak de payenge.';
    return first + ', aapka ' + rupees(bal) + ' ' + daysBetween(c.dueDate, state.today) + ' din se baaki hai. ' + shop + ' ko is hafte zaroorat hai, kripya aaj bhugtaan karein. 🙏';
  }
  function sendReminder(state, out, c, level, why) {
    const bal = balance(state, c.id);
    const text = reminderText(state, c, level);
    emit(state, out, c.id, text, { kind: 'reminder', level, upi: upiLink(state, c, bal), amount: bal });
    c.lastReminder = state.today; c.reminderLevel = Math.max(c.reminderLevel || 0, level);
    log(state, 'reminder', 'L' + level + ' reminder to ' + c.name + ' for ' + rupees(bal) + ' (' + why + ')');
  }

  /** Morning job: send reminders on promised dates and follow-ups after. Agent37 cron calls this. */
  function runMorningJobs(state) {
    const out = [];
    const alerts = [];
    for (const c of state.customers) {
      const bal = balance(state, c.id);
      if (bal <= 0 || !c.dueDate || c.lastReminder === state.today) continue;
      if (pendingCash(state, c.id) >= bal) continue; // customer says they paid cash; wait for the owner's tap
      const late = daysBetween(c.dueDate, state.today);
      let level = 0;
      if (late === 0) level = 1; else if (late === 3) level = 2; else if (late === 7 || (late > 7 && late % 7 === 0)) level = 3;
      if (!level) continue;
      if (!c.phone) { alerts.push(c.name + ' (' + rupees(bal) + ', number nahi hai)'); continue; }
      sendReminder(state, out, c, level, 'scheduled');
      if (level === 3) alerts.push(c.name + ' (' + rupees(bal) + ', ' + late + ' din late)');
    }
    const sent = out.length;
    if (sent || alerts.length) {
      emit(state, out, 'owner', '☀️ Subah ka update: ' + (sent ? sent + ' reminder bheje.' : 'aaj koi reminder nahi.') +
        (alerts.length ? '\n⚠️ Dhyan dein: ' + alerts.join(', ') : ''), { kind: 'morning' });
    }
    return out;
  }

  function summaryText(state, when) {
    const today = state.today;
    const tx = state.txns.filter((t) => t.date === today && !t.voided);
    const cr = tx.filter((t) => t.type === 'credit'), pay = tx.filter((t) => t.type === 'payment');
    const sum = (a) => a.reduce((s, t) => s + t.amount, 0);
    const owing = state.customers.map((c) => ({ c, b: balance(state, c.id) })).filter((x) => x.b > 0).sort((a, b) => b.b - a.b);
    const overdue = owing.filter((x) => x.c.dueDate && x.c.dueDate < today);
    const tomorrow = owing.filter((x) => x.c.dueDate === addDays(today, 1));
    return (when === 'evening' ? '🌙 Aaj ka hisaab, ' : '📊 Hisaab, ') + fmtDay(today) + '\n' +
      'Naya udhaar: ' + rupees(sum(cr)) + ' (' + cr.length + ' entry)\n' +
      'Wapas aaya: ' + rupees(sum(pay)) + (pay.length ? ' (' + pay.map((t) => getCust(state, t.custId).name + ' ' + rupees(t.amount)).join(', ') + ')' : '') + '\n' +
      'Kul baaki: ' + rupees(totalOutstanding(state)) + ' (' + owing.length + ' log)\n' +
      (claims(state).some((k) => k.status === 'pending') ? '💵 Confirm karna hai: ' + claims(state).filter((k) => k.status === 'pending').length + ' (neeche)\n' : '') +
      (overdue.length ? '⚠️ Late: ' + overdue.slice(0, 5).map((x) => x.c.name + ' ' + rupees(x.b)).join(', ') + '\n' : '') +
      (tomorrow.length ? '📅 Kal ke reminder: ' + tomorrow.map((x) => x.c.name).join(', ') + '\n' : '') +
      (owing.length ? 'Sabse zyada: ' + owing.slice(0, 3).map((x) => x.c.name + ' ' + rupees(x.b)).join(', ') : '');
  }
  /** Closing time: one summary, then one batch of cash claims for the owner to tick ✅ or ❌. */
  function runEveningSummary(state) {
    const out = [];
    if (state.eveningSentFor === state.today) return out;
    state.eveningSentFor = state.today;
    emit(state, out, 'owner', summaryText(state, 'evening'), { kind: 'evening' });
    const pend = claims(state).filter((k) => k.status === 'pending');
    if (pend.length) {
      emit(state, out, 'owner', '💵 Aaj ke ' + pend.length + ' len-den confirm karne hain. Har ek par ✅ (sahi) ya ❌ (galat) dabaiye:\n' +
        pend.map((k) => '• ' + claimLabel(state, k)).join('\n'), { kind: 'cash-confirm', claimIds: pend.map((k) => k.id) });
    }
    return out;
  }
  /** Close today (evening summary if not sent yet), move to the next day, run the morning jobs. */
  function advanceDay(state) {
    const out = runEveningSummary(state);
    state.today = addDays(state.today, 1);
    return out.concat(runMorningJobs(state));
  }

  // ------------------------------------------------------------ UPI
  function parseUpiText(text) {
    const s = String(text);
    const amt = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)/i.exec(s) || /([\d,]+(?:\.\d+)?)\s*(?:rs|inr|rupees)/i.exec(s);
    const vpa = /([a-z0-9.\-_]{2,})@([a-z]{2,})/i.exec(s);
    const name = /(?:from|by)\s+(?!a\/c|vpa|upi)([A-Za-z][A-Za-z .]{1,40}?)(?=\s+(?:via|on|upi|ref|to|vpa)\b|[.,(]|\s*$)/i.exec(s) ||
      /\(([A-Z][A-Z .]{2,40})\)/.exec(s);
    const tag = /UDH-?(C\d{3,})/i.exec(s);
    const ref = /(?:ref(?:erence)?|utr|rrn)(?:\s*no)?\.?\s*:?\s*(\d{6,})/i.exec(s);
    const credited = /credited|received|recd|aaye|mila|jama|paid you|sent you/i.test(s) && !/debited/i.test(s);
    return {
      amount: amt ? parseFloat(amt[1].replace(/,/g, '')) : null, vpa: vpa ? vpa[0].toLowerCase() : null,
      payerName: name ? name[1].trim() : null, tag: tag ? tag[1].toUpperCase() : null, ref: ref ? ref[1] : null, credited, raw: s
    };
  }

  function matchUpi(state, u) {
    if (u.tag) { const c = getCust(state, u.tag); if (c) return { cust: c, how: 'payment link tag', confidence: 'exact' }; }
    if (u.vpa) { const c = state.customers.find((x) => x.vpas.includes(u.vpa)); if (c) return { cust: c, how: 'known UPI ID', confidence: 'exact' }; }
    const nameSrc = [u.payerName || '', u.vpa ? u.vpa.split('@')[0].replace(/[._\-\d]+/g, ' ') : ''].join(' ');
    const words = tokenize(nameSrc).norm.filter((w) => w.length >= 3 && !HONORIFICS.has(w));
    if (words.length) {
      const hits = state.customers.filter((c) => c.key.split(' ').some((k) => words.some((w) => w === k || (k.length >= 4 && lev(w, k) <= 1))));
      if (hits.length === 1) return { cust: hits[0], how: 'payer name', confidence: 'high' };
      if (hits.length > 1) {
        const byAmt = hits.filter((c) => balance(state, c.id) === u.amount);
        if (byAmt.length === 1) return { cust: byAmt[0], how: 'payer name + exact due amount', confidence: 'high' };
        return { candidates: hits };
      }
    }
    const byAmt = state.customers.filter((c) => u.amount && balance(state, c.id) === u.amount);
    if (byAmt.length === 1) return { cust: byAmt[0], how: 'exact due amount', confidence: 'medium', confirm: true };
    const owing = state.customers.filter((c) => balance(state, c.id) > 0)
      .sort((a, b) => Math.abs(balance(state, a.id) - u.amount) - Math.abs(balance(state, b.id) - u.amount));
    return { candidates: owing.slice(0, 3) };
  }

  /** Bank SMS / UPI app notification forwarded by the owner (or pushed by a payment webhook). */
  function handleUpiNotification(state, input) {
    const out = [];
    const u = typeof input === 'string' ? parseUpiText(input) : Object.assign({ credited: true }, input);
    if (typeof input === 'string') recordOwnerMessage(state, input, 'upi-sms');
    if (!u.amount) { emit(state, out, 'owner', 'Is message mein raqam nahi mili. Poora UPI SMS forward kijiye.'); return out; }
    if (u.ref && state.seenUpiRefs.includes(u.ref)) { emit(state, out, 'owner', 'Yeh payment (Ref ' + u.ref + ') pehle hi jama ho chuka hai.'); return out; }
    const m = matchUpi(state, u);
    if (m.cust && !m.confirm) return settleUpi(state, u, m.cust, m.how);
    const options = m.cust ? [m.cust] : m.candidates;
    if (!options || !options.length) { emit(state, out, 'owner', '💰 ' + rupees(u.amount) + ' aaya' + (u.payerName ? ' (' + u.payerName + ')' : '') + ', par kisi khate se match nahi hua. Kiska hai? Naam bhejiye.'); return out; }
    state.pending = { type: 'upi', upi: u, options: options.map((c) => c.id) };
    emit(state, out, 'owner', '💰 ' + rupees(u.amount) + ' UPI se aaya' + (u.payerName ? ' (' + u.payerName + ')' : u.vpa ? ' (' + u.vpa + ')' : '') + '. Kiska hai?\n' +
      options.map((c, i) => (i + 1) + '. ' + c.name + ' (baaki ' + rupees(balance(state, c.id)) + ')').join('\n') + '\nNumber bhejiye.', { kind: 'upi-question' });
    return out;
  }

  const HOW_HI = {
    'payment link tag': 'reminder ke UPI link se pehchana', 'known UPI ID': 'pehle wali UPI ID se pehchana',
    'payer name': 'bhejne wale ke naam se pehchana', 'payer name + exact due amount': 'naam aur raqam se pehchana',
    'exact due amount': 'raqam se pehchana', 'owner-confirmed': 'aapne bataya'
  };
  function settleUpi(state, u, cust, how) {
    how = HOW_HI[how] || how;
    const out = [];
    const tx = { id: nextId(state, 'T'), custId: cust.id, type: 'payment', amount: u.amount, date: state.today, note: 'UPI' + (u.ref ? ' ref ' + u.ref : ''), source: 'upi', matchedBy: how };
    state.txns.push(tx); state.lastAction = { txnId: tx.id };
    if (u.ref) state.seenUpiRefs.push(u.ref);
    if (u.vpa && !cust.vpas.includes(u.vpa)) cust.vpas.push(u.vpa);
    const bal = balance(state, cust.id);
    if (bal <= 0) { cust.dueDate = null; cust.reminderLevel = 0; }
    log(state, 'upi', rupees(u.amount) + ' from ' + (u.payerName || u.vpa || 'UPI') + ' matched to ' + cust.name + ' by ' + how);
    emit(state, out, 'owner', '💰 ' + rupees(u.amount) + ' UPI se aaya, ' + cust.name + ' ke khate mein jama kar diya (' + how + ').\n' +
      (bal > 0 ? 'Abhi baaki: ' + rupees(bal) : 'Khata clear ✅'), { kind: 'upi-settled' });
    if (cust.phone) emit(state, out, cust.id, 'Dhanyavaad ' + cust.name + ' 🙏 ' + rupees(u.amount) + ' mil gaye.\n' + (bal > 0 ? 'Abhi baaki: ' + rupees(bal) : 'Aapka khata clear hai.') + '\n- ' + state.shop.name, { kind: 'receipt' });
    return out;
  }

  /** Customer replies on WhatsApp ("kal dunga", "Friday tak", "paid kar diya"). The agent negotiates. */
  function handleCustomerMessage(state, custId, text) {
    const out = [];
    const c = getCust(state, custId);
    state.messages.push({ id: nextId(state, 'M'), to: 'agent', from: custId, text, date: state.today, ts: Date.now() });
    const tok = tokenize(text);
    const due = extractDue(tok, state.today).due;
    const bal = balance(state, c.id);
    if (/\s(cash|nakad|nakd|nagad|naqad|haath me|hath me)\s/.test(tok.text) && !due) {
      const amt = extractAmount(tok, new Set());
      const amount = amt && amt.amount > 0 ? amt.amount : Math.max(0, bal - pendingCash(state, c.id));
      if (amount <= 0) { emit(state, out, c.id, 'Aapka koi baaki nahi hai 🙏'); return out; }
      const k = { id: nextId(state, 'K'), custId: c.id, amount, date: state.today, status: 'pending' };
      claims(state).push(k);
      log(state, 'cash', c.name + ' says paid ' + rupees(amount) + ' cash (pending)');
      emit(state, out, c.id, 'Dhanyavaad ' + c.name + ' 🙏 ' + rupees(amount) + ' cash note kar liya. Dukaandaar shaam ko confirm karenge, phir raseed bhej denge.', { kind: 'cash-noted' });
      return out;
    }
    if (/\s(paid|pay kar|kar diya|bhej diya|bhej diye|de diya|transfer)\s/.test(tok.text) && !due) {
      emit(state, out, c.id, 'Dhanyavaad! 🙏 Payment aate hi khata update ho jayega.');
      emit(state, out, 'owner', '💬 ' + c.name + ' keh rahe hain unhone pay kar diya. UPI SMS aaye toh forward kar dijiye, main match kar dunga.');
      return out;
    }
    if (due) {
      c.dueDate = due; c.reminderLevel = 0; c.lastReminder = state.today;
      log(state, 'promise', c.name + ' promised ' + fmtDate(due));
      emit(state, out, c.id, 'Theek hai ' + c.name + ' 🙏 ' + fmtDay(due) + ' ko yaad dila denge. Baaki: ' + rupees(bal) + '.');
      emit(state, out, 'owner', '💬 ' + c.name + ' ne ' + fmtDay(due) + ' tak ' + rupees(bal) + ' dene ka wada kiya. Usi din yaad dila dunga.');
      return out;
    }
    const part = extractAmount(tok, new Set());
    if (part && part.amount < bal) {
      emit(state, out, c.id, 'Koi baat nahi 🙏 Abhi ' + rupees(part.amount) + ' bhej dijiye, baaki ' + rupees(bal - part.amount) + ' ke liye ek tareekh bata dijiye.');
      emit(state, out, 'owner', '💬 ' + c.name + ' abhi ' + rupees(part.amount) + ' dena chahte hain.');
      return out;
    }
    emit(state, out, c.id, 'Dhanyavaad 🙏 Kab tak de payenge? Jaise "Shukravar ko" ya "5 tareekh".');
    emit(state, out, 'owner', '💬 ' + c.name + ': "' + text + '"');
    return out;
  }

  function claimLabel(state, k) {
    const n = getCust(state, k.custId).name;
    if (k.type === 'check') return n + ' ne ' + k.label + ' ko galat bataya. ✅ = aapki entry sahi hai, ❌ = galti thi, theek karo';
    if (k.type === 'credit') return n + ': ' + rupees(k.amount) + ' udhaar? (Galla Mic ne suna)';
    return n + ': ' + rupees(k.amount) + ' cash' + (k.origin === 'galla' ? '? (Galla Mic ne suna' + (k.why ? ', ' + k.why : '') + ')' : ' (grahak ne bataya)');
  }
  /** Owner's one-tap answer to a pending item. ok=true records it; a customer's cash claim marked ❌ becomes a dispute. */
  function confirmCash(state, claimId, ok) {
    const out = [];
    const k = claims(state).find((x) => x.id === claimId);
    if (!k || k.status !== 'pending') return out;
    const c = getCust(state, k.custId);
    k.resolvedOn = state.today;
    if (k.type === 'check') return resolveCheck(state, k, c, ok, out);
    if (k.origin === 'galla' && !ok) {
      k.status = 'dropped';
      emit(state, out, 'owner', '👍 Theek hai, ' + c.name + ' ka ' + rupees(k.amount) + ' nahi likha.', { kind: 'cash-done' });
      return out;
    }
    if (k.type === 'credit') {
      const due = addDays(k.date, state.shop.defaultDays);
      const tx = { id: nextId(state, 'T'), custId: c.id, type: 'credit', amount: k.amount, items: k.items || '', date: k.date, dueDate: due, note: k.heard || '', source: 'galla', matchedBy: 'Galla Mic, aapne confirm kiya' };
      state.txns.push(tx); k.status = 'confirmed'; k.txnId = tx.id;
      if (!c.dueDate || c.dueDate > due) c.dueDate = due;
      emit(state, out, 'owner', '✅ ' + c.name + ' ka ' + rupees(k.amount) + ' udhaar likh diya. Baaki: ' + rupees(balance(state, c.id)), { kind: 'cash-done' });
      return out;
    }
    if (ok) {
      const tx = { id: nextId(state, 'T'), custId: c.id, type: 'payment', amount: k.amount, date: k.date, note: k.origin === 'galla' ? (k.heard || '') : 'cash, customer reported, owner confirmed', source: 'cash', via: k.origin === 'galla' ? 'galla' : 'customer', matchedBy: k.origin === 'galla' ? 'Galla Mic, aapne confirm kiya' : 'grahak ne bataya, aapne confirm kiya' };
      state.txns.push(tx); k.status = 'confirmed'; k.txnId = tx.id;
      const bal = balance(state, c.id);
      if (bal <= 0) { c.dueDate = null; c.reminderLevel = 0; }
      log(state, 'cash', c.name + ' cash ' + rupees(k.amount) + ' confirmed');
      emit(state, out, 'owner', '✅ ' + c.name + ' ka ' + rupees(k.amount) + ' cash jama. ' + (bal > 0 ? 'Baaki: ' + rupees(bal) : 'Khata clear ✅'), { kind: 'cash-done' });
      if (c.phone) emit(state, out, c.id, 'Dhanyavaad ' + c.name + ' 🙏 ' + rupees(k.amount) + ' cash mil gaya, dukaandaar ne confirm kiya.\n' + (bal > 0 ? 'Abhi baaki: ' + rupees(bal) : 'Aapka khata clear hai.') + '\n- ' + state.shop.name, { kind: 'receipt' });
    } else {
      k.status = 'disputed'; c.disputed = true;
      log(state, 'cash', c.name + ' cash ' + rupees(k.amount) + ' disputed');
      emit(state, out, 'owner', '❌ ' + c.name + ' ka ' + rupees(k.amount) + ' cash nahi mila, khate mein vivaad laga diya. Baaki ' + rupees(balance(state, c.id)) + ' hi rahega. Unse ek baar baat kar lijiye.', { kind: 'cash-done' });
      if (c.phone) emit(state, out, c.id, c.name + ' 🙏 dukaan ke hisaab mein ' + rupees(k.amount) + ' cash abhi nahi dikh raha. Dukaan par ek baar baat kar lijiye, galti ho toh turant theek kar denge.', { kind: 'dispute' });
    }
    return out;
  }

  // ------------------------------------------------------- Galla Mic
  /*
   * A phone at the counter hears the owner's normal talk with customers. Only lines with a ledger trigger word are
   * looked at; everything else is dropped on the spot and never stored. A line is written straight into the khata only
   * when it is unambiguous (one known customer, an amount, and any "N baaki" said aloud matches the khata). Anything
   * less sure goes to the evening ✅/❌ list.
   */
  const GALLA_TRIGGER = /\s(jama|udhar|udhari|baki|bakaya|likh lo|likh do|likh dena|likh lena|likho|khate me|khate mein|khata me|cash|nakad|chuka|chukaya)\s/;
  function scanCounterSpeech(state, text) {
    const out = [];
    const tok = tokenize(text);
    if (!GALLA_TRIGGER.test(tok.text)) return { action: 'ignored', messages: out };
    const n = tok.norm;
    // "140 baaki" is the owner telling the customer what is left: a check value, not the amount of this entry
    let statedLeft = null; const skip = new Set();
    for (let i = 0; i < n.length; i++) if (/^\d+$/.test(n[i]) && /^(baki|bakaya|bache|bacha|remaining)$/.test(n[i + 1] || '')) { statedLeft = parseInt(n[i], 10); skip.add(i); }
    for (let i = 1; i < n.length; i++) if (/^(baki|bakaya)$/.test(n[i - 1]) && /^\d+$/.test(n[i])) { statedLeft = parseInt(n[i], 10); skip.add(i); }
    const intent = parseOwnerMessage(text, state.today);
    const amt = extractAmount(tok, skip);
    if (amt) intent.amount = amt.amount;
    if (!/credit|payment/.test(intent.intent) || !intent.amount) return { action: 'ignored', messages: out, reason: 'no entry in this line' };
    const matches = intent.nameKey ? findCustomers(state, intent.nameKey) : [];
    const cust = matches.length === 1 ? matches[0] : null;
    if (!cust) {
      emit(state, out, 'owner', '🎙 Galla Mic ne suna: "' + text + '"\nNaam pakka nahi hua' + (matches.length > 1 ? ' (' + matches.map((c) => c.name).join(' / ') + ')' : '') + ', isliye kuch nahi likha. Bolkar likhwa dijiye.', { kind: 'galla' });
      return { action: 'unclear', messages: out };
    }
    const bal = balance(state, cust.id);
    const after = intent.intent === 'payment' ? bal - intent.amount : bal + intent.amount;
    const mismatch = statedLeft != null && Math.abs(after - statedLeft) > 0.5;
    // same thing heard twice today (owner repeats himself): don't double count
    const dup = state.txns.some((t) => t.custId === cust.id && t.date === state.today && t.via === 'galla' && t.amount === intent.amount && t.type === intent.intent) ||
      claims(state).some((k) => k.custId === cust.id && k.date === state.today && k.origin === 'galla' && k.amount === intent.amount && k.status === 'pending');
    if (dup) return { action: 'duplicate', messages: out };
    if (mismatch || (intent.intent === 'payment' && intent.amount > bal)) {
      const why = mismatch ? 'aapne ' + rupees(statedLeft) + ' baaki bola, khate se ' + rupees(after) + ' banta hai' : 'baaki se zyada';
      const k = { id: nextId(state, 'K'), custId: cust.id, amount: intent.amount, date: state.today, status: 'pending', origin: 'galla', type: intent.intent === 'credit' ? 'credit' : 'payment', heard: text, why, items: intent.items };
      claims(state).push(k);
      log(state, 'galla', 'Queued for evening: ' + claimLabel(state, k));
      emit(state, out, 'owner', '🎙 Galla Mic ne suna: "' + text + '"\nPakka nahi (' + why + '), shaam ko aapse confirm karunga.', { kind: 'galla' });
      return { action: 'queued', claim: k, messages: out };
    }
    const res = applyIntent(state, Object.assign({}, intent, { source: 'galla', raw: text, nameKey: cust.key }));
    // tag what the mic wrote so the khata shows where it came from
    const tx = state.txns[state.txns.length - 1];
    if (tx && tx.custId === cust.id) { tx.source = intent.intent === 'payment' ? 'cash' : 'galla'; tx.via = 'galla'; tx.matchedBy = 'Galla Mic' + (statedLeft != null ? ', baaki bhi mila' : ''); }
    for (const m of res) { m.kind = 'galla'; m.text = '🎙 Galla Mic ne suna: "' + text + '"\n' + m.text + '\nGalat ho toh "galti" boliye.'; }
    log(state, 'galla', 'Logged from counter talk: ' + text);
    return { action: 'logged', messages: out.concat(res) };
  }

  // ------------------------------------------------------------ scores
  /** FIFO-allocate payments to credits to see when each credit was cleared. */
  function creditHistory(state, custId) {
    const tx = state.txns.filter((t) => t.custId === custId && !t.voided).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const credits = tx.filter((t) => t.type === 'credit').map((t) => ({ t, left: t.amount, cleared: null }));
    let i = 0;
    for (const p of tx.filter((t) => t.type === 'payment')) {
      let amt = p.amount;
      while (amt > 0 && i < credits.length) {
        const c = credits[i];
        if (c.t.date > p.date) break;
        const use = Math.min(amt, c.left); c.left -= use; amt -= use;
        if (c.left <= 0.001) { c.cleared = p.date; i++; }
      }
    }
    return credits;
  }

  function customerScore(state, custId) {
    const h = creditHistory(state, custId);
    if (!h.length) return { score: 650, label: 'Naya', onTimeRate: null, avgDelay: null, entries: 0 };
    const closed = h.filter((c) => c.cleared);
    const onTime = closed.filter((c) => daysBetween(c.t.dueDate || addDays(c.t.date, 7), c.cleared) <= 1).length;
    const delays = closed.map((c) => Math.max(0, daysBetween(c.t.dueDate || addDays(c.t.date, 7), c.cleared)));
    const avgDelay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;
    const open = h.filter((c) => !c.cleared);
    const worstLate = open.reduce((m, c) => Math.max(m, daysBetween(c.t.dueDate || addDays(c.t.date, 7), state.today)), 0);
    const onTimeRate = closed.length ? onTime / closed.length : 0.5;
    const disputes = claims(state).filter((k) => k.custId === custId && k.status === 'disputed').length;
    const s = 300 + 600 * (0.5 * onTimeRate + 0.25 * Math.max(0, 1 - avgDelay / 30) + 0.15 * Math.max(0, 1 - Math.max(0, worstLate) / 30) + 0.10 * Math.min(1, h.length / 10))
      - Math.min(120, 40 * disputes);
    const score = Math.max(300, Math.min(900, Math.round(s)));
    // How they pay is recorded but never scored: cash is as good as UPI.
    const pays = state.txns.filter((t) => t.custId === custId && !t.voided && t.type === 'payment');
    const paid = pays.reduce((a, t) => a + t.amount, 0), upi = pays.filter((t) => t.source === 'upi').reduce((a, t) => a + t.amount, 0);
    const first = h[0].t.date;
    return {
      score, label: score >= 750 ? 'Bharosemand' : score >= 600 ? 'Theek' : 'Dhyan dein', onTimeRate, avgDelay, worstLate: Math.max(0, worstLate), entries: h.length,
      disputes, closed: closed.length, open: open.length, since: first, months: Math.max(1, Math.round(daysBetween(first, state.today) / 30)),
      totalCredit: Math.round(h.reduce((a, c) => a + c.t.amount, 0)), upiShare: paid ? upi / paid : null, cashShare: paid ? 1 - upi / paid : null
    };
  }

  // ---------------------------------------------------- consent (Account Aggregator style, simulated)
  // A lender sees a customer's score only after the customer says yes on their own phone.
  // Consent names the lender, the purpose, what is shared and for how long, and the customer can take it back any time.
  const CONSENT_DAYS = 30;
  const DEMO_LENDER = 'Saathi Finance (demo NBFC)';
  const consents = (state) => (state.consents = state.consents || {});
  function consentOf(state, custId) {
    const k = consents(state)[custId];
    if (k && k.status === 'granted' && k.expires < state.today) { k.status = 'expired'; }
    return k || { status: 'none' };
  }
  function requestConsent(state, custId, lender) {
    const out = [];
    const c = getCust(state, custId); if (!c) return out;
    lender = lender || DEMO_LENDER;
    if (!c.phone) { emit(state, out, 'owner', c.name + ' ka WhatsApp number nahi hai, isliye unse share karne ki ijaazat nahi maangi ja sakti. Bina ijaazat kuch share nahi hoga.', { kind: 'consent' }); return out; }
    const cur = consentOf(state, custId);
    if (cur.status === 'requested' || cur.status === 'granted') return out;
    consents(state)[custId] = { status: 'requested', lender, purpose: 'chhota business/ghar ka loan', requestedAt: state.today, days: CONSENT_DAYS };
    emit(state, out, custId, 'Namaste ' + c.name + ' 🙏\n' + lender + ' aapko loan dene ke liye ' + state.shop.name + ' par aapka udhaar chukane ka record dekhna chahta hai.\n\n' +
      'Kya jayega: aapka score, kitni baar time par chukaya, aur kitne mahine ka record.\nKya NAHI jayega: aapne kya saaman liya, aapka number, ya koi entry.\n' +
      'Kitne din: ' + CONSENT_DAYS + ' din. Aap kabhi bhi wapas le sakte hain.\n\nShare karein?', { kind: 'consent-ask' });
    emit(state, out, 'owner', lender + ' ne ' + c.name + ' ka record maanga. ' + c.name + ' se unke phone par ijaazat maangi hai; unki haan ke bina kuch share nahi hoga.', { kind: 'consent' });
    log(state, 'consent', c.name + ': consent requested by ' + lender);
    return out;
  }
  function answerConsent(state, custId, yes) {
    const out = [];
    const c = getCust(state, custId); const k = consents(state)[custId];
    if (!c || !k || k.status !== 'requested') return out;
    k.status = yes ? 'granted' : 'denied'; k.decidedAt = state.today;
    if (yes) k.expires = addDays(state.today, CONSENT_DAYS);
    emit(state, out, custId, yes ? 'Theek hai. ' + k.lender + ' ' + fmtDate(k.expires) + ' tak sirf aapka score aur chukane ka record dekh payega. Wapas lena ho toh neeche "Ijaazat wapas" dabaiye.'
      : 'Theek hai, kuch share nahi kiya. Aapka khata pehle jaisa chalta rahega.', { kind: yes ? 'consent-yes' : 'consent-no' });
    emit(state, out, 'owner', c.name + (yes ? ' ne ' + k.lender + ' ke saath record share karne ki haan kahi (' + fmtDate(k.expires) + ' tak).' : ' ne share karne se mana kiya. Kuch share nahi hua.'), { kind: 'consent' });
    log(state, 'consent', c.name + ': consent ' + (yes ? 'granted' : 'denied'));
    return out;
  }
  function revokeConsent(state, custId) {
    const out = [];
    const c = getCust(state, custId); const k = consents(state)[custId];
    if (!c || !k || k.status !== 'granted') return out;
    k.status = 'revoked'; k.decidedAt = state.today;
    emit(state, out, custId, 'Ijaazat wapas le li. ' + k.lender + ' ab aapka record nahi dekh sakta.', { kind: 'consent-no' });
    emit(state, out, 'owner', c.name + ' ne ' + k.lender + ' se ijaazat wapas le li.', { kind: 'consent' });
    log(state, 'consent', c.name + ': consent revoked');
    return out;
  }
  /** What the lender can see: nothing unless the customer has said yes and the consent is still valid. */
  function lenderView(state, custId) {
    const c = getCust(state, custId); if (!c) return null;
    const k = consentOf(state, custId);
    if (k.status !== 'granted') return { shared: false, status: k.status };
    const sc = customerScore(state, custId);
    return {
      shared: true, lender: k.lender, until: k.expires,
      report: { customer: c.name, shop: state.shop.name, city: state.shop.city || '', score: sc.score, band: sc.label, onTimeRate: sc.onTimeRate, avgDaysLate: sc.avgDelay,
        months: sc.months, creditsTaken: sc.entries, totalCredit: sc.totalCredit, disputes: sc.disputes, outstanding: Math.max(0, Math.round(balance(state, custId))) }
    };
  }

  /** Shop-level credit profile: the "khata passport" a lender could read (with the owner's consent). */
  function shopProfile(state, days) {
    days = days || 90;
    const from = addDays(state.today, -days);
    const tx = state.txns.filter((t) => !t.voided && t.date > from);
    const credit = tx.filter((t) => t.type === 'credit').reduce((s, t) => s + t.amount, 0);
    const recovered = tx.filter((t) => t.type === 'payment').reduce((s, t) => s + t.amount, 0);
    const recoveryDays = [];
    for (const c of state.customers) for (const h of creditHistory(state, c.id)) if (h.cleared && h.t.date > from) recoveryDays.push(daysBetween(h.t.date, h.cleared));
    const outstanding = totalOutstanding(state);
    const overdue = state.customers.filter((c) => balance(state, c.id) > 0 && c.dueDate && c.dueDate < state.today).reduce((s, c) => s + balance(state, c.id), 0);
    const scores = state.customers.filter((c) => creditHistory(state, c.id).length).map((c) => customerScore(state, c.id).score);
    const months = Math.max(1, Math.min(days, daysBetween(state.txns.reduce((m, t) => t.date < m ? t.date : m, state.today), state.today)) / 30);
    return {
      shop: state.shop.name, asOf: state.today, windowDays: days,
      creditExtended: Math.round(credit), recovered: Math.round(recovered),
      recoveryRate: credit ? Math.min(1, recovered / credit) : null,
      avgDaysToRecover: recoveryDays.length ? recoveryDays.reduce((a, b) => a + b, 0) / recoveryDays.length : null,
      outstanding: Math.round(outstanding), overdueShare: outstanding ? overdue / outstanding : 0,
      activeCustomers: state.customers.filter((c) => state.txns.some((t) => t.custId === c.id && t.date > from)).length,
      avgCustomerScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      monthlyRecovered: Math.round(recovered / months),
      // indicative only: half of an average month's recoveries, a conservative working-capital line
      indicativeCreditLine: Math.round(0.5 * recovered / months / 500) * 500
    };
  }

  // -------------------------------------------------------- demo seed
  /**
   * Two demo shops. Each has ~75 days of settled history (so trust scores mean something) plus a few open dues
   * chosen so that one "next day" shows the whole reminder ladder: polite, firmer, firm + owner alert.
   */
  const DEMO_SHOPS = {
    gupta: {
      shop: { id: 'gupta', name: 'Gupta Kirana Store', owner: 'Rakesh Gupta', upiId: 'guptakirana@upi', city: 'Guwahati' },
      seed: 7,
      people: [
        // name, key, phone, reliability, known UPI IDs
        ['Sharma ji', 'sharma', '9876500001', 0.9, ['ramesh.sharma@okaxis']],
        ['Meena didi', 'mina', '9876500002', 1.0, ['meena.k@ybl']],
        ['Pappu', 'papu', '9876500003', 0.35, []],
        ['Iqbal bhai', 'ikbal', '9876500004', 0.7, ['iqbal786@paytm']],
        ['Verma ji', 'verma', '9876500005', 0.45, []],
        ['Kavita aunty', 'kavita', '9876500006', 0.95, []],
        ['Rohan', 'rohan', null, 0.5, []]
      ],
      open: [
        ['C002', 700, 'atta 10 kilo, dal, tel', -4, 3],   // Meena didi: due in 3 days
        ['C003', 170, 'biscuit, cold drink', -9, -2],     // Pappu: next morning gets the firmer reminder
        ['C005', 530, 'chawal 5 kilo, ghee', -14, -6],    // Verma ji: next morning gets the firm one
        ['C007', 170, 'maggi, anda', -2, 5]               // Rohan: no WhatsApp number yet
      ],
      // the rest of a typical Nagpur store's udhaar list (20-30 customers, up to ~₹3-4k each); dues fall after tomorrow
      // or were already reminded, so one "next day" still shows exactly the three-level ladder above
      // name, reliability, open due [amount, items, days ago, due in] or null, has WhatsApp
      extra: [
        ['Deshmukh kaka', 0.85, [2400, 'mahine ka rashan', -10, 4]], ['Patil bhau', 0.6, [3200, 'rashan, tel 5 litre', -12, 2]],
        ['Joshi kaku', 0.95, [850, 'dal, chawal', -3, 5]], ['Wankhede ji', 0.7, [1900, 'atta 20 kilo, shakkar', -8, 6]],
        ['Kale madam', 0.9, [600, 'doodh, bread, anda', -2, 8]], ['Bhonsle bhau', 0.4, [3600, 'rashan 2 mahine', -25, -1]],
        ['Ansari bhai', 0.8, [1450, 'chawal 10 kilo, tel', -6, 3]], ['Fernandes aunty', 0.95, null],
        ['Gawande ji', 0.55, [2750, 'rashan, sabun', -15, -1]], ['Thakre sir', 0.9, [980, 'biscuit, chai patti, shakkar', -4, 7]],
        ['Kulkarni kaku', 1.0, null], ['Shaikh bhai', 0.75, [1200, 'atta, besan', -5, 4]],
        ['Raut bhau', 0.5, [3900, 'mahine ka saaman', -18, 2]], ['Meshram ji', 0.8, [700, 'tel, masala', -2, 9]],
        ['Bawane ji', 0.65, [2100, 'rashan', -9, 5]], ['Nair aunty', 0.9, [450, 'rava, nariyal tel', -1, 6]],
        ['Choudhary ji', 0.7, [1650, 'ghee, dal', -7, 3]], ['Lanjewar bhau', 0.6, [2300, 'rashan, gas lighter', -11, 10], false]
      ]
    },
    balaji: {
      shop: { id: 'balaji', name: 'Balaji Dairy & General', owner: 'Sunita Yadav', upiId: 'balajidairy@upi', city: 'Jorhat' },
      seed: 23,
      people: [
        ['Anita bhabhi', 'anita', '9812300001', 0.95, ['anita.das@ybl']],
        ['Rafiq chacha', 'rafik', '9812300002', 0.8, []],
        ['Suresh driver', 'suresh driver', '9812300003', 0.3, []],
        ['Pinky didi', 'pinki', '9812300004', 0.85, ['pinky99@paytm']],
        ['Mishra ji', 'mishra', '9812300005', 0.5, []],
        ['Lakshmi amma', 'lakshmi', null, 0.9, []]
      ],
      open: [
        ['C001', 240, 'doodh 8 litre, paneer', -6, 1],     // Anita bhabhi: polite reminder tomorrow
        ['C003', 900, 'doodh mahina, ghee', -20, -6],      // Suresh driver: firm reminder + owner alert tomorrow
        ['C005', 460, 'dahi, makhan, biscuit', -8, -2],    // Mishra ji: firmer reminder tomorrow
        ['C004', 250, 'chai patti, chini', -1, 4],
        ['C006', 120, 'doodh 2 litre', -1, 6]              // Lakshmi amma: no WhatsApp number
      ],
      extra: [
        ['Dongre ji', 0.85, [1800, 'doodh mahina', -20, 3]], ['Pande kaku', 0.95, [2100, 'doodh mahina, dahi', -22, 2]],
        ['Khobragade ji', 0.6, [2900, 'doodh, paneer, ghee', -25, -1]], ['Lokhande bhau', 0.7, [1350, 'doodh, bread', -9, 5]],
        ['Ingle sir', 0.9, [760, 'dahi, makhan', -4, 6]], ['Zade bhau', 0.5, [3400, 'doodh 2 mahine', -30, -1]],
        ['Bhagat ji', 0.9, null], ['Sayyed bhai', 0.75, [1600, 'doodh, anda', -10, 4]],
        ['Chavan ji', 0.8, [2200, 'doodh mahina, ghee', -18, 7]], ['Mohite bhau', 0.65, [1150, 'paneer, dahi', -6, 3]],
        ['Sonkusare ji', 0.9, [940, 'doodh, chai patti', -5, 8]], ['Barde kaku', 1.0, null],
        ['Hedau ji', 0.55, [2650, 'doodh mahina', -21, 2]], ['Qureshi bhai', 0.8, [1300, 'doodh, makhan', -7, 5]],
        ['Rathod ji', 0.7, [1750, 'doodh, ghee', -12, 9]], ['Wagh madam', 0.95, [520, 'dahi, lassi', -2, 4]],
        ['Dhote ji', 0.6, [3100, 'doodh 2 mahine, paneer', -28, 6], false], ['Gajbhiye ji', 0.75, [880, 'doodh, bread', -3, 10]]
      ]
    },
    // an empty khata, to show first-day setup from photos of the old copy
    nayi: { shop: { id: 'nayi', name: 'Nayi dukaan (khali khata)', owner: '', upiId: 'nayidukaan@upi', city: 'Nagpur' }, seed: 1, people: [], open: [] }
  };

  function seedDemo(state, which) {
    const cfg = DEMO_SHOPS[which || 'gupta'] || DEMO_SHOPS.gupta;
    Object.assign(state.shop, cfg.shop);
    let r = cfg.seed;
    const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
    const T = state.today;
    const start = addDays(T, -75);
    const lastPay = addDays(T, -12);
    const extra = (cfg.extra || []).map(([name, reliab, open, wa], i) =>
      [name, nameKey(tokenize(name).norm), wa === false ? null : cfg.people[0][2].slice(0, 6) + String(50 + i).padStart(4, '0'), reliab, [], open]);
    for (const [name, key, phone, reliab, vpas] of cfg.people.concat(extra)) {
      const c = addCustomer(state, name, key, { phone, vpas: vpas.slice(), createdAt: start });
      let d = addDays(start, Math.floor(rand() * 6));
      while (d < addDays(T, -20)) {
        const amt = Math.round((80 + rand() * 700) / 10) * 10;
        const due = addDays(d, 3 + Math.floor(rand() * 8));
        state.txns.push({ id: nextId(state, 'T'), custId: c.id, type: 'credit', amount: amt, items: '', date: d, dueDate: due, note: 'seed', source: 'seed' });
        const late = rand() < reliab ? Math.floor(rand() * 2) : 3 + Math.floor(rand() * 14);
        let payDay = addDays(due, late); if (payDay > lastPay) payDay = lastPay;
        state.txns.push({ id: nextId(state, 'T'), custId: c.id, type: 'payment', amount: amt, date: payDay, note: 'seed', source: rand() < 0.6 ? 'upi' : 'cash' });
        d = addDays(d, 5 + Math.floor(rand() * 9));
      }
    }
    const opens = cfg.open.concat(extra.filter((x) => x[5]).map((x) => [state.customers.find((c) => c.name === x[0]).id].concat(x[5])));
    for (const [id, amt, items, ago, dueIn] of opens) {
      const c = getCust(state, id);
      state.txns.push({ id: nextId(state, 'T'), custId: id, type: 'credit', amount: amt, items, date: addDays(T, ago), dueDate: addDays(T, dueIn), note: 'seed', source: 'voice', parser: 'rules' });
      c.dueDate = addDays(T, dueIn);
      if (dueIn < 0) { c.lastReminder = addDays(T, dueIn); c.reminderLevel = 1; }
    }
    log(state, 'seed', 'Loaded 75 days of sample khata for ' + state.customers.length + ' customers of ' + state.shop.name);
    return state;
  }

  // -------------------------------------------------------- dashboard
  /** What the owner sees at a glance: money out there, who is late, and how well dues come back. */
  function dashboard(state, days) {
    days = days || 30;
    const T = state.today, from = addDays(T, -days);
    const owing = state.customers.map((c) => ({ c, b: balance(state, c.id) })).filter((x) => x.b > 0);
    const overdue = owing.filter((x) => x.c.dueDate && x.c.dueDate < T)
      .map((x) => ({ id: x.c.id, name: x.c.name, amount: x.b, daysLate: daysBetween(x.c.dueDate, T), reminderLevel: x.c.reminderLevel || 0, phone: !!x.c.phone }))
      .sort((a, b) => b.daysLate - a.daysLate || b.amount - a.amount);
    // collection rate: of the udhaar whose promised date fell in the window, how much has come back, and how much on time
    let dueTotal = 0, paidTotal = 0, onTime = 0;
    for (const c of state.customers) for (const h of creditHistory(state, c.id)) {
      const due = h.t.dueDate || addDays(h.t.date, 7);
      if (due <= from || due > T) continue;
      dueTotal += h.t.amount; paidTotal += h.t.amount - h.left;
      if (h.cleared && daysBetween(due, h.cleared) <= 1) onTime += h.t.amount;
    }
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(T, -i);
      const tx = state.txns.filter((t) => !t.voided && t.date === d);
      daily.push({ date: d, credit: tx.filter((t) => t.type === 'credit').reduce((s, t) => s + t.amount, 0), payment: tx.filter((t) => t.type === 'payment').reduce((s, t) => s + t.amount, 0) });
    }
    const pendingClaims = claims(state).filter((k) => k.status === 'pending' && k.type !== 'check');
    const prof = shopProfile(state, 90);
    return {
      shop: state.shop.name, asOf: T, windowDays: days,
      outstanding: Math.round(totalOutstanding(state)), owingCount: owing.length,
      overdueAmount: Math.round(overdue.reduce((s, x) => s + x.amount, 0)), overdue,
      collectionRate: dueTotal ? paidTotal / dueTotal : null, onTimeRate: dueTotal ? onTime / dueTotal : null, dueInWindow: Math.round(dueTotal),
      avgDaysToRecover: prof.avgDaysToRecover, pendingCash: pendingClaims.reduce((s, k) => s + k.amount, 0), pendingCount: pendingClaims.length,
      daily
    };
  }

  // -------------------------------------------------------- LLM parsing
  /** Prompt + JSON schema for an LLM parser that returns the same intent shape as parseOwnerMessage. */
  function llmRequestParts(text, state) {
    const names = state.customers.map((c) => c.name).join(', ') || '(none yet)';
    const system = 'You turn a kirana shop owner\'s message (Hindi, Hinglish or English, often a speech-to-text transcript, possibly in Devanagari) into one ledger action for their udhaar (credit) book. ' +
      'Today is ' + state.today + ' (' + WEEKDAYS_HI[toDate(state.today).getUTCDay()] + '). Existing customers: ' + names + '.\n' +
      'intent: credit = customer took goods / money on credit ("liya", "le gaya", "udhaar likho"); payment = customer paid back ("jama", "de diye", "chuka diya"); ' +
      'query = balance of one customer; summary = overall hisaab; remind = send reminder to one customer; remind_all = remind everyone who owes; ' +
      'undo = cancel the last entry; set_phone = save a customer\'s phone number; promise = customer promised to pay on a date; help; unknown.\n' +
      'name: the customer as the owner said it in Latin script with honorific (e.g. "Sharma ji"); reuse the existing spelling when it is clearly the same person; "" if none. ' +
      'items: what was bought, short, in the owner\'s words (e.g. "2 kilo cheeni, tel"), "" if not said. amount: rupees as a number, 0 if none (convert "dedh sau" to 150, "2 hazaar" to 2000). due_date: YYYY-MM-DD for any promised payment date, resolving weekdays and "kal" relative to today; "" if none. phone: 10-digit number or "".';
    const schema = {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['credit', 'payment', 'query', 'summary', 'remind', 'remind_all', 'undo', 'set_phone', 'promise', 'help', 'unknown'] },
        name: { type: 'string' }, items: { type: 'string' }, amount: { type: 'number' }, due_date: { type: 'string' }, phone: { type: 'string' }
      },
      required: ['intent', 'name', 'items', 'amount', 'due_date', 'phone'], additionalProperties: false
    };
    return { system, schema, user: text };
  }
  /** Convert the LLM JSON into the intent shape used by applyIntent. */
  function intentFromLlm(j, text) {
    const tok = tokenize(j.name || '');
    return {
      intent: j.intent || 'unknown', name: j.name ? prettyName(tok.display) : null, nameKey: j.name ? nameKey(tok.norm) : null,
      items: j.items || '', amount: j.amount > 0 ? j.amount : null, dueDate: /^\d{4}-\d{2}-\d{2}$/.test(j.due_date || '') ? j.due_date : null,
      phone: /^\d{10}$/.test(j.phone || '') ? j.phone : null, raw: text, parser: 'llm'
    };
  }

  // ---------------------------------------------- copy photo: the paper copy stays, a photo feeds the khata
  // The owner keeps writing in the copy and sends one photo at closing. An AI that can see images turns the photo
  // into a "reading" (see copyReadRequest). Nothing is written until the owner taps ✅: each line is checked
  // against the khata, and lines already there are shown but never added twice.
  const COPY_SCHEMA = {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['per_customer', 'daily_list', 'balance_list', 'unclear'] },
      page_date: { type: 'string' },
      language: { type: 'string' },
      customer: { type: 'string' },
      lines: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, amount: { type: 'number' }, type: { type: 'string', enum: ['credit', 'payment', 'balance'] },
        date: { type: 'string' }, items: { type: 'string' }, raw: { type: 'string' }, sure: { type: 'boolean' }
      }, required: ['name', 'amount', 'type', 'date', 'items', 'raw', 'sure'] } }
    },
    required: ['format', 'page_date', 'language', 'customer', 'lines']
  };
  /**
   * mode 'setup': first day; the owner photographs the pages of the old copy and we want what each customer owes NOW (opening balances).
   * mode 'daily': the owner photographs today's page; we want each entry written today.
   */
  function copyReadRequest(state, mode) {
    const setup = mode === 'setup';
    const names = state.customers.map((c) => c.name).join(', ') || '(none yet)';
    return 'You are reading a photo of a handwritten udhaar (credit) copy from an Indian kirana shop. It may be in Hindi, Marathi, English or a mix, ' +
      'in Devanagari or Latin script, with Devanagari or Western digits and short forms (e.g. "Sh." for Sharma).\n' +
      'There are two common layouts:\n' +
      '- per_customer: the page belongs to ONE customer (name at the top); each row has a date, an amount, and whether it was udhaar/credit (often "naam", "udhaar", "baaki", left column) or jama/paid (often "jama", "जमा", "diya", right column).\n' +
      '- daily_list: the page is one day (date at the top); each line is a customer name and an amount, with "jama"/"जमा"/"pd"/"paid" or a tick meaning payment, otherwise credit.\n' +
      '- balance_list: a list of customers with what each one owes in total (baaki, बाकी, उधारी, total).\n' +
      (setup ? 'THE OWNER IS SETTING UP: for every customer on the page report ONE line with type "balance" and amount = what that customer owes now as written ' +
        '(the last running total or "baaki" on a per_customer page; the amount on a balance_list). Do not report individual rows.\n'
        : 'Report each written entry as one line of type "credit" or "payment".\n') +
      'Today is ' + state.today + '. The shop\'s customers: ' + names + '. When a written name is clearly one of these, use that spelling; otherwise write the name in Latin letters as written.\n' +
      'Rules: only report what is written; never invent a line, a name or an amount. If a number or name cannot be read, set "sure" to false and give your best reading in "raw". ' +
      'Ignore running totals, crossed-out lines and page numbers. Dates as YYYY-MM-DD (assume the current year when the year is missing; "" if no date). "customer" is the page\'s customer for per_customer pages, else "". ' +
      'If the photo is not a khata page, return format "unclear" and no lines.\n' +
      'Reply with only one JSON object with these keys: format, page_date, language, customer, lines (each line: name, amount, type, date, items, raw, sure). JSON schema: ' + JSON.stringify(COPY_SCHEMA);
  }
  /** Keep only well-formed lines from an AI reading; never trust its shape. */
  function cleanReading(r, today) {
    r = r && typeof r === 'object' ? r : {};
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d <= today ? d : '';
    const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    const format = ['per_customer', 'daily_list'].indexOf(r.format) >= 0 ? r.format : 'unclear';
    const pageDate = isDate(r.page_date), pageCust = str(r.customer, 40);
    const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 60).map((l) => {
      l = l && typeof l === 'object' ? l : {};
      const amount = Math.round(Number(String(l.amount).replace(/[^\d.]/g, '')) || 0);
      const name = str(l.name, 40) || (format === 'per_customer' ? pageCust : '');
      return { name, amount, type: l.type === 'payment' || l.type === 'balance' ? l.type : 'credit', date: isDate(l.date) || pageDate || today, items: str(l.items, 60), raw: str(l.raw, 80), sure: l.sure !== false };
    }).filter((l) => l.name && (l.amount > 0 || l.type === 'balance') && l.amount >= 0 && l.amount <= 100000);
    return { format, pageDate, customer: pageCust, language: str(r.language, 20), lines };
  }
  // Match one line to a customer and to the khata. `taken` holds txn ids already matched by other lines,
  // so two identical lines on the page match at most two identical khata entries.
  function checkCopyLine(state, l, taken) {
    let custId = l.custId || null, options = [];
    if (!custId && !l.newCustomer) {
      const m = findCustomers(state, nameKey(tokenize(l.name).norm));
      if (m.length === 1) custId = m[0].id; else options = m.map((c) => c.id);
    }
    l.custId = custId; l.options = options; l.txnId = null; l.adjust = null;
    if (l.type === 'balance') {
      // an opening balance: compare with what the khata says now, and propose only the difference
      if (!custId) { l.status = options.length > 1 ? 'ambiguous' : (l.amount > 0 ? 'newcust' : 'already'); l.adjust = l.amount; return l; }
      const diff = Math.round(l.amount - balance(state, custId));
      l.adjust = diff; l.status = Math.abs(diff) < 1 ? 'already' : 'new';
      return l;
    }
    if (custId) {
      const dup = state.txns.find((t) => !t.voided && !taken.has(t.id) && t.custId === custId && t.type === l.type &&
        Math.abs(t.amount - l.amount) < 0.5 && Math.abs(daysBetween(t.date, l.date)) <= 1);
      if (dup) { taken.add(dup.id); l.status = 'already'; l.txnId = dup.id; return l; }
      l.status = 'new';
    } else l.status = options.length > 1 ? 'ambiguous' : 'newcust';
    return l;
  }
  const reviewOf = (state, id) => (state.copyReviews || []).find((r) => r.id === id);
  function recheckReview(state, rv) {
    const taken = new Set(rv.lines.filter((l) => l.decision === 'ok' && l.txnId).map((l) => l.txnId));
    for (const l of rv.lines) if (l.decision === 'pending') checkCopyLine(state, l, taken);
  }
  function readCopy(state, reading, mode) {
    const out = [];
    state.messages.push({ id: nextId(state, 'M'), to: 'agent', from: 'owner', source: 'photo', text: '📷 Copy ka photo · ' + (mode === 'setup' ? 'purani copy (sabka baaki)' : 'aaj ka page'), date: state.today, ts: Date.now() });
    const r = cleanReading(reading, state.today);
    if (!r.lines.length) {
      emit(state, out, 'owner', r.format === 'unclear' ? 'Is photo mein khate ka page samajh nahi aaya. Page seedha rakhkar, achhi roshni mein dobara photo bhejiye.' : 'Page padha, par koi entry saaf nahi dikhi. Dobara photo bhejiye, ya voice note se bataiye.', { kind: 'copy' });
      return out;
    }
    const rv = { id: nextId(state, 'R'), date: state.today, format: r.format, pageDate: r.pageDate, customer: r.customer, language: r.language, open: true, lines: [] };
    const taken = new Set();
    r.lines.forEach((l, i) => rv.lines.push(checkCopyLine(state, Object.assign({ id: rv.id + '-' + (i + 1), decision: 'pending' }, l), taken)));
    (state.copyReviews = state.copyReviews || []).push(rv);
    const fresh = rv.lines.filter((l) => l.status !== 'already').length;
    emit(state, out, 'owner', 'Maine copy ka page padha' + (r.pageDate ? ' (' + fmtDate(r.pageDate) + ')' : '') + ': ' + rv.lines.length + ' line. ' +
      (fresh ? fresh + ' nayi entry; ' : 'Koi nayi entry nahi; ') + (rv.lines.length - fresh) + ' pehle se khate mein.\nHar line dekhiye: ✅ sahi, ✏️ badlo, ❌ chhodo. Jab tak aap ✅ nahi dabate, kuch nahi likha jaata.', { kind: 'copy-review', reviewId: rv.id });
    log(state, 'copy', 'read copy page: ' + rv.lines.length + ' lines, ' + fresh + ' new');
    return out;
  }
  function applyCopyLine(state, l) {
    let c = l.custId && getCust(state, l.custId);
    if (!c) { c = addCustomer(state, prettyName(tokenize(l.name).display) || l.name, nameKey(tokenize(l.name).norm), { createdAt: l.date }); l.custId = c.id; }
    if (l.type === 'balance') {
      // opening balance: one entry for the difference, dated today, so no reminder goes out for an old date
      const diff = l.custId && l.adjust != null ? l.adjust : l.amount;
      const tx = { id: nextId(state, 'T'), custId: c.id, amount: Math.abs(diff), date: state.today, note: l.raw || 'copy', source: 'copy', via: 'photo', matchedBy: 'copy ka photo, aapne confirm kiya' };
      if (diff > 0) { const due = c.dueDate && c.dueDate > state.today ? c.dueDate : addDays(state.today, state.shop.defaultDays || 7); state.txns.push(Object.assign(tx, { type: 'credit', items: 'purana baaki (copy se)', dueDate: due })); c.dueDate = due; }
      else { state.txns.push(Object.assign(tx, { type: 'payment', note: 'hisaab copy se milaya' })); if (balance(state, c.id) <= 0) { c.dueDate = null; c.reminderLevel = 0; } }
      l.txnId = tx.id; l.decision = 'ok';
      return c;
    }
    const base = { id: nextId(state, 'T'), custId: c.id, amount: l.amount, date: l.date, note: l.raw || 'copy', source: 'copy', via: 'photo', matchedBy: 'copy ka photo, aapne confirm kiya' };
    if (l.type === 'credit') {
      const due = c.dueDate && c.dueDate > state.today && balance(state, c.id) > 0 ? c.dueDate : addDays(l.date, state.shop.defaultDays || 7);
      state.txns.push(Object.assign(base, { type: 'credit', items: l.items || '', dueDate: due }));
      if (!c.dueDate || c.dueDate !== due) { c.dueDate = due; c.reminderLevel = 0; c.lastReminder = null; }
    } else {
      state.txns.push(Object.assign(base, { type: 'payment' }));
      if (balance(state, c.id) <= 0) { c.dueDate = null; c.reminderLevel = 0; }
    }
    l.txnId = base.id; l.decision = 'ok';
    return c;
  }
  /** One line: ok (write it), skip, or edit {custId | name (new customer), amount, type, date}. */
  function decideCopyLine(state, lineId, decision, edit) {
    const out = [];
    const rv = reviewOf(state, String(lineId).split('-')[0]);
    const l = rv && rv.open && rv.lines.find((x) => x.id === lineId);
    if (!l || l.decision !== 'pending') return out;
    if (decision === 'edit' && edit) {
      if (edit.custId && getCust(state, edit.custId)) { l.custId = edit.custId; l.newCustomer = false; l.name = getCust(state, edit.custId).name; }
      else if (edit.name) { l.name = String(edit.name).slice(0, 40).trim() || l.name; l.custId = null; l.newCustomer = !!edit.newCustomer; }
      if (+edit.amount >= (l.type === 'balance' ? 0 : 1) && +edit.amount <= 100000) l.amount = Math.round(+edit.amount);
      if (['credit', 'payment', 'balance'].indexOf(edit.type) >= 0) l.type = edit.type;
      if (/^\d{4}-\d{2}-\d{2}$/.test(edit.date || '') && edit.date <= state.today) l.date = edit.date;
      l.sure = true; l.edited = true;
      recheckReview(state, rv);
      return out;
    }
    if (decision === 'skip') l.decision = 'skip';
    else if (decision === 'ok') {
      if (l.status === 'already' || l.status === 'ambiguous') return out; // already in the khata, or the owner must pick who
      applyCopyLine(state, l);
      recheckReview(state, rv);
    }
    closeIfDone(state, rv, out);
    return out;
  }
  function closeIfDone(state, rv, out) {
    if (rv.lines.some((l) => l.decision === 'pending' && l.status !== 'already')) return;
    rv.open = false;
    const added = rv.lines.filter((l) => l.decision === 'ok');
    const names = [...new Set(added.map((l) => getCust(state, l.custId).name))];
    emit(state, out, 'owner', added.length ? '✅ Copy se ' + added.length + ' entry khate mein likh di.' + names.map((n) => {
      const c = state.customers.find((x) => x.name === n); return '\n' + n + ': baaki ' + rupees(Math.max(0, balance(state, c.id)));
    }).join('') + '\nReminder aur cash ka hisaab ab pehle jaisa chalega.' : 'Copy ke page se kuch nahi likha.', { kind: 'copy' });
  }
  /** "Sab sahi ✅": write every new line still waiting; lines that need a choice stay open. */
  function confirmCopyAll(state, reviewId) {
    const out = [];
    const rv = reviewOf(state, reviewId); if (!rv || !rv.open) return out;
    for (const l of rv.lines) if (l.decision === 'pending' && (l.status === 'new' || l.status === 'newcust')) { applyCopyLine(state, l); recheckReview(state, rv); }
    const left = rv.lines.filter((l) => l.decision === 'pending' && l.status === 'ambiguous');
    if (left.length) emit(state, out, 'owner', left.length + ' line mein naam pakka nahi: ' + left.map((l) => l.name).join(', ') + '. ✏️ dabakar grahak chuniye.', { kind: 'copy' });
    closeIfDone(state, rv, out);
    return out;
  }

  // ---------------------------------------------- do-taraf khata: the customer checks every entry
  // Each new entry, and the monthly statement, reaches the customer with "Haan, sahi hai" / "Galat hai".
  // Haan puts a ✓ in the owner's khata. Galat goes into the owner's evening ✅/❌ batch, like a disputed cash claim.
  const typeHi = (t) => (t.type === 'credit' ? 'udhaar' : 'jama');
  function notifyEntries(state, out, txns) {
    for (const t of txns) {
      const c = getCust(state, t.custId);
      if (!c || !c.phone || t.voided || t.note === 'seed' || t.source === 'upi' || t.via === 'customer') continue;
      const bal = balance(state, c.id);
      emit(state, out, c.id, '📒 ' + state.shop.name + ': aapke khate mein ' + fmtDate(t.date) + ' ko ' + rupees(t.amount) + ' ' + typeHi(t) +
        (t.items ? ' (' + t.items + ')' : '') + ' likha gaya.\nKul baaki: ' + rupees(Math.max(0, bal)) + '\nSahi hai? (24 ghante mein jawab na aaye toh sahi maana jayega)', { kind: 'entry-check', txnId: t.id });
    }
  }
  function sendStatements(state) {
    const out = [];
    const month = MONTHS[+state.today.slice(5, 7) - 1] + ' ' + state.today.slice(0, 4);
    let n = 0;
    for (const c of state.customers) {
      const bal = Math.round(balance(state, c.id));
      if (!c.phone || bal <= 0) continue;
      const recent = state.txns.filter((t) => t.custId === c.id && !t.voided).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).slice(-4).map((t) => '  ' + fmtDate(t.date) + ': ' + rupees(t.amount) + ' ' + typeHi(t)).join('\n');
      emit(state, out, c.id, '📄 ' + state.shop.name + ' · ' + month + ' ka hisaab\nAapke naam: ' + rupees(bal) + ' baaki\nPichli entries:\n' + recent + '\nKya yeh hisaab sahi hai? (24 ghante mein jawab na aaye toh sahi maana jayega)', { kind: 'statement', balance: bal });
      n++;
    }
    emit(state, out, 'owner', n ? '📄 ' + n + ' grahakon ko mahine ka hisaab bheja. Jo "Haan" kahenge, unke khate mein ✓ lagega; jo "Galat" kahenge, woh shaam ke ✅/❌ mein aayenge.' : 'Kisi ka baaki nahi, hisaab bhejne ki zaroorat nahi.', { kind: 'statement-sent' });
    log(state, 'statement', 'monthly statement sent to ' + n);
    return out;
  }
  function answerCheck(state, custId, msgId, ok) {
    const out = [];
    const c = getCust(state, custId);
    const m = state.messages.find((x) => x.id === msgId && x.to === custId && (x.kind === 'entry-check' || x.kind === 'statement'));
    // after 24 hours of silence the entry counts as accepted, but the customer can still say "galat hai"
    if (!c || !m || (m.answer && !(m.answer === 'auto' && !ok))) return out;
    m.answer = ok ? 'ok' : 'wrong';
    const t = m.txnId && state.txns.find((x) => x.id === m.txnId);
    if (m.kind === 'entry-check' && (!t || t.voided)) { m.answer = 'gone'; return out; }
    const label = m.kind === 'statement' ? rupees(m.balance) + ' ka mahine ka hisaab' : rupees(t.amount) + ' ' + typeHi(t) + ' (' + fmtDate(t.date) + ')';
    if (t) delete t.custAuto; else delete c.statementAuto;
    if (ok) {
      if (t) t.custOk = state.today; else c.statementOk = { date: state.today, balance: m.balance };
      emit(state, out, c.id, 'Dhanyavaad 🙏 Aapne ' + label + ' sahi bataya.', { kind: 'check-ok' });
      log(state, 'check', c.name + ' confirmed ' + label);
      return out;
    }
    const k = { id: nextId(state, 'K'), custId: c.id, type: 'check', origin: 'customer-check', what: m.kind === 'statement' ? 'statement' : 'entry', txnId: t ? t.id : null,
      amount: t ? t.amount : m.balance, label, date: state.today, status: 'pending' };
    claims(state).push(k);
    if (t) { t.custWrong = state.today; delete t.custOk; } else delete c.statementOk;
    emit(state, out, c.id, 'Theek hai, ' + label + ' par aapka sawaal dukaandaar ko bhej diya. Woh aaj shaam dekhkar theek karenge.', { kind: 'check-wrong' });
    emit(state, out, 'owner', '⚠️ ' + c.name + ' ne ' + label + ' ko galat bataya. Shaam ke hisaab mein ✅/❌ se tay kijiye.', { kind: 'check' });
    log(state, 'check', c.name + ' disputed ' + label);
    return out;
  }
  // The owner settles a customer's "galat hai": ✅ keeps the entry, ❌ admits the mistake (an entry is removed).
  function resolveCheck(state, k, c, ok, out) {
    const t = k.txnId && state.txns.find((x) => x.id === k.txnId);
    if (ok) {
      k.status = 'kept';
      emit(state, out, 'owner', '👍 ' + c.name + ' ka ' + k.label + ' jaisa likha hai waisa rahega. Unse ek baar baat kar lijiye.', { kind: 'cash-done' });
      if (c.phone) emit(state, out, c.id, c.name + ' 🙏 dukaandaar ke hisaab se ' + k.label + ' sahi hai. Dukaan par ek baar baat kar lijiye.', { kind: 'dispute' });
    } else {
      k.status = 'fixed';
      if (t && !t.voided) { t.voided = true; t.voidReason = 'customer ne galat bataya, dukaandaar ne maana'; }
      const bal = balance(state, c.id);
      if (bal <= 0) { c.dueDate = null; c.reminderLevel = 0; }
      emit(state, out, 'owner', '✅ Galti theek ki: ' + c.name + (t ? ' ki ' + k.label + ' wali entry hata di.' : ' ka hisaab dobara dekhna hai.') + ' Baaki: ' + rupees(Math.max(0, bal)), { kind: 'cash-done' });
      if (c.phone) emit(state, out, c.id, 'Maafi 🙏 ' + (t ? k.label + ' wali entry hata di gayi.' : 'hisaab dobara dekh rahe hain.') + ' Abhi baaki: ' + rupees(Math.max(0, bal)) + '\n- ' + state.shop.name, { kind: 'receipt' });
    }
    log(state, 'check', c.name + ' check ' + k.status);
    return out;
  }
  /** Open "galat hai" questions for a customer (shown in the baaki list). */
  // No reply within 24 hours (by the next day) counts as accepted: marked separately from a real "haan".
  function autoAccept(state) {
    const out = [];
    for (const m of state.messages) {
      if ((m.kind !== 'entry-check' && m.kind !== 'statement') || m.answer || daysBetween(m.date, state.today) < 1) continue;
      const c = getCust(state, m.to); if (!c) continue;
      const t = m.txnId && state.txns.find((x) => x.id === m.txnId);
      if (m.kind === 'entry-check' && (!t || t.voided)) { m.answer = 'gone'; continue; }
      m.answer = 'auto';
      if (t) { t.custOk = state.today; t.custAuto = true; } else { c.statementOk = { date: state.today, balance: m.balance }; c.statementAuto = true; }
      out.push(c.name);
    }
    if (out.length) log(state, 'check', '24h no reply, accepted: ' + out.join(', '));
    return out;
  }
  const openChecks = (state, custId) => claims(state).filter((k) => k.type === 'check' && k.status === 'pending' && k.custId === custId).length;

  // ---------- one entry point for every user action (used by the web page and by the per-shop server) ----------
  const ACTIONS = ['owner', 'upi', 'customer', 'confirm', 'galla', 'closeDay', 'nextDay', 'consentRequest', 'consentAnswer', 'consentRevoke', 'copyRead', 'copyDecide', 'copyConfirmAll', 'statements', 'customerCheck'];
  const looksLikeUpiSms = (t) => /(credited|received|recd)/i.test(t) && /(rs\.?|inr|₹)\s*[\d,]+/i.test(t);
  /** A fresh demo shop with its welcome message. */
  function freshShop(which, today) {
    const state = seedDemo(createState({ today }), which);
    const first = String(state.shop.owner || '').split(' ')[0] || 'Malik';
    const intro = state.customers.length
      ? 'Bas boliye ya likhiye, jaise "Sharma ji ne 340 ka saaman liya, kal denge". Main khata likhunga, grahak se WhatsApp par "sahi hai?" puchunga, aur reminder aur cash/UPI ka hisaab khud sambhal lunga.'
      : 'Khata abhi khali hai. Har grahak ka baaki bolkar bataiye, jaise "Sharma ji ke 1240 baaki hain". (Experimental: Purani copy ke page ka 📷 photo bhi bhej sakte hain.)';
    state.messages.push({ id: 'W1', to: 'owner', from: 'agent', text: 'Namaste ' + first + ' ji 🙏 Main ' + state.shop.name + ' ka Udhaar Agent hoon.\n' + intro, date: state.today, ts: Date.now() });
    return state;
  }
  /**
   * Apply one action. args.intent (optional, for 'owner') is an already-understood intent, e.g. from an LLM.
   * Returns { result, freshTxn } where freshTxn is the id of a newly written txn, if any.
   */
  function runAction(state, action, args) {
    args = args || {};
    if (ACTIONS.indexOf(action) < 0) throw new Error('unknown action: ' + action);
    const before = state.txns.length;
    const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500).trim();
    let result;
    if (action === 'owner' || action === 'upi') {
      const text = str(args.text);
      if (!text) throw new Error('text required');
      if (action === 'upi' || looksLikeUpiSms(text)) result = handleUpiNotification(state, text);
      else {
        const source = args.source === 'voice' ? 'voice' : 'text';
        result = handleOwnerMessage(state, text, { source, intent: args.intent });
        const om = state.messages.filter((m) => m.from === 'owner').pop();
        if (om && args.dur) om.dur = Math.min(120, Math.max(1, Math.round(+args.dur) || 1));
        const parser = (args.intent && args.intent.parser) || 'rules';
        for (const m of (result && result.messages) || []) if (m.to === 'owner') m.parser = parser;
      }
    } else if (action === 'customer') {
      if (!getCust(state, args.custId)) throw new Error('unknown customer');
      result = handleCustomerMessage(state, args.custId, str(args.text));
    } else if (action === 'confirm') result = confirmCash(state, str(args.claimId, 40), !!args.ok);
    else if (action === 'galla') result = scanCounterSpeech(state, str(args.text));
    else if (action === 'closeDay') result = runEveningSummary(state);
    else if (action === 'nextDay') { result = advanceDay(state); autoAccept(state); }
    else if (action === 'consentRequest') result = requestConsent(state, str(args.custId, 20));
    else if (action === 'consentAnswer') result = answerConsent(state, str(args.custId, 20), !!args.yes);
    else if (action === 'consentRevoke') result = revokeConsent(state, str(args.custId, 20));
    else if (action === 'statements') result = sendStatements(state);
    else if (action === 'customerCheck') result = answerCheck(state, str(args.custId, 20), str(args.msgId, 20), !!args.ok);
    else if (action === 'copyRead') result = readCopy(state, args.reading, args.mode === 'setup' ? 'setup' : 'daily');
    else if (action === 'copyDecide') result = decideCopyLine(state, str(args.lineId, 20), str(args.decision, 10), args.edit && typeof args.edit === 'object' ? args.edit : null);
    else if (action === 'copyConfirmAll') result = confirmCopyAll(state, str(args.reviewId, 20));
    const t = state.txns.length > before ? state.txns[state.txns.length - 1] : null;
    const added = state.txns.slice(before);
    if (added.length) { const extra = []; notifyEntries(state, extra, added); if (Array.isArray(result)) result.push(...extra); else if (result && Array.isArray(result.messages)) result.messages.push(...extra); }
    // the monthly statement goes out by itself on the 1st
    if (action === 'nextDay' && state.today.slice(8) === '01' && state.statementFor !== state.today.slice(0, 7)) {
      state.statementFor = state.today.slice(0, 7);
      const st = sendStatements(state); if (Array.isArray(result)) result.push(...st);
    }
    return { result, freshTxn: t ? t.id : null };
  }

  return {
    // pipeline
    createState, seedDemo, handleOwnerMessage, parseOwnerMessage, applyIntent, recordOwnerMessage,
    handleUpiNotification, parseUpiText, handleCustomerMessage, confirmCash, pendingCash, scanCounterSpeech, runMorningJobs, runEveningSummary, advanceDay,
    // ledger + scores
    balance, totalOutstanding, customerScore, consentOf, requestConsent, answerConsent, revokeConsent, lenderView, DEMO_LENDER, shopProfile, dashboard, DEMO_SHOPS, creditHistory, findCustomers, upiLink,
    // llm
    llmRequestParts, intentFromLlm, copyReadRequest, cleanReading, COPY_SCHEMA,
    // shared action layer
    runAction, freshShop, looksLikeUpiSms, ACTIONS, openChecks, autoAccept,
    // utils
    transliterate, tokenize, addDays, daysBetween, fmtDate, fmtDay, rupees
  };
});
