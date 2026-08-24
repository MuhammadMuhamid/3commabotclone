# SR+Trend v5 — wire exits to your bot (bot.alphawebstudioz.com)

Apply these edits **in TradingView Pine Editor** on your SR+Trend v5 script.

---

## 1) Update header comment (optional)

Replace the old 3Commas-only header with:

```pine
// --- Custom FastAPI Signal Bot (alphawebstudioz) ---
// Webhook: https://bot.alphawebstudioz.com/api/webhooks/signal_bots
// Pine: Signal delivery = "Custom webhook bot"
// TV alert: "alert() function calls" ONLY (NOT "Order fills and alert()...")
// TV alert Message: {{alert_message}}
```

---

## 2) Inputs (1 General) — use on each chart

| Input | NEAR chart | TIA chart | ZEC chart |
|-------|------------|-----------|-----------|
| Signal delivery | Custom webhook bot | same | same |
| secret | `PASTE_YOUR_BOT_SECRET_HERE` | same | same |
| BUY quote USDT | `100.01` | `100.01` | `100.01` |
| symbol | `NEARUSDT` | `TIAUSDT` | `ZECUSDT` |

`SELL base qty` is only for **short entries** (you have shorts OFF). Long exits do **not** use it.

---

## 3) Replace the **entire bottom Alerts section**

**Delete** from:

```pine
//------------------------------------------------------------------------------
// Alerts: Custom FastAPI bot JSON only when ...
```

through the end of the file (`alert.freq_once_per_bar_close` for shortSignal).

**Paste** the contents of:

`deploy/SR-Trend-v5-custom-webhook-ALERTS.pine`

That adds **`longJustClosed`** → sends `"action":"sell"` when Long X / strategy.close exits.

---

## 4) TradingView alert (per symbol)

| Field | Value |
|-------|--------|
| Condition | SR+Trend v5 → **alert() function calls** only |
| Webhook URL | `https://bot.alphawebstudioz.com/api/webhooks/signal_bots` |
| Message | `{{alert_message}}` |

Do **not** use "Order fills and alert() function calls" — that sends **two** webhooks per signal (see `deploy/TRADINGVIEW-ALERT-FIX-DOUBLE.md`).

Exits use Pine `longJustClosed` + `alert()` (in `SR-Trend-v5-custom-webhook-ALERTS.pine`), not order-fill alerts.

---

## 5) Save → Add to chart → Recreate alerts

Delete old alerts and create new ones after saving the script (especially if condition was "Order fills and alert()...").
