# Udhaar Agent

An AI munshi for a kirana shop. The shopkeeper speaks a Hindi or Hinglish voice note ("Sharma ji ne 340 ka saaman liya, kal denge"), and the agent writes it into the khata. It sends the customer reminders that get firmer as the due ages, and it clears the due when the customer pays by cash or UPI. The Galla Mic writes the khata from the shopkeeper's normal talk at the counter. Each shop has its own agent with its own khata, and a dashboard shows the total baaki, who is late, and the collection rate. The khata also gives each customer a credit score, which a lender can see only if the customer says yes on their own phone.

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

## What is real and what is simulated

| Real (running code) | Simulated in the demo |
|---|---|
| Voice or text to khata (Hinglish and Devanagari), with the LLM or the offline rules | WhatsApp: messages show in the on-screen phones; none are sent |
| Reminder ladder on the due date, +3 days and +7 days | UPI: the pay sheet and bank SMS are generated; no money moves |
| Matching UPI SMS to customers; cash claims with the evening ✅/❌ batch | The lender (Saathi Finance) and the data share |
| Galla Mic: trigger words, drops chit-chat, cross-checks "N baaki" | 75 days of past khata for each demo shop, sized like a typical Nagpur general store: 24-25 customers on udhaar, up to about ₹4,000 each |
| Dashboard, credit score, consent rules | |

Live speech-to-text uses Chrome's speech recognition, which sends audio to Google's servers. The agent itself stores no audio.

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
| `SHOP` | Demo shop to seed: `gupta` or `balaji`. Default `gupta`. |
| `DATA_DIR` | Folder for the khata file (`<shop>.json`). Default `./data`. |
| `AGENT37_LLM_PROXY_URL` | OpenAI-compatible LLM router. Agent37 sets this on every instance. If it is unset, the offline rule parser does all the understanding. |
| `AGENT37_MANAGED_TOKEN` | Bearer token for that router. Agent37 sets it and renews it on restart; the server reads it on every call. |
| `LLM_MODEL` | Optional model id for the router. Unset means the router's default model. |
| `LLM_TIMEOUT_MS` | How long to wait for the LLM before the rules answer instead. Default `8000`. |
| `REAL_CLOCK` | `1` turns on the agent's own scheduler (on in the Docker image). When the calendar day changes it runs the morning reminders by itself, and at `EVENING_HOUR` (default `21`) it sends the evening summary and the cash ✅/❌ batch. The demo's **Agle din ➜** still jumps ahead; the real date never pulls the khata back. |
| `OTHER_SHOPS` | Optional links for the shop switcher: `Gupta Kirana Store\|https://...,Balaji Dairy & General\|https://...` |

When the LLM is slow, down, or replies with something that isn't a valid ledger action, the server uses the offline Hinglish rules for that message and the page shows "offline rules". An intent sent by the browser is ignored: the server decides what the words mean.

Endpoints: `GET /` (the page), `GET /healthz`, `GET /api/state`, `POST /api/act` with `{"action": "...", "args": {...}}`. Actions: `owner`, `upi`, `customer`, `confirm`, `galla`, `closeDay`, `nextDay`, `reset`.

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
- `dist/udhaar-agent.html`: the same page without `<html>`/`<head>`, the version published as the claude.ai artifact.

Edit `core/`, `web/` or `server/`, then rebuild. Never edit `dist/` by hand.

## Test

```
node --test test/core.test.js test/server.test.js
```

There are 27 tests:

- **Core (18):** parsing Hinglish and Devanagari (names, amounts, number words, dates, items), the ledger, the reminder ladder, UPI matching, cash claims and confirmation, the Galla Mic, two separate shops, the dashboard numbers, the credit score (cash never penalized, disputes cost points), and consent (nothing shared without yes, revoke, expiry, no number).
- **Server (9):**
  - each shop keeps its own khata file and it survives a restart
  - the page is served with the shop config
  - the full loop over HTTP
  - bad requests are refused without touching the khata
  - the LLM router is called with the right token
  - rules take over when the LLM fails, stalls or talks nonsense
  - consent over HTTP
  - the scheduler sends reminders on a new day and the evening summary once
  - the Dockerfile builds the page, turns the scheduler on, and listens on port 8000

## Layout

| Path | What it is |
|---|---|
| `core/agent-core.js` | The agent: parser, ledger, reminders, UPI and cash matching, Galla Mic scanner, credit score and consent, dashboard, two demo shops, and `runAction` (the one entry point the page and the server share). Pure JS; works in a browser and in Node. |
| `server/server.js` | One shop's agent server: khata on disk, LLM via the Agent37 router with the rules as fallback. |
| `Dockerfile` | The Agent37 custom image (port 8000). |
| `web/index.src.html` | The demo page: shop switcher, shopkeeper's phone, customer's phone, Galla Mic, credit score, baaki list, dashboard, bahi-khata. |
| `vendor/qrcode-generator.js` | QR code library for the UPI QR (MIT, Kazuhiko Arase). |
| `test/` | Tests. |
| `build.js` | Builds `dist/`. |
| `dist/` | Built pages. |

## Saved for the finale

- Real WhatsApp Business API messages instead of the on-screen phones.
- A real lender connection through an Account Aggregator, instead of the demo lender.
- On-device speech-to-text (for example Whisper), so counter audio never leaves the shop.
