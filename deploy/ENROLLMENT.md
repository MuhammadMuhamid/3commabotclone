# Exchange-key enrollment on the Bot origin (OD-4) — deployment notes

**Status: documented, NOT deployed.** Nothing in this file has been applied to any server.
`ENROLLMENT_ENABLED` defaults to `false`; while it is false the public routes answer 404 and
C0 does not advertise `enroll.v1`, so Trading Scene does not offer the feature.

## What it is

Trading Scene (the Platform) never receives exchange keys or webhook secrets. To add or replace
Binance keys, or to read a bot's webhook secret once, the operator:

1. steps up (fresh TOTP) in Trading Scene, which asks the Bot over the signed control channel for a
   ticket (`POST /api/manual-trading/control/exchange-enrollments`, C17);
2. is sent (top-level navigation) to `https://<bot>/enroll#t=<ticket>` — the ticket is in the URL
   fragment, so it is never sent to a server or in a Referer; the page strips it before any request;
3. the page exchanges the ticket for a 5-minute `enroll_session` cookie, then posts the keys (checked
   read-only with Binance, then encrypted on the Bot) or asks for the secret (shown once);
4. is sent back to `PLATFORM_RETURN_URL?enrollment=<id>&status=ok|failed`.

The ticket and the session token are 32 random bytes, stored only as SHA-256, single use, five
minutes each. Purpose, network, account and bot come only from the stored ticket.

## Environment (backend `.env`)

```
ENROLLMENT_ENABLED=true
# The Bot's public HTTPS origin. Also the ONLY Origin the enrollment API accepts.
PUBLIC_URL=https://bot.alphawebstudioz.com
# Exact return target in Trading Scene: absolute HTTPS, no query, no fragment.
PLATFORM_RETURN_URL=https://mytradingview.alphawebstudioz.com/bot/accounts
# Unchanged: CORS stays the Bot origin only. Never add the Platform origin (CORS is not authorization).
CORS_ORIGIN=https://bot.alphawebstudioz.com
```

The process refuses to start with `ENROLLMENT_ENABLED=true` and a non-HTTPS `PUBLIC_URL` or a
`PLATFORM_RETURN_URL` that is not an exact HTTPS URL.

## Why the Origin / Sec-Fetch-Site checks (X8)

The Platform (`mytradingview.alphawebstudioz.com`) and the Bot (`bot.alphawebstudioz.com`) are
**same-site**, so `SameSite=Strict` cookies do not separate them. Every `/api/enroll/*` request must
therefore carry `Origin: <PUBLIC_URL origin>`, `Sec-Fetch-Site: same-origin` and
`Content-Type: application/json`, or it is refused with 403 before its body is read. The JSON content
type also forces a CORS preflight for any cross-origin caller, which the Bot-origin-only CORS policy
refuses. The existing dashboard APIs are JSON-only and rely on the same preflight.

## Caddy (`platform/deployment/aws/bot-stack.sh` Caddyfile) — snippet

Keep `/api/enroll/*` **outside** the `@manualFromElsewhere` Platform-IP rule (the operator's browser
must reach it); `/api/manual-trading/*` stays Platform-IP only and HMAC-signed.

```
@enroll path /api/enroll/*
handle @enroll {
	request_body {
		max_size 4KB
	}
	reverse_proxy backend:4000
}

@enrollPage path /enroll /enroll.html
header @enrollPage {
	Cache-Control "no-store"
	Referrer-Policy "no-referrer"
	Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
}
```

`/enroll` itself is served by the frontend container, whose `nginx.conf` maps `location ~ ^/enroll(\.html)?$`
to `enroll.html` with the same headers. Caddy logs no request bodies by default; do not add a body log.

## Host nginx (`deploy/nginx-production.conf`) — snippet

Inside the `server { listen 443 … }` block, before `location /`:

```
# OD-4 enrollment API: tiny JSON bodies only.
location /api/enroll/ {
    client_max_body_size 4k;
    proxy_pass http://127.0.0.1:4000/api/enroll/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# OD-4 enrollment page: stricter document policy. add_header here replaces the
# server-level set, so every header is repeated.
location ~ ^/enroll(\.html)?$ {
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options        "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy        "no-referrer" always;
    add_header Cache-Control          "no-store" always;
    add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" always;
    proxy_pass http://127.0.0.1:8080;   # the frontend container
}
```

The alternative nginx stacks have **no** Platform-IP rule for `/api/manual-trading/*` (scout-4 §2e);
that gap is unchanged by this feature and remains an operator item.

## Rollout

1. Deploy the Bot with `ENROLLMENT_ENABLED=false` (default). Nothing changes.
2. Apply the proxy snippets above; set `PLATFORM_RETURN_URL`; set `ENROLLMENT_ENABLED=true`; restart.
3. C0 now lists `enroll.v1`; the Platform shows "Add / replace keys" and "Reveal webhook secret".
4. Rollback: set `ENROLLMENT_ENABLED=false`. Outstanding tickets die with their 5-minute expiry.

## Limits that remain (documented, not solved here)

- The ticket is a bearer token for five minutes. Mitigations: fresh step-up to mint, single use,
  fragment only, bound purpose/network/account, short session.
- A key **replacement** with another Binance account's keys would orphan tracked positions (the drift
  guard then refuses exits). No account-identity comparison is made (`accountInfo` uid not verified).
- On testnet, `/sapi` is unavailable, so withdrawal and IP-restriction settings are not checked; the
  page says so.
