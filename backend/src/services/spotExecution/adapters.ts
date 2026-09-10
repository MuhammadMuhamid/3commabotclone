import { createHash, createHmac, randomUUID, sign as cryptoSign } from "node:crypto";
import { SPOT_CAPABILITIES } from "./capabilities.js";
import {
  type PreparedVenueRequest, type SafeExecutionEnvironment, type SpotBalance,
  type SpotLifecycle, type SpotOrderIntent, type SpotOrderSnapshot, type SpotTimeInForce,
  type SpotVenue, type SpotVenueAdapter, SpotCapabilityError, type VenueBuildContext,
} from "./model.js";

type Json = Record<string, unknown>;

const record = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpotCapabilityError("provider fixture must be an object");
  }
  return value as Json;
};
const text = (value: unknown, fallback = ""): string => value == null ? fallback : String(value);
const numberText = (value: unknown, fallback = "0"): string => {
  const rendered = text(value, fallback);
  return Number.isFinite(Number(rendered)) ? rendered : fallback;
};
const iso = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const average = (base: string, quote: string, direct?: unknown): string | null => {
  if (direct != null && Number(direct) > 0) return String(direct);
  return Number(base) > 0 ? String(Number(quote) / Number(base)) : null;
};
const query = (entries: Array<[string, string | undefined]>): string =>
  entries.filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
const json = (value: Json): string => JSON.stringify(value);
const hmacHex = (algorithm: string, secret: string, value: string): string =>
  createHmac(algorithm, secret).update(value).digest("hex");
const hmacBase64 = (algorithm: string, secret: string | Buffer, value: string): string =>
  createHmac(algorithm, secret).update(value).digest("base64");

function baseUrl(venue: SpotVenue, environment: SafeExecutionEnvironment): string {
  const safe: Record<SpotVenue, Partial<Record<SafeExecutionEnvironment, string>>> = {
    binance: { testnet: "https://testnet.binance.vision", paper: "paper://binance" },
    coinbase: { paper: "disabled://api.coinbase.com" },
    bybit: { testnet: "https://api-testnet.bybit.com", demo: "https://api-demo.bybit.com", paper: "paper://bybit" },
    okx: { demo: "https://www.okx.com", paper: "paper://okx" },
    kraken: { paper: "disabled://api.kraken.com" },
    kucoin: { paper: "disabled://api.kucoin.com" },
    gateio: { paper: "disabled://api.gateio.ws" },
    robinhood: { paper: "disabled://trading.robinhood.com" },
    hyperliquid: { testnet: "https://api.hyperliquid-testnet.xyz", paper: "paper://hyperliquid" },
  };
  const url = safe[venue][environment];
  if (!url) throw new SpotCapabilityError(`${venue} has no ${environment} endpoint in X3A`);
  return url;
}

function tif(intent: SpotOrderIntent, defaultValue: SpotTimeInForce = "GTC"): SpotTimeInForce {
  return intent.timeInForce ?? defaultValue;
}

function validateCommon(intent: SpotOrderIntent): void {
  const cap = SPOT_CAPABILITIES[intent.venue];
  if (!cap.environments.includes(intent.environment)) {
    throw new SpotCapabilityError(`${intent.venue} does not support ${intent.environment} execution`);
  }
  if (!cap.orderTypes.includes(intent.orderType)) {
    throw new SpotCapabilityError(`${intent.venue} does not support ${intent.orderType} spot orders`);
  }
  const requestedTif = tif(intent);
  if (intent.orderType !== "MARKET" && !cap.timeInForce.includes(requestedTif)) {
    throw new SpotCapabilityError(`${intent.venue} does not support ${requestedTif} for this spot order`);
  }
  if (!new RegExp(cap.clientOrderId.pattern).test(intent.clientOrderId)
      || intent.clientOrderId.length > cap.clientOrderId.maxLength) {
    throw new SpotCapabilityError(`${intent.venue} client order id is outside venue constraints`);
  }
  const base = Number(intent.baseQuantity ?? 0), quoteQty = Number(intent.quoteQuantity ?? 0);
  const basePositive = Number.isFinite(base) && base > 0;
  const quotePositive = Number.isFinite(quoteQty) && quoteQty > 0;
  if (!basePositive && !quotePositive) throw new SpotCapabilityError("a finite positive base or quote quantity is required");
  if (basePositive && quotePositive) throw new SpotCapabilityError("base and quote quantity are mutually exclusive");
  if (intent.orderType !== "MARKET"
      && !(Number.isFinite(Number(intent.limitPrice)) && Number(intent.limitPrice) > 0)) {
    throw new SpotCapabilityError(`${intent.orderType} requires a positive limit price`);
  }
  if (quotePositive && (intent.side !== "BUY" || intent.orderType !== "MARKET" || !cap.quoteMarketBuy)) {
    throw new SpotCapabilityError(`${intent.venue} does not support quote-sized ${intent.side} ${intent.orderType}`);
  }
  const createdAt = Date.parse(intent.platformIntent.createdAt);
  if (!intent.platformIntent.id || !intent.platformIntent.dedupeKey || !intent.platformIntent.payloadHash
      || !Number.isFinite(createdAt)) {
    throw new SpotCapabilityError("durable Platform order-intent identity is required");
  }
}

function status(raw: string): Exclude<SpotLifecycle, "REQUESTED" | "SUBMITTED" | "ACK_UNKNOWN"> {
  const value = raw.toUpperCase().replaceAll("-", "_");
  if (["FILLED", "DONE", "COMPLETED", "FULLY_FILLED"].includes(value)) return "FILLED";
  if (["PARTIALLY_FILLED", "PARTIAL", "PARTIALLYFILLED"].includes(value)) return "PARTIALLY_FILLED";
  if (["CANCELED", "CANCELLED", "CANCEL", "VOIDED"].includes(value)) return "CANCELED";
  if (["REJECTED", "FAILED", "ERROR"].includes(value)) return "REJECTED";
  if (["EXPIRED", "EXPIRED_IN_MATCH"].includes(value)) return "EXPIRED";
  if (["OPEN", "NEW", "PENDING", "LIVE", "ACTIVE", "QUEUED", "CANCEL_QUEUED", "EDIT_QUEUED",
    "UNTRIGGERED"].includes(value)) return "OPEN";
  throw new SpotCapabilityError(`unrecognized provider order status: ${raw || "<empty>"}`);
}

function snapshot(intent: SpotOrderIntent, observedAt: string, fields: {
  id: unknown; clientId?: unknown; status: unknown; base?: unknown; quote?: unknown; average?: unknown;
  fee?: unknown; feeAsset?: unknown; timestamp?: unknown; acknowledgedAt?: unknown; lastFillAt?: unknown;
}): SpotOrderSnapshot {
  const base = numberText(fields.base), quoteQty = numberText(fields.quote);
  const feeAmount = numberText(fields.fee);
  return { venue: intent.venue, environment: intent.environment, providerOrderId: text(fields.id),
    clientOrderId: text(fields.clientId, intent.clientOrderId), status: status(text(fields.status)),
    filledBaseQuantity: base, filledQuoteQuantity: quoteQty,
    averageFillPrice: average(base, quoteQty, fields.average),
    fee: Number(feeAmount) !== 0 || fields.feeAsset != null
      ? { amount: feeAmount, asset: text(fields.feeAsset) } : null,
    providerTimestamp: iso(fields.timestamp), acknowledgedAt: iso(fields.acknowledgedAt) ?? observedAt,
    lastFillAt: iso(fields.lastFillAt), rawStatus: text(fields.status) };
}

function balances(items: unknown[], observedAt: string, map: (item: Json) => [unknown, unknown, unknown]): SpotBalance[] {
  return items.map(record).map((item) => { const [asset, available, locked] = map(item); return {
    asset: text(asset).toUpperCase(), available: numberText(available), locked: numberText(locked),
    observedAt, stale: false,
  }; }).filter((item) => item.asset.length > 0);
}

function binance(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.binance;
  const signed = (method: "GET" | "POST" | "DELETE", path: string, pairs: Array<[string, string | undefined]>,
    intent: SpotOrderIntent, c: VenueBuildContext): PreparedVenueRequest => {
    const preimage = query([...pairs, ["timestamp", String(c.nowMs)], ["recvWindow", "5000"]]);
    return { venue: "binance", environment: intent.environment, method, baseUrl: baseUrl("binance", intent.environment),
      path: `${path}?${preimage}&signature=${hmacHex("sha256", c.credentials.apiSecret, preimage)}`,
      headers: { "X-MBX-APIKEY": c.credentials.apiKey }, signaturePreimage: preimage };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); return signed("POST", "/api/v3/order", [
      ["symbol", i.venueSymbol], ["side", i.side], ["type", i.orderType],
      ["timeInForce", i.orderType === "LIMIT" ? tif(i) : undefined], ["quantity", i.baseQuantity],
      ["quoteOrderQty", i.quoteQuantity], ["price", i.limitPrice], ["newClientOrderId", i.clientOrderId],
      ["newOrderRespType", "FULL"],
    ], i, c); },
    prepareQuery: (i, c) => signed("GET", "/api/v3/order", [["symbol", i.venueSymbol],
      ["origClientOrderId", i.clientOrderId]], i, c),
    prepareCancel: (i, c) => signed("DELETE", "/api/v3/order", [["symbol", i.venueSymbol],
      ["origClientOrderId", i.clientOrderId]], i, c),
    normalizeOrder: (raw, i, at) => { const r = record(raw); return snapshot(i, at, { id: r.orderId,
      clientId: r.clientOrderId ?? r.origClientOrderId, status: r.status, base: r.executedQty,
      quote: r.cummulativeQuoteQty, timestamp: r.transactTime ?? r.updateTime }); },
    normalizeBalances: (raw, at) => balances((record(raw).balances as unknown[]) ?? [], at,
      (r) => [r.asset, r.free, r.locked]),
  };
}

function coinbaseJwt(c: VenueBuildContext, method: string, path: string): string {
  if (!c.credentials.privateKeyPem) throw new SpotCapabilityError("Coinbase EC private key is required at Bot boundary");
  const header = Buffer.from(json({ alg: "ES256", kid: c.credentials.apiKey, nonce: c.nonce, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(json({ sub: c.credentials.apiKey, iss: "cdp", nbf: Math.floor(c.nowMs / 1000),
    exp: Math.floor(c.nowMs / 1000) + 120, uri: `${method} api.coinbase.com${path}` })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${cryptoSign("sha256", Buffer.from(unsigned), { key: c.credentials.privateKeyPem,
    dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function coinbase(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.coinbase;
  const request = (method: "GET" | "POST", path: string, body: Json | undefined,
    i: SpotOrderIntent, c: VenueBuildContext): PreparedVenueRequest => {
    // CDP JWTs bind method + host + URL path; query parameters are transported
    // but are not part of the JWT `uri` claim.
    const signedPath = path.split("?", 1)[0]!;
    return { venue: "coinbase", environment: i.environment,
      method, baseUrl: baseUrl("coinbase", i.environment), path,
      headers: { Authorization: `Bearer ${coinbaseJwt(c, method, signedPath)}`, "Content-Type": "application/json" },
      ...(body ? { body: json(body) } : {}), signaturePreimage: `${method} api.coinbase.com${signedPath}` };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); const config = i.orderType === "MARKET"
      ? { market_market_ioc: i.quoteQuantity ? { quote_size: i.quoteQuantity } : { base_size: i.baseQuantity } }
      : { limit_limit_gtc: { base_size: i.baseQuantity, limit_price: i.limitPrice,
        post_only: tif(i) === "POST_ONLY" } };
      return request("POST", "/api/v3/brokerage/orders", { client_order_id: i.clientOrderId,
        product_id: i.venueSymbol, side: i.side, order_configuration: config }, i, c); },
    // Advanced Trade has no get-by-client-id route. Query a bounded product/time
    // window and select the exact client id from the response instead.
    prepareQuery: (i, c) => request("GET", `/api/v3/brokerage/orders/historical/batch?product_ids=${encodeURIComponent(i.venueSymbol)}&start_date=${encodeURIComponent(i.platformIntent.createdAt)}`,
      undefined, i, c),
    prepareCancel: (i, c) => { if (!i.providerOrderId) throw new SpotCapabilityError(
      "Coinbase cancel requires a reconciled provider order id");
      return request("POST", "/api/v3/brokerage/orders/batch_cancel",
        { order_ids: [i.providerOrderId] }, i, c); },
    normalizeOrder: (raw, i, at) => { const r0 = record(raw);
      const listed = (r0.orders as unknown[]) ?? [];
      const r = listed.length > 0
        ? record(listed.find((candidate) => record(candidate).client_order_id === i.clientOrderId) ?? {})
        : record(r0.order ?? r0);
      return snapshot(i, at, { id: r.order_id, clientId: r.client_order_id, status: r.status,
        base: r.filled_size, quote: r.filled_value, average: r.average_filled_price,
        fee: r.total_fees, feeAsset: String(i.venueSymbol).split("-")[1], timestamp: r.created_time,
        lastFillAt: r.last_fill_time }); },
    normalizeBalances: (raw, at) => balances((record(raw).accounts as unknown[]) ?? [], at, (r) => {
      const available = record(r.available_balance), hold = record(r.hold); return [r.currency, available.value, hold.value];
    }),
  };
}

function bybit(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.bybit;
  const request = (method: "GET" | "POST", path: string, payload: Json, i: SpotOrderIntent,
    c: VenueBuildContext): PreparedVenueRequest => { const encoded = method === "GET"
      ? query(Object.entries(payload).map(([k, v]) => [k, text(v)])) : json(payload);
    const preimage = `${c.nowMs}${c.credentials.apiKey}5000${encoded}`;
    return { venue: "bybit", environment: i.environment, method, baseUrl: baseUrl("bybit", i.environment),
      path: method === "GET" && encoded ? `${path}?${encoded}` : path,
      headers: { "X-BAPI-API-KEY": c.credentials.apiKey, "X-BAPI-TIMESTAMP": String(c.nowMs),
        "X-BAPI-RECV-WINDOW": "5000", "X-BAPI-SIGN": hmacHex("sha256", c.credentials.apiSecret, preimage),
        "Content-Type": "application/json" }, ...(method === "POST" ? { body: encoded } : {}),
      signaturePreimage: preimage.replace(c.credentials.apiKey, "<API_KEY>") };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); return request("POST", "/v5/order/create", {
      category: "spot", symbol: i.venueSymbol, side: i.side === "BUY" ? "Buy" : "Sell",
      orderType: i.orderType === "MARKET" ? "Market" : "Limit",
      qty: i.quoteQuantity ?? i.baseQuantity, marketUnit: i.quoteQuantity ? "quoteCoin" : "baseCoin",
      ...(i.limitPrice ? { price: i.limitPrice } : {}),
      ...(i.orderType === "LIMIT" ? { timeInForce: tif(i) === "POST_ONLY" ? "PostOnly" : tif(i) } : {}),
      orderLinkId: i.clientOrderId,
    }, i, c); },
    prepareQuery: (i, c) => request("GET", "/v5/order/realtime", { category: "spot", symbol: i.venueSymbol,
      orderLinkId: i.clientOrderId }, i, c),
    prepareCancel: (i, c) => request("POST", "/v5/order/cancel", { category: "spot", symbol: i.venueSymbol,
      orderLinkId: i.clientOrderId }, i, c),
    normalizeOrder: (raw, i, at) => { const root = record(raw); const result = record(root.result ?? root);
      const r = record((result.list as unknown[])?.[0] ?? result); return snapshot(i, at, { id: r.orderId,
        clientId: r.orderLinkId, status: r.orderStatus, base: r.cumExecQty, quote: r.cumExecValue,
        average: r.avgPrice, fee: r.cumExecFee, timestamp: r.createdTime, lastFillAt: r.updatedTime }); },
    normalizeBalances: (raw, at) => { const root = record(raw); const result = record(root.result ?? root);
      const accounts = (result.list as unknown[]) ?? []; const coins = accounts.flatMap((a) => (record(a).coin as unknown[]) ?? []);
      return balances(coins, at, (r) => [r.coin, r.walletBalance, r.locked]); },
  };
}

function okx(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.okx;
  const request = (method: "GET" | "POST", path: string, body: Json | undefined, i: SpotOrderIntent,
    c: VenueBuildContext): PreparedVenueRequest => { const timestamp = new Date(c.nowMs).toISOString();
    const bodyText = body ? json(body) : ""; const preimage = `${timestamp}${method}${path}${bodyText}`;
    return { venue: "okx", environment: i.environment, method, baseUrl: baseUrl("okx", i.environment), path,
      headers: { "OK-ACCESS-KEY": c.credentials.apiKey,
        "OK-ACCESS-SIGN": hmacBase64("sha256", c.credentials.apiSecret, preimage),
        "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": c.credentials.passphrase ?? "",
        "x-simulated-trading": "1", "Content-Type": "application/json" },
      ...(body ? { body: bodyText } : {}), signaturePreimage: preimage };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); const ordType = i.orderType === "MARKET" ? "market"
      : tif(i) === "POST_ONLY" ? "post_only" : tif(i) === "GTC" ? "limit" : tif(i).toLowerCase();
      return request("POST", "/api/v5/trade/order", { instId: i.venueSymbol, tdMode: "cash", side: i.side.toLowerCase(),
        ordType, sz: i.quoteQuantity ?? i.baseQuantity, tgtCcy: i.quoteQuantity ? "quote_ccy" : "base_ccy",
        ...(i.limitPrice ? { px: i.limitPrice } : {}), clOrdId: i.clientOrderId }, i, c); },
    prepareQuery: (i, c) => request("GET", `/api/v5/trade/order?instId=${encodeURIComponent(i.venueSymbol)}&clOrdId=${encodeURIComponent(i.clientOrderId)}`,
      undefined, i, c),
    prepareCancel: (i, c) => request("POST", "/api/v5/trade/cancel-order", { instId: i.venueSymbol,
      clOrdId: i.clientOrderId }, i, c),
    normalizeOrder: (raw, i, at) => { const root = record(raw); const r = record((root.data as unknown[])?.[0] ?? root);
      return snapshot(i, at, { id: r.ordId, clientId: r.clOrdId, status: r.state, base: r.accFillSz,
        quote: r.accFillSz && r.avgPx ? Number(r.accFillSz) * Number(r.avgPx) : 0, average: r.avgPx,
        fee: r.fee, feeAsset: r.feeCcy, timestamp: r.cTime, lastFillAt: r.uTime }); },
    normalizeBalances: (raw, at) => { const root = record(raw); const data = (root.data as unknown[]) ?? [];
      const details = data.flatMap((a) => (record(a).details as unknown[]) ?? []);
      return balances(details, at, (r) => [r.ccy, r.availBal, Number(r.frozenBal ?? 0) + Number(r.ordFrozen ?? 0)]); },
  };
}

function kraken(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.kraken;
  const request = (path: string, payload: Json, i: SpotOrderIntent, c: VenueBuildContext): PreparedVenueRequest => {
    const nonce = String(c.nowMs); const pairs: Array<[string, string]> = [["nonce", nonce],
      ...Object.entries(payload).map(([k, v]): [string, string] => [k, text(v)])];
    const body = query(pairs);
    const digest = createHash("sha256").update(nonce + body).digest();
    const preimage = Buffer.concat([Buffer.from(path), digest]);
    const secret = Buffer.from(c.credentials.apiSecret, "base64");
    return { venue: "kraken", environment: i.environment, method: "POST", baseUrl: baseUrl("kraken", i.environment),
      path, headers: { "API-Key": c.credentials.apiKey,
        "API-Sign": createHmac("sha512", secret).update(preimage).digest("base64"),
        "Content-Type": "application/x-www-form-urlencoded" }, body,
      signaturePreimage: `${path}<SHA256(nonce+body)>` };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); return request("/0/private/AddOrder", { pair: i.venueSymbol,
      type: i.side.toLowerCase(), ordertype: i.orderType.toLowerCase(), volume: i.baseQuantity,
      ...(i.limitPrice ? { price: i.limitPrice } : {}),
      ...(i.orderType === "LIMIT" ? { timeinforce: tif(i) === "POST_ONLY" ? "GTC" : tif(i) } : {}),
      cl_ord_id: i.clientOrderId,
      ...(tif(i) === "POST_ONLY" ? { oflags: "post" } : {}) }, i, c); },
    prepareQuery: (i, c) => request("/0/private/QueryOrders", { cl_ord_id: i.clientOrderId, trades: true }, i, c),
    prepareCancel: (i, c) => request("/0/private/CancelOrder", { cl_ord_id: i.clientOrderId }, i, c),
    normalizeOrder: (raw, i, at) => { const root = record(raw); const result = record(root.result ?? root);
      const r = record(Object.values(result)[0] ?? result); return snapshot(i, at, { id: r.txid ?? Object.keys(result)[0],
      clientId: r.cl_ord_id, status: String(r.status).toLowerCase() === "closed"
        ? (Number(r.vol_exec ?? 0) > 0 ? "FILLED" : "CANCELED") : r.status,
        base: r.vol_exec, quote: r.cost, average: r.price,
        fee: r.fee, timestamp: r.opentm, lastFillAt: r.closetm }); },
    normalizeBalances: (raw, at) => { const result = record(record(raw).result ?? raw);
      return balances(Object.entries(result).map(([asset, available]) => ({ asset, available })), at,
        (r) => [r.asset, r.available, 0]); },
  };
}

function kucoin(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.kucoin;
  const request = (method: "GET" | "POST" | "DELETE", path: string, body: Json | undefined,
    i: SpotOrderIntent, c: VenueBuildContext): PreparedVenueRequest => { const timestamp = String(c.nowMs);
    const bodyText = body ? json(body) : ""; const preimage = `${timestamp}${method}${path}${bodyText}`;
    return { venue: "kucoin", environment: i.environment, method, baseUrl: baseUrl("kucoin", i.environment), path,
      headers: { "KC-API-KEY": c.credentials.apiKey,
        "KC-API-SIGN": hmacBase64("sha256", c.credentials.apiSecret, preimage),
        "KC-API-TIMESTAMP": timestamp, "KC-API-PASSPHRASE": hmacBase64("sha256", c.credentials.apiSecret,
          c.credentials.passphrase ?? ""), "KC-API-KEY-VERSION": "2", "Content-Type": "application/json" },
      ...(body ? { body: bodyText } : {}), signaturePreimage: preimage };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); return request("POST", "/api/v1/hf/orders", {
      clientOid: i.clientOrderId, symbol: i.venueSymbol, side: i.side.toLowerCase(), type: i.orderType.toLowerCase(),
      ...(i.quoteQuantity ? { funds: i.quoteQuantity } : { size: i.baseQuantity }),
      ...(i.limitPrice ? { price: i.limitPrice } : {}),
      ...(i.orderType === "LIMIT" ? { timeInForce: tif(i) === "POST_ONLY" ? "GTC" : tif(i),
        postOnly: tif(i) === "POST_ONLY" } : {}),
    }, i, c); },
    prepareQuery: (i, c) => request("GET", `/api/v1/hf/orders/client-order/${encodeURIComponent(i.clientOrderId)}?symbol=${encodeURIComponent(i.venueSymbol)}`,
      undefined, i, c),
    prepareCancel: (i, c) => request("DELETE", `/api/v1/hf/orders/client-order/${encodeURIComponent(i.clientOrderId)}?symbol=${encodeURIComponent(i.venueSymbol)}`,
      undefined, i, c),
    normalizeOrder: (raw, i, at) => { const root = record(raw); const r = record(root.data ?? root);
      return snapshot(i, at, { id: r.id ?? r.orderId, clientId: r.clientOid, status: r.isActive === true
        ? (Number(r.dealSize) > 0 ? "PARTIALLY_FILLED" : "OPEN") : r.cancelExist ? "CANCELED" : "FILLED",
        base: r.dealSize, quote: r.dealFunds, fee: r.fee, feeAsset: r.feeCurrency,
        timestamp: r.createdAt, lastFillAt: r.updatedAt }); },
    normalizeBalances: (raw, at) => { const root = record(raw); return balances((root.data as unknown[]) ?? [], at,
      (r) => [r.currency, r.available, r.holds]); },
  };
}

function gateio(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.gateio;
  const request = (method: "GET" | "POST" | "DELETE", path: string, queryText: string, body: Json | undefined,
    i: SpotOrderIntent, c: VenueBuildContext): PreparedVenueRequest => { const bodyText = body ? json(body) : "";
    const timestamp = String(Math.floor(c.nowMs / 1000)); const preimage = [method, path, queryText,
      createHash("sha512").update(bodyText).digest("hex"), timestamp].join("\n");
    return { venue: "gateio", environment: i.environment, method, baseUrl: baseUrl("gateio", i.environment),
      path: `${path}${queryText ? `?${queryText}` : ""}`, headers: { KEY: c.credentials.apiKey,
        Timestamp: timestamp, SIGN: hmacHex("sha512", c.credentials.apiSecret, preimage),
        "Content-Type": "application/json" }, ...(body ? { body: bodyText } : {}), signaturePreimage: preimage };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); const amount = i.quoteQuantity && i.orderType === "MARKET"
      ? i.quoteQuantity : i.baseQuantity; return request("POST", "/api/v4/spot/orders", "", {
        text: i.clientOrderId, currency_pair: i.venueSymbol, side: i.side.toLowerCase(), amount,
        type: i.orderType === "MARKET" ? "market" : "limit",
        time_in_force: i.orderType === "LIMIT_MAKER" || tif(i) === "POST_ONLY" ? "poc" : tif(i).toLowerCase(),
        ...(i.limitPrice ? { price: i.limitPrice } : {}),
      }, i, c); },
    prepareQuery: (i, c) => request("GET", `/api/v4/spot/orders/${encodeURIComponent(i.clientOrderId)}`,
      query([["currency_pair", i.venueSymbol]]), undefined, i, c),
    prepareCancel: (i, c) => request("DELETE", `/api/v4/spot/orders/${encodeURIComponent(i.clientOrderId)}`,
      query([["currency_pair", i.venueSymbol]]), undefined, i, c),
    normalizeOrder: (raw, i, at) => { const r = record(raw); const base = numberText(r.filled_amount);
      const quoteQty = String(Number(base) * Number(r.avg_deal_price ?? r.price ?? 0)); return snapshot(i, at, {
        id: r.id, clientId: r.text, status: r.status === "closed" ? (r.finish_as === "filled" ? "FILLED" : "CANCELED") : "OPEN",
        base, quote: quoteQty, average: r.avg_deal_price, fee: r.fee, feeAsset: r.fee_currency,
        timestamp: r.create_time_ms ?? r.create_time, lastFillAt: r.update_time_ms }); },
    normalizeBalances: (raw, at) => balances(Array.isArray(raw) ? raw : [], at,
      (r) => [r.currency, r.available, r.locked]),
  };
}

function robinhood(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.robinhood;
  const request = (method: "GET" | "POST", path: string, body: Json | undefined, i: SpotOrderIntent,
    c: VenueBuildContext): PreparedVenueRequest => { if (!c.credentials.privateKeyPem) {
      throw new SpotCapabilityError("Robinhood Ed25519 private key is required at Bot boundary");
    } const timestamp = String(Math.floor(c.nowMs / 1000)); const bodyText = body ? json(body) : "";
    const preimage = `${c.credentials.apiKey}${timestamp}${path}${method}${bodyText}`;
    const signature = cryptoSign(null, Buffer.from(preimage), c.credentials.privateKeyPem).toString("base64");
    return { venue: "robinhood", environment: i.environment, method,
      baseUrl: baseUrl("robinhood", i.environment), path,
      headers: { "x-api-key": c.credentials.apiKey, "x-signature": signature, "x-timestamp": timestamp,
        "Content-Type": "application/json" }, ...(body ? { body: bodyText } : {}),
      signaturePreimage: preimage.replace(c.credentials.apiKey, "<API_KEY>") };
  };
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); const type = i.orderType.toLowerCase(); return request("POST", "/api/v1/crypto/trading/orders/", {
      client_order_id: i.clientOrderId, side: i.side.toLowerCase(), type, symbol: i.venueSymbol,
      [`${type}_order_config`]: { asset_quantity: i.baseQuantity,
        ...(i.limitPrice ? { limit_price: i.limitPrice } : {}) },
    }, i, c); },
    // V1 lookup is by provider id; list-and-match is the safe client-id recovery path.
    prepareQuery: (i, c) => request("GET", "/api/v1/crypto/trading/orders/", undefined, i, c),
    prepareCancel: (i, c) => { if (!i.providerOrderId) throw new SpotCapabilityError(
      "Robinhood cancel requires a reconciled provider order id");
      return request("POST", `/api/v1/crypto/trading/orders/${encodeURIComponent(i.providerOrderId)}/cancel/`, {}, i, c); },
    normalizeOrder: (raw, i, at) => { const root = record(raw); const listed = (root.results as unknown[]) ?? [];
      const r = listed.length > 0
        ? record(listed.find((candidate) => record(candidate).client_order_id === i.clientOrderId) ?? {}) : root;
      const executions = (r.executions as unknown[]) ?? [];
      const base = executions.reduce<number>((sum, e) => sum + Number(record(e).quantity ?? 0), 0).toString();
      const quoteQty = executions.reduce<number>((sum, e) => sum
        + Number(record(e).effective_price ?? 0) * Number(record(e).quantity ?? 0), 0).toString();
      return snapshot(i, at, { id: r.id, clientId: r.client_order_id, status: r.state, base, quote: quoteQty,
        timestamp: r.created_at, lastFillAt: r.updated_at }); },
    normalizeBalances: (raw, at) => balances((record(raw).results as unknown[]) ?? [], at,
      (r) => [r.asset_code, r.total_quantity_available_for_trading, r.quantity_held_for_orders]),
  };
}

function hyperliquid(): SpotVenueAdapter {
  const cap = SPOT_CAPABILITIES.hyperliquid;
  const exchange = (action: Json, i: SpotOrderIntent, c: VenueBuildContext): PreparedVenueRequest => ({
    venue: "hyperliquid", environment: i.environment, method: "POST", baseUrl: baseUrl("hyperliquid", i.environment),
    path: "/exchange", headers: { "Content-Type": "application/json",
      "x-x3a-signing": "official-sdk-eip712-required" },
    body: json({ action, nonce: c.nowMs, signature: "<BOT_EIP712_SIGNATURE>", vaultAddress: null }),
    signaturePreimage: json(action),
  });
  return { capabilities: cap, validate: validateCommon,
    prepareSubmit: (i, c) => { validateCommon(i); return exchange({ type: "order", grouping: "na", orders: [{
      a: i.venueSymbol, b: i.side === "BUY", p: i.limitPrice, s: i.baseQuantity, r: false,
      t: { limit: { tif: tif(i) === "POST_ONLY" ? "Alo" : tif(i) === "IOC" ? "Ioc" : "Gtc" } }, c: i.clientOrderId,
    }] }, i, c); },
    prepareQuery: (i, c) => ({ venue: "hyperliquid", environment: i.environment, method: "POST",
      baseUrl: baseUrl("hyperliquid", i.environment), path: "/info", headers: { "Content-Type": "application/json" },
      body: json({ type: "orderStatus", user: c.credentials.walletAddress, oid: i.clientOrderId }),
      signaturePreimage: "read-only orderStatus" }),
    prepareCancel: (i, c) => exchange({ type: "cancelByCloid", cancels: [{ asset: i.venueSymbol, cloid: i.clientOrderId }] }, i, c),
    normalizeOrder: (raw, i, at) => { const root = record(raw); const r = record(root.order ?? root);
      return snapshot(i, at, { id: r.oid, clientId: r.cloid, status: r.status, base: r.totalSz ?? r.sz,
        quote: r.totalSz && r.avgPx ? Number(r.totalSz) * Number(r.avgPx) : 0,
        average: r.avgPx ?? r.limitPx, fee: r.fee, feeAsset: r.feeToken, timestamp: r.timestamp }); },
    normalizeBalances: (raw, at) => { const root = record(raw); return balances((root.balances as unknown[]) ?? [], at,
      (r) => [r.coin, r.total, r.hold]); },
  };
}

export const SPOT_ADAPTERS: Record<SpotVenue, SpotVenueAdapter> = {
  binance: binance(), coinbase: coinbase(), bybit: bybit(), okx: okx(), kraken: kraken(),
  kucoin: kucoin(), gateio: gateio(), robinhood: robinhood(), hyperliquid: hyperliquid(),
};

export function spotAdapter(venue: SpotVenue): SpotVenueAdapter {
  return SPOT_ADAPTERS[venue];
}

/** Deterministic helper used only by fixture tests and disabled paper transports. */
export function fixtureContext(overrides: Partial<VenueBuildContext> = {}): VenueBuildContext {
  return { nowMs: 1_788_678_000_000, nonce: randomUUID(),
    credentials: { apiKey: "fixture-key", apiSecret: Buffer.from("fixture-secret").toString("base64"),
      passphrase: "fixture-passphrase", walletAddress: `0x${"1".padStart(40, "0")}` },
    ...overrides };
}
