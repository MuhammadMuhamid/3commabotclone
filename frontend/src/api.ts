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
  /** Present only in a revealed response — these embed the secret. */
  entryWebhookJson?: object;
  exitWebhookJson?: object;
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
    close:  (id: string) => request(`/api/trades/${id}/close`, { method: "POST" }),
    remove: (id: string) => request<void>(`/api/trades/${id}`, { method: "DELETE" }),
    // F4: sell a percentage of an active trade
    partialClose: (id: string, pct: number) =>
      request<{ partial: PartialClose; trade: SmartTrade }>(
        `/api/trades/${id}/partial-close`,
        { method: "POST", body: JSON.stringify({ pct }) }
      ),
  },

  exchange: {
    list:    ()                    => request<ExchangeAccount[]>("/api/exchange-accounts"),
    create:  (body: { name: string; apiKey: string; apiSecret: string; testnet?: boolean }) =>
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
