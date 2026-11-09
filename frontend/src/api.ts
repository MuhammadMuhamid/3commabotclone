const base = "";

// ─── Single-flight token refresh ──────────────────────────────────────────────
// The dashboard fires 5 requests in parallel every 15s. When the access token
// expires they all 401 together; without de-duplication each one POSTs
// /api/auth/refresh with the same cookie, the server rotates it once, and the
// losers of the race get a 401 that tears down a perfectly good session.
// One shared in-flight promise means exactly one rotation per expiry.
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        // Release on the next tick so callers that 401'd microseconds apart
        // still join this same refresh rather than starting another one.
        setTimeout(() => { refreshInFlight = null; }, 0);
      });
  }
  return refreshInFlight;
}

// ─── Core fetcher ─────────────────────────────────────────────────────────────

async function request<T>(
  path: string,
  init?: RequestInit,
  _isRetry = false
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    credentials: "include", // required for httpOnly cookie auth
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  // Transparent token refresh: on 401, try refreshing the access token once,
  // then retry the original request.
  // Exclude the refresh endpoint itself (infinite loop) and login/register/totp
  // (those use setupToken, not the access cookie — a 401 there means wrong creds).
  // /api/auth/me IS access-token protected and MUST trigger refresh.
  const isLoginEndpoint =
    path === "/api/auth/login" ||
    path === "/api/auth/register" ||
    path.startsWith("/api/auth/totp");
  if (res.status === 401 && !_isRetry && path !== "/api/auth/refresh" && !isLoginEndpoint) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, init, true); // retry once with fresh token
    }
    // Refresh failed — signal AuthContext to clear user state → ProtectedRoute redirects
    window.dispatchEvent(new Event("auth:expired"));
    throw new Error("Session expired. Please log in again.");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExchangeAccount = {
  id: string;
  name: string;
  exchange: string;
  marketType: string;
  testnet: boolean;
};

export type InvestmentUnit = "pct_bot" | "pct_trade" | "usdt_bot" | "usdt_trade";

export const INVESTMENT_UNIT_LABELS: Record<InvestmentUnit, string> = {
  pct_bot:   "% total USDT balance per Bot",
  pct_trade: "% total USDT balance per SmartTrade",
  usdt_bot:  "USDT per Bot",
  usdt_trade: "USDT per SmartTrade",
};

export type SignalBot = {
  id: string;
  name: string;
  alertType: string;
  direction: string;
  pairs: string[];
  maxInvestmentPct: number;
  maxInvestmentUnit: InvestmentUnit;
  maxActiveSmartTradesEnabled: boolean;
  maxActiveSmartTrades?: number | null;
  status: string;
  /**
   * MASKED by default (`abcd****wxyz`). The full value is served only from
   * `GET /api/bots/:id?reveal=1` and from the creation response, because it is
   * the only authentication on the order-placing endpoint. Check
   * `secretRevealed` before treating it as usable.
   */
  webhookSecret: string;
  secretRevealed: boolean;
  webhookUrl: string;
  /**
   * Present only in a revealed response — it embeds the secret. There is no
   * entry payload: direct TradingView BUY alerts are disabled, and the
   * Platform is the sole BUY authority (U4).
   */
  exitWebhookJson?: object;
  /** The backend's TradingView guidance, including the exit-only note. */
  tradingViewSetup?: { webhookUrl: string; alertCondition: string; message: string; note: string };
  entryEnabled: boolean;
  entryVolumePct: number;
  entryOrderType: string;
  exitEnabled: boolean;
  takeProfitEnabled: boolean;
  takeProfitPct?: number | null;
  stopLossEnabled: boolean;
  stopLossPct?: number | null;
  exchangeAccountId?: string | null;
  exchangeAccount?: { id: string; name: string } | null;
};

export type BotListItem = SignalBot & {
  maxInvestmentLabel: string;
  totalProfit: number;
  activeSmartTrades: number;
  signalCount: number;
  tradingSince: string;
};

export type PartialClose = {
  id: string;
  tradeId: string;
  pct: number;
  quantity: number;
  revenue: number;
  pnlUsdt: number;
  avgPrice: number;
  exchangeOrderId?: string | null;
  createdAt: string;
};

export type SmartTrade = {
  id: string;
  botId: string | null;
  botName: string;
  /**
   * `manual` positions were opened from Trading Scene and are closed from its
   * Trade panel; the Bot refuses Close / Partial for them (U3).
   */
  source?: "strategy" | "manual";
  pair: string;
  direction: string;
  status: string;
  entryPrice?: number | null;
  currentPrice?: number | null;
  quantity: number;
  quoteSpent: number;
  pnlUsdt: number;
  pnlPct: number;
  buyPrice?: number | null;
  closedReason?: string | null;
  createdAt: string;
  closedAt?: string | null;
  bot: { id: string | null; name: string; exchangeAccount?: { name: string } | null };
  partialCloses?: PartialClose[];
};

export type Stats = {
  upnl: number;
  locked: number;
  activeCount: number;
  closedCount: number;
  todayPnl: number;
  botCount: number;
  activeBotCount: number;
  stoppedBotCount: number;
};

export type AuthUser = { username: string; totpEnabled: boolean };

// ─── API surface ──────────────────────────────────────────────────────────────

/** OD-3: the entries pause as `/api/ops/status` reports it. */
export interface EntriesStatus {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  reason: string | null;
  /** Manual LIMIT BUYs still working at the exchange: a pause does not stop them. */
  workingEntryLimits: number;
  unresolvedBuyIntents: number;
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    status: () =>
      request<{ setup: boolean }>("/api/auth/status"),

    /**
     * Creating the first account requires the out-of-band SETUP_TOKEN from the
     * server environment. Registration used to be open to the internet until
     * an account existed; no route is tenant-scoped, so a stranger who got
     * there first would have been a co-admin with access to the exchange keys.
     */
    register: (setupToken: string, username: string, password: string) =>
      request<{ message: string }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ setupToken, username, password }),
      }),

    login: (username: string, password: string) =>
      request<{ step: "totp_setup" | "totp_verify"; setupToken: string }>(
        "/api/auth/login",
        { method: "POST", body: JSON.stringify({ username, password }) }
      ),

    totpQr: (setupToken: string) =>
      request<{ qrCode: string; manualKey: string }>("/api/auth/totp/qr", {
        method: "POST",
        body: JSON.stringify({ setupToken }),
      }),

    totpEnable: (setupToken: string, code: string) =>
      request<{ username: string }>("/api/auth/totp/enable", {
        method: "POST",
        body: JSON.stringify({ setupToken, code }),
      }),

    totpVerify: (setupToken: string, code: string) =>
      request<{ username: string }>("/api/auth/totp/verify", {
        method: "POST",
        body: JSON.stringify({ setupToken, code }),
      }),

    refresh: () => refreshSession(),

    logout: () =>
      request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

    me: () =>
      request<AuthUser>("/api/auth/me"),
  },

  // ── App data ──────────────────────────────────────────────────────────────
  config: () => request<{ publicUrl: string; dryRun: boolean }>("/api/config"),

  /**
   * Operator status and controls (BOT-011, BOT-034).
   *
   * `mode` is the honest three-state answer — DRY_RUN, HALTED or LIVE — which
   * was previously only inferable from `dryRun` on /api/config, and not at all
   * for a halt because halting did not exist.
   */
  ops: {
    status: () =>
      request<{
        mode: "DRY_RUN" | "HALTED" | "LIVE";
        dryRun: boolean;
        risk: {
          tradingHalted: boolean;
          haltedReason: string | null;
          haltedBy: string | null;
          maxTotalExposureQuote: number | null;
          maxConcurrentTrades: number | null;
          maxDailyLossQuote: number | null;
          dailyLossWindowHours: number;
          entriesPaused?: boolean;
          entriesPausedReason?: string | null;
          snapshot: { openExposureQuote: number; openTrades: number; realisedPnlInWindow: number };
          summary: string;
        };
        /**
         * OD-3: the "Pause new entries" switch, independent of the halt. Absent
         * on an older Bot, which has no such switch.
         */
        entries?: EntriesStatus;
        bots: { active: number; paused: number };
        protectiveOrders: { enabled: boolean; status: string; note: string };
        /**
         * Which Binance an order would actually reach. Two answers, not one:
         * `envTestnet` is the process-wide default, and each stored account
         * carries its own flag which overrides it for that account's bots.
         */
        exchange: {
          envTestnet: boolean;
          accounts: { id: string; name: string; testnet: boolean }[];
          mixed: boolean;
          note: string;
        };
        time: string;
      }>("/api/ops/status"),

    // An existing halt is kept and reported (`alreadyHalted`), never replaced.
    halt: (reason: string) =>
      request<{
        halted: true; alreadyHalted: boolean; haltedBy: string | null;
        reason: string | null; haltedAt: string | null;
      }>("/api/ops/halt", {
        method: "POST",
        body: JSON.stringify({ confirmation: "HALT_TRADING", reason }),
      }),

    resume: () =>
      request<{
        halted: false; previousHaltedBy?: string | null; previousReason?: string | null; note?: string;
      }>("/api/ops/resume", {
        method: "POST",
        body: JSON.stringify({ confirmation: "RESUME_TRADING" }),
      }),

    /**
     * OD-3: pause or resume NEW ENTRIES (target state). Never touches the halt.
     * `cancelWorkingEntries` is an explicit opt-in to also cancel resting
     * manual LIMIT BUYs; each outcome is reported, `unknown` included.
     */
    entries: (target: { paused: true; reason: string; cancelWorkingEntries?: boolean } | { paused: false }) =>
      request<{
        entries: { paused: boolean; pausedAt: string | null; pausedBy: string | null; reason: string | null };
        changed: boolean;
        canceledEntries?: { orderId: string; symbol: string;
          outcome: "canceled" | "already_terminal" | "unknown" | "failed" }[];
      }>("/api/ops/entries", {
        method: "POST",
        body: JSON.stringify(target),
      }),
  },
  stats: () => request<Stats>("/api/bots/stats"),

  bots: {
    list:   ()                   => request<BotListItem[]>("/api/bots"),
    get:    (id: string)         => request<SignalBot>(`/api/bots/${id}`),
    /**
     * Explicitly asks for the plaintext webhook secret and the ready-to-paste
     * TradingView payloads. Call this only from a deliberate user action; the
     * server logs every reveal.
     */
    reveal: (id: string)         => request<SignalBot>(`/api/bots/${id}?reveal=1`),
    create: (body: unknown)      => request<SignalBot>("/api/bots", { method: "POST", body: JSON.stringify(body) }),
    remove: (id: string)         => request<void>(`/api/bots/${id}`, { method: "DELETE" }),
    toggle: (id: string)         => request<SignalBot>(`/api/bots/${id}/toggle`, { method: "POST" }),
    update: (id: string, body: unknown) =>
      request<SignalBot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  },

  trades: {
    list: (status: "active" | "history" | "closed", botId?: string) => {
      const q = status === "history" ? "closed" : status;
      const params = new URLSearchParams({ status: q });
      if (botId) params.set("botId", botId);
      return request<SmartTrade[]>(`/api/trades?${params}`);
    },
    /**
     * `pending` (HTTP 202) means the order was submitted and its outcome is not
     * known yet — never report it as closed. `ignored_duplicate` placed no new
     * order because an earlier exit already closed the position; a recent exit
     * that left it open is a 409 `exit_recent` error instead. A
     * `detail.warning` means it executed but a later check failed.
     */
    close:  (id: string) =>
      request<{ status: "ok" | "ignored_duplicate" | "pending"; detail?: unknown }>(
        `/api/trades/${id}/close`, { method: "POST" }),
    remove: (id: string) => request<void>(`/api/trades/${id}`, { method: "DELETE" }),
    // F4: sell a percentage of an active trade
    // BOT-P1-6: `executedQty` is what actually sold and `requestedQty` what was
    // asked for. They differ on a partial or zero fill, and `partial` is null
    // when nothing executed — there is no PartialClose row for a sale that did
    // not happen.
    partialClose: (id: string, pct: number) =>
      // A 202 `pending` means the order was submitted and its outcome is not
      // known yet; it is reconciled from the exchange, never re-sent.
      request<{
        partial: PartialClose | null; trade: SmartTrade;
        requestedQty: number; executedQty: number; detail?: string;
      } | { status: "pending"; attemptId: string; detail: string }>(
        `/api/trades/${id}/partial-close`,
        { method: "POST", body: JSON.stringify({ pct }) }
      ),
  },

  exchange: {
    list:    ()                    => request<ExchangeAccount[]>("/api/exchange-accounts"),
    // U5: `testnet` is required — the API refuses an account with no explicit network.
    create:  (body: { name: string; apiKey: string; apiSecret: string; testnet: boolean }) =>
      request<ExchangeAccount>("/api/exchange-accounts", { method: "POST", body: JSON.stringify(body) }),
    balance: (id: string)          => request<{ usdt: number }>(`/api/exchange-accounts/${id}/balance`),
    // F1: total account value across all assets at live Binance prices
    totalBalance: (id: string) =>
      request<{ totalUsdt: number; breakdown: { asset: string; qty: number; valueUsdt: number }[]; cachedAt: string }>(
        `/api/exchange-accounts/${id}/total-balance`
      ),
    remove:  (id: string)          => request<void>(`/api/exchange-accounts/${id}`, { method: "DELETE" }),
  },

  notifications: {
    status: () => request<{ enabled: boolean; subscribed: boolean; subscriptions: number; publicKey: string | null }>("/api/notifications/status"),
    subscribe: (subscription: PushSubscriptionJSON) =>
      request<{ ok: boolean }>("/api/notifications/subscribe", {
        method: "POST", body: JSON.stringify(subscription),
      }),
    unsubscribe: (endpoint: string) =>
      request<{ ok: boolean }>("/api/notifications/subscribe", {
        method: "DELETE", body: JSON.stringify({ endpoint }),
      }),
  },
};

// ─── Utilities ────────────────────────────────────────────────────────────────

export function formatPair(pair: string): string {
  const s = pair.replace("/", "");
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}/USDT`;
  if (s.endsWith("USDC")) return `${s.slice(0, -4)}/USDC`;
  return s;
}

export function copyText(text: string) {
  navigator.clipboard.writeText(text);
}
