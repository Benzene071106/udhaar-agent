// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core/agent-core.js');

const TODAY = '2026-10-07'; // Wednesday
const p = (t) => C.parseOwnerMessage(t, TODAY);

test('Hinglish credit with weekday promise', () => {
  const i = p('Sharma ji ne 340 ka saaman liya, Friday ko denge');
  assert.deepStrictEqual([i.intent, i.name, i.nameKey, i.amount, i.dueDate], ['credit', 'Sharma ji', 'sharma', 340, '2026-10-09']);
});
test('Devanagari voice transcript', () => {
  const i = p('शर्मा जी ने 340 का सामान लिया');
  assert.strictEqual(i.intent, 'credit'); assert.strictEqual(i.nameKey, 'sharma'); assert.strictEqual(i.amount, 340);
});
test('Devanagari payment', () => {
  const i = p('पप्पू ने 200 रुपए जमा किए');
  assert.strictEqual(i.intent, 'payment'); assert.strictEqual(i.nameKey, 'papu'); assert.strictEqual(i.amount, 200);
});
test('payment variants', () => {
  for (const t of ['Pappu ne 200 de diye', 'pappu ne 200 jama kiye', 'Pappu paid 200', 'Pappu ne udhaar ke 200 chuka diye']) {
    const i = p(t); assert.strictEqual(i.intent, 'payment', t); assert.strictEqual(i.amount, 200, t);
  }
});
test('credit variants', () => {
  for (const t of ['Ramesh 450 ka saman le gaya', 'Iqbal bhai ko 500 udhaar diya', 'Verma ji ke khate mein 150 likh do', 'Rohan took 120']) {
    assert.strictEqual(p(t).intent, 'credit', t);
  }
});
test('number words and dates', () => {
  assert.strictEqual(p('Meena didi ne dedh sau ka saman liya').amount, 150);
  assert.strictEqual(p('Meena didi ne do hazaar ka saman liya').amount, 2000);
  assert.strictEqual(p('Meena didi ne teen sau pachas rupaye ka saman liya').amount, 350);
  const i = p('Verma ji ne 600 liya, 15 tarikh ko denge');
  assert.strictEqual(i.amount, 600); assert.strictEqual(i.dueDate, '2026-10-15');
  assert.strictEqual(p('Verma ji ne 600 liya, kal denge').dueDate, '2026-10-08');
  assert.strictEqual(p('Verma ji ne 600 liya, 5 din mein denge').dueDate, '2026-10-12');
});
test('queries, summary, reminders, undo, phone', () => {
  assert.strictEqual(p('Sharma ji ka kitna baaki hai').intent, 'query');
  assert.strictEqual(p('kitna baki hai sharma ji ka').nameKey, 'sharma');
  assert.strictEqual(p('sabka hisaab batao').intent, 'summary');
  assert.strictEqual(p('Iqbal bhai ko yaad dila do').intent, 'remind');
  assert.strictEqual(p('sabko reminder bhejo').intent, 'remind_all');
  assert.strictEqual(p('galti ho gayi last wala cancel karo').intent, 'undo');
  const ph = p('Rohan ka number 9812345678'); assert.strictEqual(ph.intent, 'set_phone'); assert.strictEqual(ph.phone, '9812345678');
});

test('end to end: credit, reminder on due date, UPI tagged payment settles', () => {
  const s = C.createState({ today: TODAY });
  C.handleOwnerMessage(s, 'Sharma ji ne 340 ka saaman liya, Friday ko denge');
  C.handleOwnerMessage(s, 'Sharma ji ka number 9876500001');
  const c = s.customers[0];
  assert.strictEqual(C.balance(s, c.id), 340);
  C.advanceDay(s); const fri = C.advanceDay(s);
  const rem = fri.find((m) => m.to === c.id && m.kind === 'reminder');
  assert.ok(rem, 'reminder sent on promised day'); assert.match(rem.upi, /tn=UDH-C001/);
  const r = C.handleUpiNotification(s, 'Rs.340.00 credited to a/c XX1234 by VPA abc@ybl (UPI Ref No 427812345678) note UDH-C001');
  assert.strictEqual(C.balance(s, c.id), 0);
  assert.ok(r.some((m) => m.to === 'owner' && /clear/.test(m.text)));
  const dup = C.handleUpiNotification(s, 'Rs.340.00 credited to a/c XX1234 by VPA abc@ybl (UPI Ref No 427812345678)');
  assert.match(dup[0].text, /pehle hi/);
});

test('UPI by payer name, ambiguous asks owner, undo works', () => {
  const s = C.createState({ today: TODAY });
  C.handleOwnerMessage(s, 'Ramesh Sharma ne 500 ka saman liya');
  C.handleOwnerMessage(s, 'Iqbal bhai ne 300 ka saman liya');
  C.handleUpiNotification(s, 'Received Rs 200 from RAMESH SHARMA via PhonePe. UPI Ref 111122223333');
  assert.strictEqual(C.balance(s, s.customers[0].id), 300);
  const q = C.handleUpiNotification(s, 'Rs 300.00 credited by VPA 98xxxxxx@paytm Ref 999988887777');
  // 300 equals both balances -> must ask
  assert.ok(s.pending && s.pending.type === 'upi', JSON.stringify(q.map((m) => m.text)));
  C.handleOwnerMessage(s, '2');
  assert.strictEqual(C.balance(s, s.customers[1].id), 0);
  C.handleOwnerMessage(s, 'galti ho gayi cancel karo');
  assert.strictEqual(C.balance(s, s.customers[1].id), 300);
});

test('same surname twice asks which one', () => {
  const s = C.createState({ today: TODAY });
  C.handleOwnerMessage(s, 'Ramesh Sharma ne 500 ka saman liya');
  C.handleOwnerMessage(s, 'Suresh Sharma ne 200 ka saman liya');
  const r = C.handleOwnerMessage(s, 'Sharma ji ne 100 jama kiye');
  assert.match(r.messages[0].text, /Kaun se/);
  C.handleOwnerMessage(s, '2');
  assert.strictEqual(C.balance(s, s.customers[1].id), 100);
});

test('customer promise and scores on seeded data', () => {
  const s = C.seedDemo(C.createState({ today: TODAY }));
  const scores = s.customers.map((c) => [c.name, C.customerScore(s, c.id).score]);
  const meena = scores.find((x) => x[0] === 'Meena didi')[1], pappu = scores.find((x) => x[0] === 'Pappu')[1];
  assert.ok(meena > pappu, JSON.stringify(scores));
  const prof = C.shopProfile(s);
  assert.ok(prof.creditExtended > 0 && prof.recoveryRate > 0);
  const out = C.handleCustomerMessage(s, s.customers[2].id, 'bhaiya shanivar ko de dunga');
  assert.strictEqual(s.customers[2].dueDate, '2026-10-10');
  assert.ok(out.some((m) => m.to === 'owner'));
});

test('items and quantity vs amount', () => {
  const a = p('Sharma ji ne 340 ka saaman liya');
  assert.strictEqual(a.items, '');
  const b = p('Verma ji ne 2 kilo cheeni aur 1 litre tel liya 180 ka');
  assert.strictEqual(b.amount, 180); assert.strictEqual(b.items, '2 kilo cheeni, 1 litre tel');
  const c = p('Meena didi doodh aur bread le gayi 75 rupaye');
  assert.strictEqual(c.amount, 75); assert.strictEqual(c.nameKey, 'mina'); assert.strictEqual(c.items, 'doodh, bread');
  const d = p('पप्पू ने 2 किलो आटा लिया 90 का');
  assert.strictEqual(d.amount, 90); assert.match(d.items, /2 kilo aata/);
});

test('demo seed: one day ahead shows the whole reminder ladder', () => {
  const s = C.seedDemo(C.createState({ today: TODAY }));
  C.handleOwnerMessage(s, 'Sharma ji ne 340 ka saaman liya, kal denge');
  const out = C.advanceDay(s);
  const lv = (id) => (out.find((m) => m.to === id && m.kind === 'reminder') || {}).level;
  assert.deepStrictEqual([lv('C001'), lv('C003'), lv('C005'), lv('C002')], [1, 2, 3, undefined]);
  assert.ok(out.some((m) => m.kind === 'evening' && /Sharma ji/.test(m.text) === false || m.kind === 'evening'));
  const pay = C.handleUpiNotification(s, 'Rs.340.00 credited to a/c XX4521 by Sharma ji (VPA ramesh.sharma@okaxis) UPI Ref 600011112222 UDH-C001');
  assert.strictEqual(C.balance(s, 'C001'), 0);
  assert.ok(pay.some((m) => m.to === 'C001' && m.kind === 'receipt'));
  const ev = C.advanceDay(s).find((m) => m.kind === 'evening');
  assert.match(ev.text, /Sharma ji ₹340/);
});

test('cash: customer claims, owner confirms or disputes at closing; owner voice cash', () => {
  const s = C.seedDemo(C.createState({ today: TODAY }));
  assert.strictEqual(p('Sharma 200 cash').intent, 'payment');
  C.handleOwnerMessage(s, 'Sharma ji ne 340 ka saaman liya, kal denge');
  C.advanceDay(s); // 8 Oct: reminders
  C.handleCustomerMessage(s, 'C001', 'cash de diya');
  C.handleCustomerMessage(s, 'C003', 'bhaiya 100 cash diye the');
  assert.strictEqual(C.balance(s, 'C001'), 340, 'claim is not money yet');
  assert.strictEqual(C.pendingCash(s, 'C001'), 340);
  const ev = C.runEveningSummary(s);
  const batch = ev.find((m) => m.kind === 'cash-confirm');
  assert.strictEqual(batch.claimIds.length, 2);
  assert.strictEqual(C.runEveningSummary(s).length, 0, 'evening goes once a day');
  C.confirmCash(s, batch.claimIds[0], true);
  C.confirmCash(s, batch.claimIds[1], false);
  assert.strictEqual(C.balance(s, 'C001'), 0);
  assert.strictEqual(C.balance(s, 'C003'), 170);
  assert.ok(s.customers.find((c) => c.id === 'C003').disputed);
  C.handleCustomerMessage(s, 'C005', 'cash de diya 530');
  C.handleOwnerMessage(s, 'Verma 530 cash');
  assert.strictEqual(C.balance(s, 'C005'), 0);
  assert.strictEqual(C.pendingCash(s, 'C005'), 0);
  assert.strictEqual(s.txns[s.txns.length - 1].source, 'cash');
});

test('Galla Mic: drops chatter, logs a clean catch, queues an unsure one', () => {
  const s = C.seedDemo(C.createState({ today: TODAY }));
  const n0 = s.messages.length, t0 = s.txns.length;
  for (const line of ['Aaiye Meena didi, kya haal hai?', 'Doodh kitne ka hai aaj?', 'Kal India jeet gaya', 'Meena didi kitna baaki hai mera?'])
    assert.strictEqual(C.scanCounterSpeech(s, line).action, 'ignored', line);
  assert.strictEqual(s.messages.length, n0, 'chatter leaves no trace');
  const a = C.scanCounterSpeech(s, 'Meena didi, 500 jama kar liye, 200 baaki');
  assert.strictEqual(a.action, 'logged');
  assert.strictEqual(C.balance(s, 'C002'), 200);
  assert.strictEqual(C.scanCounterSpeech(s, 'Meena didi, 500 jama kar liye, 200 baaki').action, 'duplicate');
  const b = C.scanCounterSpeech(s, 'Pappu 2 kilo cheeni aur tel likh lo, 180 ka');
  assert.strictEqual(b.action, 'logged'); assert.strictEqual(C.balance(s, 'C003'), 350);
  const c = C.scanCounterSpeech(s, 'Verma ji 300 jama, baaki 100');
  assert.strictEqual(c.action, 'queued'); assert.strictEqual(C.balance(s, 'C005'), 530);
  const ev = C.runEveningSummary(s).find((m) => m.kind === 'cash-confirm');
  assert.match(ev.text, /Verma ji: ₹300 cash\? \(Galla Mic/);
  C.confirmCash(s, c.claim.id, true);
  assert.strictEqual(C.balance(s, 'C005'), 230);
  assert.strictEqual(C.scanCounterSpeech(s, 'Ramu ne 50 jama kiye').action, 'unclear');
  assert.ok(s.txns.length > t0);
});

test('two demo shops are separate, and the dashboard adds up', () => {
  const a = C.seedDemo(C.createState({ today: TODAY }), 'gupta');
  const b = C.seedDemo(C.createState({ today: TODAY }), 'balaji');
  assert.notStrictEqual(a.shop.name, b.shop.name);
  assert.ok(!b.customers.some((c) => c.name === 'Sharma ji'));
  const d = C.dashboard(b);
  // Nagpur scale: 20-30 customers on udhaar, none above about ₹4,000
  assert.ok(a.customers.length >= 20 && a.customers.length <= 30 && b.customers.length >= 20 && b.customers.length <= 30);
  assert.ok(b.customers.every((c) => C.balance(b, c.id) <= 4000));
  assert.strictEqual(d.outstanding, 240 + 900 + 460 + 250 + 120 + 28400);
  assert.deepStrictEqual(d.overdue.map((x) => x.name), ['Suresh driver', 'Mishra ji', 'Zade bhau', 'Khobragade ji']);
  assert.strictEqual(d.overdueAmount, 1360 + 3400 + 2900);
  assert.ok(d.collectionRate >= 0 && d.collectionRate <= 1);
  assert.strictEqual(d.daily.length, 14);
  const out = C.advanceDay(b);
  const lv = (id) => (out.find((m) => m.to === id && m.kind === 'reminder') || {}).level;
  assert.deepStrictEqual([lv('C001'), lv('C005'), lv('C003')], [1, 2, 3]);
  assert.strictEqual(out.filter((m) => m.kind === 'reminder').length, 3, 'the extra customers stay quiet on the demo day');
});

test('credit score: factors, cash is never penalized, disputes cost points', () => {
  const s = C.freshShop('gupta', TODAY);
  const meena = C.customerScore(s, 'C002'), pappu = C.customerScore(s, 'C003');
  assert.ok(meena.score > pappu.score);
  for (const k of ['onTimeRate', 'avgDelay', 'months', 'disputes', 'cashShare', 'upiShare', 'totalCredit']) assert.ok(k in meena, k);
  assert.ok(Math.abs(meena.cashShare + meena.upiShare - 1) < 1e-9);
  // the same history paid by UPI instead of cash gives the same score
  const s2 = JSON.parse(JSON.stringify(s));
  for (const t of s2.txns) if (t.custId === 'C002' && t.type === 'payment') t.source = t.source === 'upi' ? 'cash' : 'upi';
  assert.strictEqual(C.customerScore(s2, 'C002').score, meena.score);
  // a disputed cash claim lowers the score
  C.runAction(s, 'customer', { custId: 'C002', text: 'Cash de diya' });
  C.runAction(s, 'closeDay');
  const k = s.cashClaims.find((x) => x.status === 'pending' && x.custId === 'C002');
  C.runAction(s, 'confirm', { claimId: k.id, ok: false });
  const after = C.customerScore(s, 'C002');
  assert.strictEqual(after.disputes, 1);
  assert.ok(after.score < meena.score);
});

test('consent: nothing reaches the lender until the customer says yes, and it can be taken back', () => {
  const s = C.freshShop('gupta', TODAY);
  assert.deepStrictEqual(C.lenderView(s, 'C001'), { shared: false, status: 'none' });
  const ask = C.runAction(s, 'consentRequest', { custId: 'C001' }).result;
  assert.ok(ask.some((m) => m.to === 'C001' && m.kind === 'consent-ask' && /NAHI jayega/.test(m.text)));
  assert.strictEqual(C.lenderView(s, 'C001').shared, false, 'asking is not consent');
  C.runAction(s, 'consentAnswer', { custId: 'C001', yes: true });
  const v = C.lenderView(s, 'C001');
  assert.strictEqual(v.shared, true);
  assert.strictEqual(v.until, '2026-11-06');
  assert.ok(!('phone' in v.report) && !JSON.stringify(v.report).includes('9876500001'), 'no phone number');
  assert.ok(!JSON.stringify(v.report).includes('items'), 'no shopping list');
  C.runAction(s, 'consentRevoke', { custId: 'C001' });
  assert.deepStrictEqual(C.lenderView(s, 'C001'), { shared: false, status: 'revoked' });
  // no: nothing shared
  C.runAction(s, 'consentRequest', { custId: 'C002' });
  C.runAction(s, 'consentAnswer', { custId: 'C002', yes: false });
  assert.strictEqual(C.lenderView(s, 'C002').shared, false);
  // expiry after 30 days
  C.runAction(s, 'consentRequest', { custId: 'C004' });
  C.runAction(s, 'consentAnswer', { custId: 'C004', yes: true });
  s.today = '2026-11-07';
  assert.deepStrictEqual(C.lenderView(s, 'C004'), { shared: false, status: 'expired' });
  // no WhatsApp number: cannot ask, so cannot share
  const r = C.runAction(s, 'consentRequest', { custId: 'C007' }).result;
  assert.ok(r.some((m) => m.to === 'owner' && /number nahi/.test(m.text)));
  assert.strictEqual(C.consentOf(s, 'C007').status, 'none');
});
