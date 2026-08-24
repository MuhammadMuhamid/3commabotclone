# Fix: Duplicate buy/sell webhooks (2 alerts per signal)

## Cause

Your alert condition is:

**Order fills and alert() function calls**

That fires **two webhooks** every time:

| Source | What gets sent | Result |
|--------|----------------|--------|
| **Order fill** (strategy.entry / exit) | Often the literal text `{{alert_message}}` from the Message box | **401** (not valid JSON) |
| **Pine `alert()`** | Your real JSON (`secret`, `buy`/`sell`, symbol) | **Success** |

So you see **two lines** in the alert log at the same second. Sometimes both would be valid JSON (different `dedupe_key`) → **two Binance orders**.

## Fix (TradingView — required)

Edit **every** chart alert (NEAR, ZEC, TIA, …):

### Change this ONE setting

| Before | After |
|--------|--------|
| Order fills **and** alert() function calls | **alert() function calls** only |

(Exact wording may be **alert() function call** singular — pick the option that is **NOT** “order fills”.)

### Keep these the same

| Setting | Value |
|---------|--------|
| Message | `{{alert_message}}` |
| Webhook | `https://bot.alphawebstudioz.com/api/webhooks/signal_bots` |
| Notifications | Webhook ✓ |

### Do NOT use

- `Order fills and alert() function calls` ← causes duplicates  
- Static JSON in the Message box (use `{{alert_message}}` only)

After saving, **delete old alerts** and create new ones (or edit and Save).

---

## Pine script

Keep your `alert()` blocks at the bottom. No change needed if you switch TV to **alert() only**.

Optional guard (already in `SR-Trend-v5-custom-webhook-ALERTS.pine`):

```pine
if use_custom_webhook and (ALERT_SECRET == "REPLACE_ME" or str.length(ALERT_SECRET) < 32)
    runtime.error("Set [Custom bot] secret")
```

---

## Bot server (deployed)

Extra protection even if TV misconfigured:

- Rejects payloads containing `{{alert_message}}` or `{{strategy.order...}}`
- Ignores duplicate **buy/sell** for same secret + symbol within **45 seconds** (even if `dedupe_key` differs)

Redeploy backend after pulling latest code.

---

## Double “Buy” labels on chart

That can still happen if `longSignal` is true on **two bars** in a row (retest window). That is separate from double webhooks. Tighten entries in Pine if needed; webhook fix above stops double **orders**.
