# Birr — SMS savings & expense tracker

PWA dashboard + Node backend + a thin Android SMS forwarder.
No runtime dependencies on the server (`node:http`, `node:sqlite`), none in the
Android app except `androidx.core` for the permission helper.

```
phone SMS ──► Android forwarder (filters senders) ──► POST /api/ingest
                                                          │
                                              parser.js ──┴──► SQLite ──► PWA dashboard
```

## 1. Run the server

Needs Node 22+ (for the built-in `node:sqlite`).

```bash
INGEST_TOKEN="$(openssl rand -hex 24)" node server.js    # listens on :8080
```

Keep that token — the Android app needs the same value. Put the server behind
HTTPS before pointing a phone at it (Caddy or a Cloudflare tunnel is enough;
the token travels in a header and must not go over plain HTTP).

Open `http://localhost:8080`, then "Add to home screen" to install the PWA.

## 2. Try it before touching Android

Paste real messages into the box at the bottom of the dashboard. This runs the
exact same parser the phone will feed, so it tells you whether your banks'
formats are handled before you build an APK. **Do this first.**

## 3. Build the forwarder

```bash
cd android && ./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk → copy to the phone and install
```

Open it, enter the server URL and token, grant SMS permission, and tap
"Import existing inbox" once to backfill history.

The receiver only forwards messages whose sender matches the allowlist in
`Forwarder.ALLOWED`. Everything else never leaves the phone. Failed sends are
queued (capped at 200) and retried on the next message.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/ingest` | Bearer token. `{sender, body, received_at}` or `{messages:[…]}` |
| POST | `/api/paste` | No auth (local use). `{text}` — blank line separates messages |
| GET | `/api/summary?period=…&date=…` | Totals, category split, bar series, last balances |
| GET | `/api/insights?period=…&date=…` | Savings read-out for the same period |
| GET | `/api/tx?period=…&date=…` | Transactions, newest first (`limit` up to 2000) |
| PATCH | `/api/tx/:id` | `{category, note}` |

Duplicates are suppressed by the bank's own reference when present, otherwise
by a hash of the message — so re-importing the inbox is safe.

## Filtering

`period` is `day`, `month`, `year` or `all`; `date` is any date inside it
(`YYYY-MM-DD`). The bar series re-buckets itself — by hour for a day, by day
for a month, by month for a year, by year for all time. The picker in the UI
only offers periods that actually contain transactions.

```bash
curl 'localhost:8080/api/summary?period=year&date=2026-01-01'
curl 'localhost:8080/api/insights?period=month&date=2026-09-01'
```

## Savings read-out

`insights.js` computes suggestions from your own rows only — no model, no
outside data, nothing stored. Each one states the figures behind it:

- savings rate, and what a 20% rate would have meant in birr
- the biggest category, its share, and what a 20% trim would free
- fees and charges, annualised from the months covered
- repeating payments (same counterparty, 3+ times, amounts within 35%)
- pace against the month, while the month is still running
- change against the previous period, when it moved 10% or more
- a target anchored to what you already kept without trying

These describe your history; they are not financial advice, and the balances
shown are whatever your bank last reported, not a reconciled figure.

## The Android app (TWA + forwarder in one)

One APK does both jobs: a Trusted Web Activity that opens the PWA full-screen
in Chrome with no URL bar, and the `SmsReceiver` that forwards bank messages.
First launch shows the setup screen; once the URL and token are saved it goes
straight to the dashboard, and setup stays reachable by long-pressing the app
icon.

Build it on GitHub Actions — no SDK download, no Android Studio:

```bash
git remote add origin git@github.com:<you>/birr.git
git push -u origin main
```

Then Actions → **Build APK** → Run workflow, entering your PWA's host. The APK
is in the run's artifacts.

### Dropping the URL bar

A TWA only hides browser UI when the site and the APK vouch for each other:

1. The build prints the signing certificate's SHA-256. Copy it from the
   "Print signing fingerprint" step.
2. Restart the server with it:
   `TWA_FINGERPRINT="AA:BB:…" INGEST_TOKEN=… node server.js`
   — it then serves `/.well-known/assetlinks.json`.
3. Build with `-PappHost=your-host` so the APK names the same site.

Get this wrong and the app still works; it just shows a Chrome address bar at
the top. Worth fixing, not worth blocking on.

Debug signing is fine for your own phone, but the fingerprint changes if you
ever switch to a release keystore — republish the new one if you do.

## Importing your whole history

"Import existing inbox" in the Android app reads the full inbox from the
beginning, filters to the allowlisted senders, and posts in batches of 100.
Dedupe makes it safe to run repeatedly — re-import after adding a bank rule
and only the newly parseable messages land.

## Adding a bank

Two edits in `parser.js`, both in the table at the top:

1. Add a row to `BANKS` with the sender id and a body hint.
2. If it uses wording the engine doesn't know, add the phrase to `CREDIT` or
   `DEBIT`.

Nothing else changes — amount, balance, reference, counterparty and date are
extracted generically. Anything that fails to parse is kept in the `unparsed`
table with a reason, so no message is silently lost:

```sql
SELECT reason, COUNT(*) FROM unparsed GROUP BY reason;
```

Run `node --test test/parser.test.js` after any rule change.

## Notes

- Times in the SMS are read as EAT (UTC+3) and stored as UTC.
- `balance` is whatever the bank last reported, not a computed figure.
- Play Store rejects most finance apps that ask for `READ_SMS`. Sideload the
  APK; if you later distribute it, that's the point to reconsider.
