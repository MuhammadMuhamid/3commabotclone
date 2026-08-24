# Changelog

## 2026-08-24 — Session stability

### Fixed: users logged out every few minutes, backend crashing

**Symptom.** The dashboard signed you out a few minutes into every session.

**Root cause.** A refresh-token rotation race. Rotation is single-use — presenting a
refresh token deletes it and issues a replacement — but `Dashboard.tsx` fires five
parallel requests every 15 seconds. When the 15-minute access token expired, all
five returned 401 simultaneously and each independently tried to rotate the *same*
refresh cookie, because the browser had not yet received the replacement.

The winner rotated the token. The losers called `prisma.refreshToken.delete()` on a
row that no longer existed, throwing **Prisma P2025** as an *unhandled rejection* —
which terminated the Node process. Production had reached `RestartCount=13`.

Each crash therefore did three things: logged the user out, cleared the freshly
issued cookies, and took the 30s TP/SL monitor and 60s manual-close sync offline
until the container restarted. Any position near a trigger was unmonitored in that
window.

**Fixes.**

| Change | File | Effect |
|--------|------|--------|
| Single-flight refresh | `frontend/src/api.ts` | Concurrent 401s share one refresh promise — one rotation per expiry |
| 60s rotation grace window | `backend/src/routes/auth.ts` | A late duplicate is replayed the replacement instead of losing its session |
| `delete` → `deleteMany` | `backend/src/routes/auth.ts` | Returns `count: 0` rather than throwing P2025; stops the crash at its source |
| Dedicated refresh rate limiter | `backend/src/index.ts` | 120/15min, split from the 20/15min credential limiter that was locking out live sessions |
| Proactive 10-min refresh | `frontend/src/context/AuthContext.tsx` | Token never lapses under an active user |
| `unhandledRejection` guard | `backend/src/index.ts` | A stray rejection logs instead of killing a process holding real positions |

**Operational note.** The crash guard means restart count is no longer the signal
that something threw. Audit with:

```bash
docker logs --since 24h tradingbot-backend-1 2>&1 | grep -c 'stayed up'
```

Anything above `0` is a real bug that would previously have caused an outage.

### Deploy tooling

- `finish-on-server.sh`, `remote-deploy.sh`, `BOT_COMPLETE_GUIDE.md` — corrected a
  dead hardcoded IP (`13.239.200.14`) and the wrong key name; now reference the
  DNS hostname so they do not rot when the instance is replaced.
- `cloudshell-launch.sh` — `KEY_NAME` now matches the real keypair. Fixed a latent
  bug where a pre-existing key left a **0-byte `.pem`** behind (the shell created
  the redirect target before the command failed) while the summary told you to
  download it — which would have destroyed the only local copy of the key. AWS
  returns a private key exactly once, so this was unrecoverable.
- All 15 `aws ec2` calls now pass `--region "$REGION"` explicitly instead of
  inheriting CloudShell's ambient region.

### Documentation

- Documented the previously undocumented `authRouter` and `notificationsRouter`,
  plus the `partial-close` and `DELETE` trade endpoints.
- Added the complete environment variable reference — `JWT_SECRET`, `SCRYPT_SALT`,
  `SECURE_COOKIES`, `CORS_ORIGIN`, `VAPID_*` were all missing.
- Added guide section 6.7 covering the token model and the concurrency hazard.
- Corrected `/health`, which returns only `{ status: "ok" }`, not `{ status, dryRun }`.
