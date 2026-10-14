# Udhaar Agent

An AI munshi for a kirana shop. The shopkeeper speaks a Hindi or Hinglish voice note ("Sharma ji ne 340 ka saaman liya, kal denge") and the agent writes it into the khata. **Do-taraf khata:** every new entry goes to the customer's WhatsApp with **Haan, sahi hai** / **Galat hai**, so both sides agree on the record (✓ in the owner's khata), and a "galat hai" lands in the owner's evening ✅/❌ batch. The agent sends reminders that get firmer as the due ages, and clears the due when the customer pays by cash or UPI. The Galla Mic writes the khata from the shopkeeper's normal talk at the counter. Each shop has its own agent with its own khata, and a dashboard shows the total baaki, who is late, and the collection rate. The khata also gives each customer a credit score, which a lender can see only if the customer says yes on their own phone. Reading a photo of the paper copy is kept as a **future / experimental** feature.

Everything after the voice note is simulated: no real WhatsApp messages are sent and no real UPI money moves.

## Open the demo (with the mic)

1. Open `dist/udhaar-agent-standalone.html` in **Google Chrome**. Double-clicking the file works.
2. Allow the microphone when Chrome asks.
3. **Voice note:** hold the green mic button in the shopkeeper's phone, speak in Hindi or Hinglish, then release.
4. **Galla Mic:** click **Mic chalu karein** in the Galla Mic card and talk normally. It only acts on lines with *jama, udhaar, baaki* or *likh lo*.
5. **Two shops:** switch between *Gupta Kirana Store* and *Balaji Dairy & General* at the top. Each has its own customers, khata and dashboard.

No internet is needed except for Chrome's speech recognition (Google's servers do the speech-to-text) and the fonts. Other browsers can't do the voice parts; use the sample voice-note chips and the counter-conversation buttons instead.

Demo flow (the 2-minute video follows it shot by shot in `demo-video-script.md`): **Demo dobara shuru** → the sample "Sharma ji ne 340 ka saaman liya, kal denge" → **Agle din ➜** → on Sharma ji's phone, tap **💵 Cash de diya** or **UPI se dein** → for cash, **Dukaan band 🌙**, then ✅ → scroll to **Dukaan ka haal** to see the numbers move → in the **Credit score** card, **Lender ne record maanga (demo)**, then **Haan, share karein** on the customer's phone.

Opened as a file, the demo keeps each shop's state in the browser's local storage. **Demo dobara shuru** resets the current shop.

## Do-taraf khata (customer confirms on WhatsApp)

- **Every new entry** (udhaar, or jama the owner reports) goes to the customer with **Haan, sahi hai** and **Galat hai**. Entries the customer reported themselves, UPI payments, old entries and customers without a number are not asked.
- **Haan** puts **✓ grahak ne maana** on that row of the owner's khata. **No reply within 24 hours** (by the next day) counts as accepted and shows as **✓ 24 ghante, jawab nahi**, kept separate from a real haan; the customer can still tap **Galat hai** after that.
- **Galat hai** goes into the owner's evening batch next to the cash claims. ✅ means the entry stays (the customer is told to talk at the shop); ❌ means it was a mistake, and the entry is removed with an apology to the customer. Neither one counts as a dispute in the credit score.
- **Monthly statement:** on the 1st of each month (or the **📄 Mahine ka hisaab** button) every customer with a balance gets their total and last entries, with the same two buttons. Haan shows **✓ Grahak ne maana** in the baaki list while the balance is unchanged.

## Bill with rates (no scanner)

Most kirana shops have no barcode or QR scanner, so the bill comes from the owner's voice. While packing, the owner already says the items and prices out loud: **"Sharma ji cheeni 2 kilo 90, tel 1 litre 180, sabun 40, kal denge"**.

- The agent splits it into lines, adds them up, and the customer's WhatsApp gets the list (`Cheeni 2 kilo = ₹90`, `Tel 1 litre = ₹180`, `Sabun = ₹40`, `Jod: ₹310`) with the same **Haan, sahi hai / Galat hai** buttons. A wrong item or rate is what gets disputed.
- **Daam yaad (rate memory):** every rate the owner speaks is remembered per kilo, litre, packet or piece. Next time **"Pappu ne 500 gram cheeni, sabun 2 aur adha litre tel liya"** is enough: the agent fills ₹23, ₹80 and ₹90 itself and says which rates came from memory. A new spoken rate replaces the old one, and the owner's reply says so (`Cheeni ₹45/kilo → ₹48/kilo`).
- **A total the owner says wins.** "300 ka saaman: dal 140, sabun 40" adds a `Baaki saaman = ₹120` line so the list still adds up. A remembered rate never overrides a spoken total; if they don't match, the entry stays one amount, as before.
- A rate the agent doesn't know is asked for once ("kaju ka daam abhi yaad nahi"), and nothing is written until the owner says it. No catalogue to set up.
- Time for the owner: 10 to 20 seconds of speaking for 5 or 6 items, done while packing. Nothing to tap.

### Counter bill (the shop's own talk)

Often the owner doesn't dictate a bill at all. They call the items out to a helper, and someone says the total out loud at the end. The owner holds the WhatsApp mic through that, and the agent turns the talk into the bill:

> "Aaiye Iqbal bhai. Raju, do kilo atta la, ek litre tel bhi nikal, maggi do. Kitna hua? 290"

- The items come from the orders (`Atta 2 kilo = ₹84`, `Tel 1 litre = ₹180`, `Maggi ×2 = ₹28`), priced from rate memory. "maggi do" means two.
- The total said aloud is the amount written, because it is what the customer heard. When the items don't add up to it, the owner sees `⚠️ Items ka jod ₹292, bola gaya total ₹290`, and both lists show the ₹2 as `Chhoot`.
- The customer is a khata name in the talk, preferring one said with "ji / bhai" or "ke khate mein". A name that only gets orders ("Raju, ... la") is the helper, never the customer. With no name heard, nothing is written, and the agent asks "Kiske khate mein likhun?". A bare name like "Pappu" finishes it.
- Chatter ("aur kuch? bas") is dropped. Only the bill is kept. The mic runs only while the owner holds it: there is no always-on listening.

## Copy photo (future / experimental)

Not the owner's first action: voice and text are. The 📷 button stays for trying it out. Reading accuracy on real handwritten copies is untested.


Two uses, one pipeline:

- **First day (setup):** the owner photographs each page of the old copy. The agent reads what each customer owes now and proposes opening balances. One **Sab sahi ✅** fills the khata, with no typing.
- **Every evening (daily page):** if the shop keeps a date-wise list, the owner photographs today's page. The agent proposes today's entries.

How it works:

1. An AI that can see images reads the photo into lines: name, amount, and udhaar, jama or total baaki. Hindi, Marathi, English, Devanagari or Latin script are all accepted. Unclear lines are marked "⚠ saaf nahi padha".
2. Each line is checked against the khata. An entry already there shows as "pehle se khate mein ✓" and is never added twice; matching is one to one, so two identical lines need two identical entries. For a total baaki, only the difference from the khata is proposed.
3. Nothing is written until the owner taps ✅ on a line or **Sab sahi ✅**. ✏️ changes the customer, amount or type; ❌ skips the line. A name that fits two customers waits until the owner picks one.
4. After ✅, reminders, cash claims and the dashboard carry on as before.

The photo itself is never stored, only the confirmed entries.

Where it runs:
- **Demo link:** reading uses the page's AI with image input, so the viewer is asked once to allow sending images.
- **Agent37 server:** reading uses `POST /api/photo` with the router's model. Set `VISION_MODEL` if the default model can't see images.
- **Standalone file and GitHub Pages:** there is no AI, so the page says so and reads nothing. It never guesses.

The **Purani copy ka page** and **Aaj ka page** samples draw a handwritten-style page in the browser and send that image to the AI. Nothing is pre-filled.

Real accuracy on handwritten copies is not yet measured. It needs real pages.

## What is real and what is simulated

| Real (running code) | Simulated in the demo |
|---|---|
| Customer Haan / Galat on each entry and monthly statement, ✓ in the khata, galat into the evening batch |  |
| Copy photo to khata, experimental (reading needs an AI; dedupe and ✅ are plain code) |  |
| Voice or text to khata (Hinglish and Devanagari), with the LLM or the offline rules | WhatsApp on the demo page: messages show in the on-screen phones (the shop server sends real ones through Twilio, see below) |
| Reminder ladder on the due date, +3 days and +7 days | UPI: the pay sheet and bank SMS are generated; no money moves |
| Matching UPI SMS to customers; cash claims with the evening ✅/❌ batch | The lender (Saathi Finance) and the data share |
| Galla Mic: trigger words, drops chit-chat, cross-checks "N baaki" | 75 days of past khata for each demo shop, sized like a typical Nagpur general store: 24-25 customers on udhaar, up to about ₹4,000 each |
| Dashboard, credit score, consent rules | |

Live speech-to-text on the demo page uses Chrome's speech recognition, which sends audio to Google's servers. WhatsApp voice notes go to our own Whisper server instead. The agent stores no audio.

## Real WhatsApp (owner and customers on their own phones)

The shop server talks on real WhatsApp through Twilio. The owner's number talks to the agent. Every other number is a customer.

- **Join in one scan.** `/join` shows a QR code. Scanning it opens WhatsApp with the join words already typed in. After that, one "hi" makes that number a customer under its WhatsApp name. If the owner already had a khata under that name with no number, the number is added to it.
- **Owner: text or voice note.** "Rohit ji cheeni 2 kilo 90, tel 1 litre 180" works as text or as a voice note. The agent replies `🎙️ Suna: "..."` so the owner sees what it heard before anything else happens.
- **Customer: one word.** Each entry arrives as an item-wise bill. The customer answers *Haan* or *Galat*. "cash de diya" makes a cash claim, and the owner is asked about it right away with `⏳ ... Jawab: haan / nahi`. The owner's one word settles it, and the customer gets a receipt. Pending items come one at a time.
- **No scanner, no QR stand.** A reminder carries the customer's own pay link (`/pay/<id>.<secret>`). It shows today's baaki and one UPI button with the amount already filled in. The same page says cash at the counter counts the same.
- **No cold messages.** The agent only messages numbers that wrote to the shop first. A number the owner typed in is used for matching, never for a first message.
- **Webhooks are signed.** Requests without a valid `X-Twilio-Signature` are refused. Without `TWILIO_AUTH_TOKEN` the `/whatsapp` endpoint doesn't exist.

Actions taken on the web page reach customers on WhatsApp but are not echoed to the owner, who is already looking at the page. Reminders and the evening summary from the scheduler go to both.

### Set it up (Twilio WhatsApp Sandbox, free)

1. Create a Twilio account. In the Console open Messaging, then *Try it out*, then *Send a WhatsApp message*. Note the Sandbox number (`+1 415 523 8886`) and your join words (`join <two-words>`).
2. In *Sandbox settings*, set "When a message comes in" to `https://<your-server>/whatsapp`, method `POST`.
3. Start the shop server with:

```
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_FROM=whatsapp:+14155238886 \
OWNER_WHATSAPP=+9198xxxxxxxx PUBLIC_URL=https://<your-server> WA_JOIN_CODE="join <two-words>" \
SHOP=nayi node server/server.js
```

4. The owner's phone sends the join words, then anything. Each customer scans `/join`. Sandbox members have to send the join words again after 3 days.

`GET /healthz` shows `whatsapp.received / sent / failed` and the last Twilio error.

### Voice notes (Whisper on a GPU)

Set `STT_URL` to any OpenAI-compatible speech-to-text server (`/audio/transcriptions`). `stt/whisper_server.py` is one: faster-whisper `large-v3` on a GPU, Hindi by default, nudged toward Hinglish in Roman letters. It is built for Nodus compute at the finale:

```
cd stt && pip install -r requirements.txt && STT_KEY=... uvicorn whisper_server:app --host 0.0.0.0 --port 9000
# shop server: STT_URL=https://<gpu-host>:9000/v1 STT_KEY=...
```

Voice notes are transcribed in memory and never stored. With Whisper on our own GPU, shop audio no longer goes to Google. Without `STT_URL`, the owner gets "Voice note abhi chalu nahi hai, likh kar bhejiye".

### Hindi voice notes for customers (ElevenLabs)

With `ELEVENLABS_API_KEY` set, a customer's new bill and each reminder also arrive as a short Hindi voice note in the shop's name, right after the text. It helps customers who listen more than they read. The text always goes first, and if ElevenLabs fails the text alone still arrives. The owner never gets voice notes. The audio stays in memory for an hour so Twilio can fetch it from `/media/<random id>.mp3`, and it is never written to disk. `ELEVENLABS_VOICE_ID` picks the voice (pick a Hindi voice from the ElevenLabs voice library). `ELEVENLABS_MODEL` defaults to `eleven_multilingual_v2`.

## Credit score and consent

The score (300 to 900) comes only from how the customer repays:

- the share of udhaar paid back on time
- the average days late
- how late any open due is now
- how long the record is
- disputed cash claims, 40 points each, up to 120

Cash or UPI is shown but never scored, so a customer who pays cash is not marked down.

A lender sees nothing by default. The flow works like India's Account Aggregator consent:

1. The lender asks. The customer gets a message on their own phone naming the lender, what would be shared (score, on-time rate, months of record) and what would not (what they bought, their number, any entry), and for how long (30 days).
2. Only **Haan** shares. **Nahi**, no reply, no WhatsApp number, or 30 days passing all mean nothing is shared.
3. The customer can take consent back at any time with **Ijaazat wapas lein**.

In code: `requestConsent`, `answerConsent`, `revokeConsent` and `lenderView` in `core/agent-core.js`. `lenderView` returns nothing but the status unless consent is granted and still valid.

## Run one shop's agent server

The server holds one shop's khata on disk and serves the same page. Every tap and voice note goes to the server, so the khata survives a reload and is the same on every device.

```
node build.js
SHOP=balaji PORT=8000 node server/server.js
```

Open http://localhost:8000. No npm install is needed.

| Variable | Meaning |
|---|---|
| `PORT` | Port to listen on. Default `8000`. |
| `SHOP` | Demo shop to seed: `gupta`, `balaji`, or `nayi` (an empty khata, for photo setup). Default `gupta`. |
| `VISION_MODEL` | Optional model id for reading copy photos; it must accept images. Unset means `LLM_MODEL` or the router's default. |
| `DATA_DIR` | Folder for the khata file (`<shop>.json`). Default `./data`. |
| `AGENT37_LLM_PROXY_URL` | OpenAI-compatible LLM router. Agent37 sets this on every instance. If it is unset, the offline rule parser does all the understanding. |
| `AGENT37_MANAGED_TOKEN` | Bearer token for that router. Agent37 sets it and renews it on restart; the server reads it on every call. |
| `LLM_MODEL` | Optional model id for the router. Unset means the router's default model. |
| `LLM_TIMEOUT_MS` | How long to wait for the LLM before the rules answer instead. Default `8000`. |
| `REAL_CLOCK` | `1` turns on the agent's own scheduler (on in the Docker image). When the calendar day changes it runs the morning reminders by itself, and at `EVENING_HOUR` (default `21`) it sends the evening summary and the cash ✅/❌ batch. The demo's **Agle din ➜** still jumps ahead; the real date never pulls the khata back. |
| `OTHER_SHOPS` | Optional links for the shop switcher: `Gupta Kirana Store\|https://...,Balaji Dairy & General\|https://...` |

When the LLM is slow, down, or replies with something that isn't a valid ledger action, the server uses the offline Hinglish rules for that message and the page shows "offline rules". An intent sent by the browser is ignored: the server decides what the words mean.

Endpoints: `GET /` (the page), `GET /healthz`, `GET /api/state`, `POST /api/act` with `{"action": "...", "args": {...}}`. Actions: `owner`, `upi`, `customer`, `confirm`, `galla`, `closeDay`, `nextDay`, `consentRequest`, `consentAnswer`, `consentRevoke`, `statements`, `customerCheck`, `copyDecide`, `copyConfirmAll`, `reset`. `POST /api/photo` with `{"image": "data:image/jpeg;base64,...", "mode": "daily" | "setup"}` reads a copy photo (409 `no_ai` when the server has no LLM). A reading sent by the browser to `/api/act` is refused.

## Deploy on Agent37 (one sandbox per shop)

Not done yet. These are the exact steps for a session that can reach `api.agent37.com`. Each shop gets its own Agent37 instance built from this folder.

**Why this counts as real Agent37 use.** The Hackyard Agent37 challenge checks that Agent37 is a working part of the build, not a static host. Here each instance *is* the shop's agent: it holds the khata on its disk, understands every voice note through `AGENT37_LLM_PROXY_URL` (billed to the Agent37 wallet), and runs the reminder scheduler itself. The web page is only a window onto it: every tap is a `POST /api/act` to the instance. `GET /healthz` shows `llm`, `scheduler`, `llmCalls` and `llmFallbacks`, so you can show the LLM is really being called.

**Proof the organizers ask for:** the instance ID from the Agent37 dashboard URL, and a screenshot of the dashboard showing the instance and its LLM usage. Take both after step 5, once a few voice notes have gone through.

**Before you start**

- Node.js 18 or newer, and network access to `api.agent37.com` and the npm registry.
- An Agent37 API key with a spending cap, in the environment variable `AGENT37_API_KEY`. Never paste the key into a file, a commit, or a chat.
- Run all commands from this folder (`hackyard/prototype/`).

**1. Check the key (read-only; creates and spends nothing)**

```
curl -sS "https://api.agent37.com/v1/usage?from=$(date -d '-7 days' +%F)&to=$(date +%F)" \
  -H "Authorization: Bearer $AGENT37_API_KEY"
```

A JSON reply with `total_micros` means the key works. A 401 means the key is wrong or revoked.

**2. Log the CLI in**

```
npx agent37 --help
```

Follow its login step with the same key. The help text shows whether it reads `AGENT37_API_KEY` directly or needs `npx agent37 login`.

**3. Build one template per shop**

The shop is set by the `ENV SHOP=` line in the `Dockerfile`. Build the Gupta template as the file is, then switch the line and build the Balaji template.

```
npx agent37 templates build . --name udhaar-gupta --default-port 8000

sed -i 's/^ENV SHOP=gupta$/ENV SHOP=balaji/' Dockerfile
npx agent37 templates build . --name udhaar-balaji --default-port 8000
sed -i 's/^ENV SHOP=balaji$/ENV SHOP=gupta/' Dockerfile
```

Each build prints the template name or image reference. Note both.

**4. Create one instance per shop**

```
for shop in gupta balaji; do
  curl -sS -X POST https://api.agent37.com/v1/instances \
    -H "Authorization: Bearer $AGENT37_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"udhaar-$shop\", \"template\": \"udhaar-$shop\", \"budget\": {\"credit_micros\": 1000000}}"
  echo
done
```

`budget.credit_micros: 1000000` caps each shop's LLM spend at $1. Each reply contains the instance `id` and its URL. Because the template declares port 8000, the bare instance URL routes to the page.

If the API rejects `template`, check `https://www.agent37.com/docs/agents-api/instances.md` and `.../templates.md` for the field name, and use the template id or image reference printed in step 3.

**5. Check both shops**

```
curl -sS https://<gupta-instance-url>/healthz
curl -sS https://<balaji-instance-url>/healthz
```

Each should answer with `"ok":true`, `"shop":"gupta"` (or `balaji`), `"llm":true` and `"scheduler":true`. `"llm": true` means Agent37 gave the instance its LLM router. Open each URL in Chrome: the header shows **Samajh: AI (Agent37)**, and **offline rules** if the LLM stops answering.

To make the shop switcher jump between the two live URLs, set `OTHER_SHOPS` on each instance if the instance API takes environment variables, or add an `ENV OTHER_SHOPS=...` line to the Dockerfile and rebuild both templates.

**6. Push the code**

The repository is `Benzene071106/udhaar-agent` (private). Copy the contents of this folder to the repo root (not the `data/` folder). From this folder:

```
git init -b main
git add .
git commit -m "Udhaar Agent prototype"
git remote add origin https://github.com/Benzene071106/udhaar-agent.git
git push -u origin main
```

`.gitignore` keeps `data/` (the khata files) and `.env` out of the repo.

**What the live mic needs**

The Galla Mic and voice notes use Chrome's speech recognition, which needs the page on `https://`. Agent37 instance URLs are `https://`, so the live mic works there. Speech-to-text runs on Google's servers; the agent keeps only the ledger lines, never audio.

## Build

Requires Node.js 18 or newer. No npm install is needed; there are no dependencies.

```
node build.js
```

This puts `vendor/qrcode-generator.js` and `core/agent-core.js` inside `web/index.src.html` and writes:

- `dist/udhaar-agent-standalone.html`: a full HTML page to open in Chrome. The server also serves this file.
- `dist/udhaar-agent.html`: the same page without `<html>`/`<head>`, the version published as the hosted demo link.

Edit `core/`, `web/` or `server/`, then rebuild. Never edit `dist/` by hand.

## Test

```
node --test test/core.test.js test/server.test.js test/whatsapp.test.js
```

There are 52 tests:

- **Core (33):** counter bill (items from orders to the helper, the spoken total wins and a gap is flagged, number words, the helper never becomes the customer, no name asks whose khata, dictated entries aren't mistaken for counter talk); bill with rates (spoken lines, the customer's list, rate memory with grams, half litres and counts, a stated total wins, a new rate replaces the old one, an unknown rate is asked for, Devanagari); do-taraf khata (Haan sets ✓, no reply in 24 hours counts as accepted but galat still works, answering twice or as someone else does nothing, who is not asked, Galat into the batch then ✅ keeps / ❌ removes with no score penalty, monthly statement on the 1st and by button); copy photo (daily page, one page per customer, first-day opening balances: dedupe against the khata, nothing written before ✅, edit, skip, ambiguous names, the same photo twice); parsing Hinglish and Devanagari (names, amounts, number words, dates, items), the ledger, the reminder ladder, UPI matching, cash claims and confirmation, the Galla Mic, two separate shops, the dashboard numbers, the credit score (cash never penalized, disputes cost points), and consent (nothing shared without yes, revoke, expiry, no number).
- **Server (10):**
  - each shop keeps its own khata file and it survives a restart
  - the page is served with the shop config
  - the full loop over HTTP
  - bad requests are refused without touching the khata
  - the LLM router is called with the right token
  - rules take over when the LLM fails, stalls or talks nonsense
  - consent over HTTP
  - copy photo over HTTP (the server's own AI reads it, the photo isn't stored, a browser-sent reading is refused, no AI returns `no_ai`)
  - the scheduler sends reminders on a new day and the evening summary once
  - the Dockerfile builds the page, turns the scheduler on, and listens on port 8000
- **WhatsApp (9):** ElevenLabs voice note after the text, Hindi script, audio served for Twilio, text alone when ElevenLabs fails; the stage loop over signed webhooks (a new number joins, gets the item-wise bill, says haan, says cash de diya, the owner says haan, receipt); unsigned webhooks refused; an owner voice note transcribed, echoed and written; voice refused without speech-to-text or from a non-Twilio URL; typed-in numbers never cold-messaged and web actions not echoed to the owner; galat hai settled by the owner's one word; the pay page needs its secret and shows cash on equal terms, and the join QR; one-word yes/no detection.

## Layout

| Path | What it is |
|---|---|
| `core/agent-core.js` | The agent: parser, ledger, reminders, UPI and cash matching, Galla Mic scanner, credit score and consent, dashboard, two demo shops, and `runAction` (the one entry point the page and the server share). Pure JS; works in a browser and in Node. |
| `server/server.js` | One shop's agent server: khata on disk, LLM via the Agent37 router with the rules as fallback. |
| `server/whatsapp.js` | Real WhatsApp through Twilio: signed webhook, owner and customer routing, voice notes, pay page, join QR. |
| `stt/whisper_server.py` | Hindi speech-to-text on a GPU (faster-whisper), OpenAI-compatible, for voice notes. |
| `Dockerfile` | The Agent37 custom image (port 8000). |
| `web/index.src.html` | The demo page: shop switcher, shopkeeper's phone, customer's phone, Galla Mic, credit score, baaki list, dashboard, bahi-khata. |
| `vendor/qrcode-generator.js` | QR code library for the UPI QR (MIT, Kazuhiko Arase). |
| `test/` | Tests. |
| `build.js` | Builds `dist/`. |
| `dist/` | Built pages. |

## Saved for the finale

- A WhatsApp Business number instead of the Twilio Sandbox, so customers don't need the join words.
- A real lender connection through an Account Aggregator, instead of the demo lender.
- Whisper for the Galla Mic and the web page too, so counter audio never goes to Google.
