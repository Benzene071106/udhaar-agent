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

test('copy photo, daily list: new lines proposed, lines already in the khata skipped, nothing written before ✅', () => {
  const s = C.freshShop('gupta', TODAY);
  C.runAction(s, 'owner', { text: 'Sharma ji ne 340 ka saaman liya, kal denge' });
  const before = s.txns.length, out0 = C.totalOutstanding(s);
  const reading = { format: 'daily_list', page_date: TODAY, language: 'hinglish', customer: '', lines: [
    { name: 'Sharma ji', amount: 340, type: 'credit', date: '', items: 'saaman', raw: 'Sharma 340', sure: true },     // voice note already logged it
    { name: 'पप्पू', amount: 50, type: 'credit', date: '', items: '', raw: 'पप्पू 50', sure: true },                 // Devanagari name
    { name: 'Verma', amount: 300, type: 'payment', date: '', items: '', raw: 'Verma 300 jama', sure: true },
    { name: 'Raju', amount: 80, type: 'credit', date: '', items: 'anda', raw: 'Raju 80', sure: false },               // not a customer yet
    { name: 'Junk', amount: 0, type: 'credit', date: '', items: '', raw: '', sure: true },                          // dropped
    { name: 'Future', amount: 10, type: 'credit', date: '2099-01-01', items: '', raw: '', sure: true }              // bad date becomes the page date
  ] };
  C.runAction(s, 'copyRead', { reading });
  const rv = s.copyReviews[0];
  assert.deepStrictEqual(rv.lines.map((l) => [l.name, l.status]), [['Sharma ji', 'already'], ['पप्पू', 'new'], ['Verma', 'new'], ['Raju', 'newcust'], ['Future', 'newcust']]);
  assert.strictEqual(rv.lines[4].date, TODAY);
  assert.strictEqual(s.txns.length, before, 'reading writes nothing');
  assert.ok(s.messages.some((m) => m.kind === 'copy-review' && m.reviewId === rv.id));
  // owner skips one line, edits Verma's amount, then "Sab sahi"
  C.runAction(s, 'copyDecide', { lineId: rv.lines[4].id, decision: 'skip' });
  C.runAction(s, 'copyDecide', { lineId: rv.lines[2].id, decision: 'edit', edit: { amount: 350 } });
  C.runAction(s, 'copyConfirmAll', { reviewId: rv.id });
  assert.strictEqual(rv.open, false);
  assert.strictEqual(s.txns.length, before + 3);
  assert.strictEqual(C.totalOutstanding(s), out0 + 50 - 350 + 80);
  const raju = s.customers.find((c) => c.name === 'Raju');
  assert.ok(raju && s.txns.some((t) => t.custId === raju.id && t.source === 'copy' && t.dueDate));
  // the same photo again: everything written is already in the khata; Verma's 300 is new (the owner wrote 350)
  C.runAction(s, 'copyRead', { reading });
  const rv2 = s.copyReviews[1];
  assert.deepStrictEqual(rv2.lines.map((l) => l.status), ['already', 'already', 'new', 'already', 'newcust']);
});

test('copy photo, one customer per page: old rows match the khata one to one; ambiguous names wait for a choice', () => {
  const s = C.freshShop('gupta', TODAY);
  const meena = s.txns.filter((t) => t.custId === 'C002' && !t.voided).slice(-3);
  const lines = meena.map((t) => ({ name: '', amount: t.amount, type: t.type, date: t.date, items: '', raw: '', sure: true }));
  lines.push({ name: '', amount: meena[0].amount, type: meena[0].type, date: meena[0].date, items: '', raw: 'written twice', sure: true });
  lines.push({ name: '', amount: 120, type: 'credit', date: TODAY, items: 'doodh', raw: '', sure: true });
  C.runAction(s, 'copyRead', { reading: { format: 'per_customer', page_date: '', language: 'hindi', customer: 'Meena didi', lines } });
  const rv = s.copyReviews[0];
  assert.deepStrictEqual(rv.lines.map((l) => l.status), ['already', 'already', 'already', 'new', 'new']);
  assert.ok(rv.lines.every((l) => l.custId === 'C002'));
  // ✅ on an "already" line does nothing
  const n = s.txns.length;
  C.runAction(s, 'copyDecide', { lineId: rv.lines[0].id, decision: 'ok' });
  assert.strictEqual(s.txns.length, n);
  // two customers share a surname: the line waits until the owner picks one
  for (const [id, name] of [['C098', 'Anil Rao'], ['C099', 'Sunil Rao']]) s.customers.push({ id, name, key: name.toLowerCase(), phone: null, vpas: [], dueDate: null, reminderLevel: 0 });
  C.runAction(s, 'copyRead', { reading: { format: 'daily_list', page_date: TODAY, language: '', customer: '', lines: [{ name: 'Rao', amount: 60, type: 'credit', date: '', items: '', raw: '', sure: true }] } });
  const rv2 = s.copyReviews[1];
  assert.strictEqual(rv2.lines[0].status, 'ambiguous');
  const m = s.txns.length;
  C.runAction(s, 'copyConfirmAll', { reviewId: rv2.id });
  assert.strictEqual(s.txns.length, m);
  assert.strictEqual(rv2.open, true);
  C.runAction(s, 'copyDecide', { lineId: rv2.lines[0].id, decision: 'edit', edit: { custId: 'C099' } });
  C.runAction(s, 'copyDecide', { lineId: rv2.lines[0].id, decision: 'ok' });
  assert.strictEqual(s.txns.length, m + 1);
  assert.strictEqual(rv2.open, false);
  // a photo that is not a khata page writes nothing and says so
  const r = C.runAction(s, 'copyRead', { reading: { format: 'unclear', lines: [] } }).result;
  assert.ok(r.some((x) => /samajh nahi aaya/.test(x.text)));
});

test('copy photo, first-day setup: opening balances fill an empty khata, and only differences are proposed later', () => {
  const s = C.freshShop('nayi', TODAY);
  assert.strictEqual(s.customers.length, 0);
  assert.match(s.messages[0].text, /baaki bolkar/);
  assert.match(s.messages[0].text, /Experimental/);
  assert.match(C.copyReadRequest(s, 'setup'), /SETTING UP/);
  assert.doesNotMatch(C.copyReadRequest(s, 'daily'), /SETTING UP/);
  const page = { format: 'balance_list', page_date: '', language: 'marathi', customer: '', lines: [
    { name: 'Sharma ji', amount: 1240, type: 'balance', date: '', items: '', raw: 'शर्मा जी 1240', sure: true },
    { name: 'Meena didi', amount: 700, type: 'balance', date: '', items: '', raw: '', sure: true },
    { name: 'Pappu', amount: 0, type: 'balance', date: '', items: '', raw: 'Pappu nil', sure: true }
  ] };
  C.runAction(s, 'copyRead', { reading: page, mode: 'setup' });
  const rv = s.copyReviews[0];
  assert.deepStrictEqual(rv.lines.map((l) => l.status), ['newcust', 'newcust', 'already']);
  C.runAction(s, 'copyConfirmAll', { reviewId: rv.id });
  assert.strictEqual(s.customers.length, 2);
  assert.strictEqual(C.totalOutstanding(s), 1940);
  const sharma = s.customers.find((c) => c.name === 'Sharma ji');
  assert.ok(sharma.dueDate > s.today, 'no reminder fires for an old date');
  // the next page repeats Sharma ji with a new total: only the 260 difference is proposed; Meena didi matches
  page.lines[0].amount = 1500;
  C.runAction(s, 'copyRead', { reading: page, mode: 'setup' });
  const rv2 = s.copyReviews[1];
  assert.deepStrictEqual(rv2.lines.map((l) => [l.status, l.adjust]), [['new', 260], ['already', 0], ['already', 0]]);
  C.runAction(s, 'copyConfirmAll', { reviewId: rv2.id });
  assert.strictEqual(C.balance(s, sharma.id), 1500);
  // the same customer twice on one page is written once
  C.runAction(s, 'copyRead', { reading: { format: 'balance_list', lines: [
    { name: 'Raju', amount: 300, type: 'balance', date: '', items: '', raw: '', sure: true },
    { name: 'Raju', amount: 300, type: 'balance', date: '', items: '', raw: '', sure: true }] } });
  C.runAction(s, 'copyConfirmAll', { reviewId: s.copyReviews[2].id });
  assert.strictEqual(C.balance(s, s.customers.find((c) => c.name === 'Raju').id), 300);
});

test('do-taraf khata: the customer confirms an entry with Haan, and the owner sees a tick', () => {
  const s = C.freshShop('gupta', TODAY);
  const r = C.runAction(s, 'owner', { text: 'Sharma ji ne 340 ka saaman liya, kal denge' });
  const ask = s.messages.find((m) => m.to === 'C001' && m.kind === 'entry-check');
  assert.ok(ask && ask.txnId === r.freshTxn && /Sahi hai\?/.test(ask.text));
  assert.ok(r.result.messages.includes(ask), 'the question is part of the action result');
  C.runAction(s, 'customerCheck', { custId: 'C001', msgId: ask.id, ok: true });
  const t = s.txns.find((x) => x.id === r.freshTxn);
  assert.strictEqual(t.custOk, TODAY);
  assert.strictEqual(ask.answer, 'ok');
  // answering twice does nothing; another customer cannot answer it
  const n = s.messages.length;
  C.runAction(s, 'customerCheck', { custId: 'C001', msgId: ask.id, ok: false });
  C.runAction(s, 'customerCheck', { custId: 'C002', msgId: ask.id, ok: false });
  assert.strictEqual(s.messages.length, n);
  // no WhatsApp number, UPI and the customer's own cash claim get no question
  C.runAction(s, 'owner', { text: 'Rohan ne 50 ka liya' });
  assert.ok(!s.messages.some((m) => m.to === 'C007' && m.kind === 'entry-check'));
  C.runAction(s, 'customer', { custId: 'C002', text: 'Cash de diya' });
  C.runAction(s, 'closeDay');
  const k = s.cashClaims.find((x) => x.status === 'pending' && x.custId === 'C002');
  C.runAction(s, 'confirm', { claimId: k.id, ok: true });
  assert.ok(!s.messages.some((m) => m.to === 'C002' && m.kind === 'entry-check'));
});

test('do-taraf khata: Galat hai goes to the evening batch; the owner keeps the entry or fixes it', () => {
  const s = C.freshShop('gupta', TODAY);
  const r1 = C.runAction(s, 'owner', { text: 'Sharma ji ne 340 ka saaman liya' });
  const r2 = C.runAction(s, 'owner', { text: 'Verma ji ne 180 ka tel liya' });
  const ask1 = s.messages.find((m) => m.kind === 'entry-check' && m.txnId === r1.freshTxn);
  const ask2 = s.messages.find((m) => m.kind === 'entry-check' && m.txnId === r2.freshTxn);
  const before = C.balance(s, 'C001');
  C.runAction(s, 'customerCheck', { custId: 'C001', msgId: ask1.id, ok: false });
  C.runAction(s, 'customerCheck', { custId: 'C005', msgId: ask2.id, ok: false });
  assert.strictEqual(C.openChecks(s, 'C001'), 1);
  assert.ok(s.messages.some((m) => m.to === 'owner' && m.kind === 'check' && /Sharma ji/.test(m.text)));
  assert.strictEqual(C.balance(s, 'C001'), before, 'a question changes nothing by itself');
  assert.strictEqual(C.dashboard(s).pendingCash, 0, 'not counted as cash');
  const batch = C.runAction(s, 'closeDay').result.find((m) => m.kind === 'cash-confirm');
  assert.strictEqual(batch.claimIds.length, 2);
  assert.match(batch.text, /galat bataya/);
  const [k1, k2] = batch.claimIds.map((id) => s.cashClaims.find((x) => x.id === id));
  // ❌ = the owner admits the mistake: the entry is removed and the customer told
  C.runAction(s, 'confirm', { claimId: k1.id, ok: false });
  assert.strictEqual(C.balance(s, 'C001'), before - 340);
  assert.ok(s.txns.find((t) => t.id === r1.freshTxn).voided);
  assert.ok(s.messages.some((m) => m.to === 'C001' && /hata di gayi/.test(m.text)));
  // ✅ = the entry stays; no score penalty for asking
  const score = C.customerScore(s, 'C005').score;
  C.runAction(s, 'confirm', { claimId: k2.id, ok: true });
  assert.ok(!s.txns.find((t) => t.id === r2.freshTxn).voided);
  assert.strictEqual(k2.status, 'kept');
  assert.strictEqual(C.customerScore(s, 'C005').score, score);
  assert.strictEqual(C.openChecks(s, 'C005'), 0);
});

test('do-taraf khata: monthly statement on the 1st, Haan ticks the balance, Galat goes to the batch', () => {
  const s = C.freshShop('gupta', '2026-10-31');
  const out = C.runAction(s, 'nextDay').result;
  const st = out.filter((m) => m.kind === 'statement');
  const owing = s.customers.filter((c) => c.phone && C.balance(s, c.id) > 0);
  assert.strictEqual(st.length, owing.length);
  assert.ok(st.every((m) => m.balance === Math.round(C.balance(s, m.to))));
  assert.strictEqual(C.runAction(s, 'statements').result.filter((m) => m.kind === 'statement').length, owing.length, 'the owner can also send it by hand');
  const a = st[0], b = st[1];
  C.runAction(s, 'customerCheck', { custId: a.to, msgId: a.id, ok: true });
  assert.deepStrictEqual(s.customers.find((c) => c.id === a.to).statementOk, { date: '2026-11-01', balance: a.balance });
  C.runAction(s, 'customerCheck', { custId: b.to, msgId: b.id, ok: false });
  const k = s.cashClaims.find((x) => x.type === 'check' && x.custId === b.to);
  assert.strictEqual(k.what, 'statement');
  C.runAction(s, 'confirm', { claimId: k.id, ok: false });
  assert.strictEqual(k.status, 'fixed');
  // the 2nd of the month sends nothing new
  assert.strictEqual(C.runAction(s, 'nextDay').result.filter((m) => m.kind === 'statement').length, 0);
});
