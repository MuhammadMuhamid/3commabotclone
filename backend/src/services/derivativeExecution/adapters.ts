import { createHash, createHmac } from "node:crypto";
import type { PreparedVenueRequest, VenueBuildContext } from "../spotExecution/model.js";
import { DERIVATIVE_CAPABILITIES } from "./capabilities.js";
import { derivativeSizing } from "./math.js";
import { DerivativeCapabilityError, type DerivativeOrderIntent,
  type DerivativeOrderSnapshot, type DerivativeVenue, type DerivativeVenueAdapter } from "./model.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const first = (value: unknown): Json => Array.isArray(value) ? record(value[0]) : record(value);
const text = (value: unknown, fallback = "0"): string => value === undefined || value === null || value === "" ? fallback : String(value);
const json = (value: Json): string => JSON.stringify(value);
const decimal = (value: string | undefined, label: string): void => {
  if (value === undefined || value.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
      || (value.split(".")[1]?.length ?? 0) > 18 || !(Number(value) > 0)) {
    throw new DerivativeCapabilityError(`${label} must be a positive decimal with at most 18 fractional places`);
  }
};

function closingSide(intent: DerivativeOrderIntent): boolean {
  return intent.positionDirection === "LONG" ? intent.actionSide === "SELL" : intent.actionSide === "BUY";
}

export function validateDerivativeIntent(intent: DerivativeOrderIntent, nowMs = Date.now()): void {
  const cap = DERIVATIVE_CAPABILITIES[intent.venue];
  if (!cap.environments.includes(intent.environment)) throw new DerivativeCapabilityError(
    `${intent.venue} does not support ${intent.environment} derivatives execution`);
  if (!cap.contractKinds.includes(intent.instrument.kind)) throw new DerivativeCapabilityError(
    `${intent.venue} does not support ${intent.instrument.kind} contracts`);
  if (!cap.quantityUnits.includes(intent.quantityUnit)) throw new DerivativeCapabilityError(
    `${intent.venue} does not accept canonical ${intent.quantityUnit} sizing`);
  if (!cap.marginModes.includes(intent.marginMode) || !cap.positionModes.includes(intent.positionMode)) {
    throw new DerivativeCapabilityError(`${intent.venue} cannot represent the requested margin/position mode`);
  }
  if (!cap.orderTypes.includes(intent.orderType)) throw new DerivativeCapabilityError(
    `${intent.venue} does not support ${intent.orderType}`);
  if (intent.timeInForce && !cap.timeInForce.includes(intent.timeInForce)) throw new DerivativeCapabilityError(
    `${intent.venue} does not support ${intent.timeInForce}`);
  if (intent.orderType === "LIMIT") decimal(intent.limitPrice, "limitPrice");
  if (intent.orderType === "MARKET" && (intent.limitPrice || intent.timeInForce)) {
    throw new DerivativeCapabilityError("MARKET orders cannot carry limit-only fields");
  }
  const conditionalOrder = intent.orderType === "STOP_MARKET" || intent.orderType === "TAKE_PROFIT_MARKET";
  if (conditionalOrder !== Boolean(intent.protective)) throw new DerivativeCapabilityError(
    "conditional order type and explicit protective intent must be present together");
  if (intent.paperReferencePrice) decimal(intent.paperReferencePrice, "paperReferencePrice");
  decimal(intent.instrument.contractSize, "contractSize");
  if (!intent.closePosition) decimal(intent.quantity, "quantity");
  if (intent.closePosition && !cap.closePosition) throw new DerivativeCapabilityError(
    `${intent.venue} cannot safely represent closePosition; no reduce-only fallback was submitted`);
  if (intent.reduceOnly && !cap.reduceOnly) throw new DerivativeCapabilityError(
    `${intent.venue} cannot safely represent reduceOnly`);
  if (intent.closePosition && intent.reduceOnly) throw new DerivativeCapabilityError(
    "closePosition and reduceOnly are distinct venue instructions and cannot both be set");
  if (intent.venue === "binance" && intent.closePosition
      && !["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(intent.orderType)) {
    throw new DerivativeCapabilityError("Binance closePosition is limited to conditional market close orders");
  }
  if ((intent.venue === "binance" || intent.venue === "okx")
      && intent.positionMode === "HEDGE" && intent.reduceOnly) {
    throw new DerivativeCapabilityError(`${intent.venue} cannot safely encode reduceOnly in hedge mode`);
  }
  const reducing = intent.reduceOnly || intent.closePosition;
  if (reducing) {
    if (!closingSide(intent)) throw new DerivativeCapabilityError("reduce/close side would increase exposure");
    if (!intent.position) throw new DerivativeCapabilityError("fresh position observation is required for reduce/close");
    const observed = Date.parse(intent.position.observedAt);
    if (!Number.isFinite(observed) || observed > nowMs + 1_000 || nowMs - observed > 15_000) {
      throw new DerivativeCapabilityError("position observation is stale; reduce/close was not submitted");
    }
    if (intent.position.direction !== intent.positionDirection) throw new DerivativeCapabilityError(
      "position observation direction does not match the intent");
    decimal(intent.position.contracts, "position contracts");
    decimal(intent.position.entryPrice, "position entryPrice");
    decimal(intent.position.markPrice, "position markPrice");
    if (intent.position.liquidationPrice) decimal(intent.position.liquidationPrice, "position liquidationPrice");
    if (intent.position.maintenanceMargin) decimal(intent.position.maintenanceMargin, "position maintenanceMargin");
    if (intent.quantityUnit === "CONTRACTS" && intent.quantity
        && Number(intent.quantity) > Number(intent.position.contracts)) {
      throw new DerivativeCapabilityError("reduce-only quantity exceeds the observed position");
    }
  } else if (!closingSide(intent)) {
    // Opening a LONG is BUY and opening a SHORT is SELL.
  } else {
    throw new DerivativeCapabilityError("non-reducing action side contradicts position direction");
  }
  if (intent.leverage) {
    decimal(intent.leverage, "leverage");
    if (intent.environment !== "paper" && !cap.leverage.atOrder) throw new DerivativeCapabilityError(
      `${intent.venue} leverage is a separate account mutation and is not performed by order execution`);
    if (cap.leverage.maximum && Number(intent.leverage) > Number(cap.leverage.maximum)) {
      throw new DerivativeCapabilityError(`leverage exceeds ${intent.venue} capability`);
    }
  }
  if (intent.instrument.expiry) {
    const expiry = Date.parse(intent.instrument.expiry);
    if (!cap.datedExpiry || !Number.isFinite(expiry)) throw new DerivativeCapabilityError(
      `${intent.venue} cannot represent this dated contract expiry`);
    if (expiry <= nowMs) throw new DerivativeCapabilityError("contract has reached expiry/delivery; no order was submitted");
  }
  if (intent.protective) {
    decimal(intent.protective.triggerPrice, "protective triggerPrice");
    if (!reducing || !["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(intent.orderType)) {
      throw new DerivativeCapabilityError("protective orders must be explicit reduce/close conditional orders");
    }
    if ((intent.protective.kind === "STOP_LOSS") !== (intent.orderType === "STOP_MARKET")) {
      throw new DerivativeCapabilityError("protective kind does not match its conditional order type");
    }
    if (intent.environment !== "paper"
        && (!cap.protective.nativeOrderTypes.includes(intent.orderType)
          || !cap.protective.nativeTriggerRoles.includes(intent.protective.triggerPriceRole))) {
      throw new DerivativeCapabilityError(`${intent.venue} cannot natively represent the requested protection`);
    }
  }
  if (!new RegExp(cap.clientOrderId.pattern).test(intent.clientOrderId)
      || intent.clientOrderId.length > cap.clientOrderId.maxLength) {
    throw new DerivativeCapabilityError(`${intent.venue} client order id violates provider constraints`);
  }
}

function safeBase(venue: DerivativeVenue, environment: DerivativeOrderIntent["environment"]): string {
  if (environment === "paper") return "https://paper.invalid";
  switch (venue) {
    case "binance": return "https://testnet.binancefuture.com";
    case "bybit": return environment === "demo" ? "https://api-demo.bybit.com" : "https://api-testnet.bybit.com";
    case "okx": return "https://www.okx.com";
    case "gateio": return "https://fx-api-testnet.gateio.ws";
    case "kraken": return "https://demo-futures.kraken.com";
    case "hyperliquid": return "https://api.hyperliquid-testnet.xyz";
    case "coinbase": return "https://api-n5e1.coinbase.com";
    case "kucoin": return "https://paper.invalid";
  }
}

function auth(intent: DerivativeOrderIntent, context: VenueBuildContext, method: "GET" | "POST" | "DELETE",
  path: string, body?: Json): PreparedVenueRequest {
  const bodyText = body ? json(body) : ""; const seconds = String(Math.floor(context.nowMs / 1000));
  let requestPath = path; let requestBody = bodyText; let preimage = "";
  let headers: Record<string, string> = { "content-type": "application/json" };
  switch (intent.venue) {
    case "binance": {
      const [pathname, existing = ""] = path.split("?"); const params = new URLSearchParams(existing);
      if (body) for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && typeof value !== "object") params.set(key, String(value));
      }
      params.set("timestamp", String(context.nowMs)); preimage = params.toString();
      params.set("signature", createHmac("sha256", context.credentials.apiSecret).update(preimage).digest("hex"));
      requestPath = body ? pathname! : `${pathname}?${params.toString()}`;
      requestBody = body ? params.toString() : "";
      headers = { "X-MBX-APIKEY": context.credentials.apiKey,
        "content-type": "application/x-www-form-urlencoded" }; break;
    }
    case "bybit": {
      const receiveWindow = "5000"; const queryText = path.split("?")[1] ?? "";
      preimage = `${context.nowMs}${context.credentials.apiKey}${receiveWindow}${body ? bodyText : queryText}`;
      headers = { "X-BAPI-API-KEY": context.credentials.apiKey, "X-BAPI-TIMESTAMP": String(context.nowMs),
        "X-BAPI-RECV-WINDOW": receiveWindow,
        "X-BAPI-SIGN": createHmac("sha256", context.credentials.apiSecret).update(preimage).digest("hex"),
        "content-type": "application/json" }; break;
    }
    case "okx": {
      const timestamp = new Date(context.nowMs).toISOString(); preimage = `${timestamp}${method}${path}${bodyText}`;
      headers = { "OK-ACCESS-KEY": context.credentials.apiKey,
        "OK-ACCESS-SIGN": createHmac("sha256", context.credentials.apiSecret).update(preimage).digest("base64"),
        "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": context.credentials.passphrase ?? "",
        "content-type": "application/json" };
      if (intent.environment === "demo") headers["x-simulated-trading"] = "1"; break;
    }
    case "kucoin": {
      preimage = `${context.nowMs}${method}${path}${bodyText}`;
      headers = { "KC-API-KEY": context.credentials.apiKey,
        "KC-API-SIGN": createHmac("sha256", context.credentials.apiSecret).update(preimage).digest("base64"),
        "KC-API-TIMESTAMP": String(context.nowMs), "KC-API-PASSPHRASE": createHmac("sha256",
          context.credentials.apiSecret).update(context.credentials.passphrase ?? "").digest("base64"),
        "KC-API-KEY-VERSION": "2", "content-type": "application/json" }; break;
    }
    case "gateio": {
      const [pathname, queryText = ""] = path.split("?"); preimage = [method, pathname, queryText,
        createHash("sha512").update(bodyText).digest("hex"), seconds].join("\n");
      headers = { KEY: context.credentials.apiKey, Timestamp: seconds,
        SIGN: createHmac("sha512", context.credentials.apiSecret).update(preimage).digest("hex"),
        "content-type": "application/json" }; break;
    }
    case "kraken": {
      preimage = `${bodyText}${context.nonce}${path}`;
      headers = { APIKey: context.credentials.apiKey,
        Authent: createHmac("sha512", context.credentials.apiSecret)
          .update(createHash("sha256").update(preimage).digest()).digest("base64"),
        Nonce: context.nonce, "content-type": "application/json" }; break;
    }
    case "coinbase": {
      preimage = `${seconds}${method}${path}${bodyText}`;
      headers = { "CB-ACCESS-KEY": context.credentials.apiKey,
        "CB-ACCESS-SIGN": createHmac("sha256", context.credentials.apiSecret).update(preimage).digest("base64"),
        "CB-ACCESS-TIMESTAMP": seconds, "CB-ACCESS-PASSPHRASE": context.credentials.passphrase ?? "",
        "content-type": "application/json" }; break;
    }
    case "hyperliquid": {
      preimage = `${context.nowMs}\n${context.nonce}\n${method}\n${path}\n${bodyText}`;
      headers = { "content-type": "application/json", "x-x3b-signing": "official-sdk-eip712-required" }; break;
    }
  }
  return { venue: intent.venue, environment: intent.environment, method, baseUrl: safeBase(intent.venue, intent.environment),
    path: requestPath, headers, ...(body ? { body: requestBody } : {}), signaturePreimage: preimage };
}

function venueQuantity(intent: DerivativeOrderIntent): string | undefined {
  if (!intent.quantity) return undefined;
  const price = intent.limitPrice ?? intent.paperReferencePrice ?? intent.position?.markPrice;
  if (!price && ((intent.instrument.kind === "LINEAR" && intent.quantityUnit === "CONTRACTS"
      && ["binance", "bybit"].includes(intent.venue)) || intent.quantityUnit === "BASE")) {
    throw new DerivativeCapabilityError("price observation is required to translate derivative sizing");
  }
  const sizing = price ? derivativeSizing(intent.instrument, intent.quantityUnit, intent.quantity, price) : null;
  // Binance/Bybit linear order quantity is BASE, while their inverse contracts
  // and OKX/KuCoin/Gate/Kraken sizes are contracts. Hyperliquid and Coinbase
  // International take BASE. The canonical request never guesses the unit.
  if ((intent.venue === "binance" || intent.venue === "bybit") && intent.instrument.kind === "LINEAR") {
    return sizing!.baseQuantity;
  }
  if (intent.venue === "hyperliquid" || intent.venue === "coinbase") return sizing!.baseQuantity;
  return sizing?.contracts ?? intent.quantity;
}

function submitBody(intent: DerivativeOrderIntent): Json {
  const qty = venueQuantity(intent); const conditional = intent.protective?.triggerPrice;
  switch (intent.venue) {
    case "binance": return { symbol: intent.venueSymbol, side: intent.actionSide, type: intent.orderType,
      newClientOrderId: intent.clientOrderId, ...(qty ? { quantity: qty } : {}),
      ...(intent.limitPrice ? { price: intent.limitPrice } : {}), ...(conditional ? { stopPrice: conditional,
        workingType: intent.protective!.triggerPriceRole === "MARK" ? "MARK_PRICE" : "CONTRACT_PRICE" } : {}),
      positionSide: intent.positionMode === "HEDGE" ? intent.positionDirection : "BOTH",
      ...(intent.reduceOnly ? { reduceOnly: "true" } : {}), ...(intent.closePosition ? { closePosition: "true" } : {}) };
    case "bybit": return { category: intent.instrument.kind === "INVERSE" ? "inverse" : "linear", symbol: intent.venueSymbol,
      side: intent.actionSide === "BUY" ? "Buy" : "Sell", orderType: intent.orderType === "LIMIT" ? "Limit" : "Market",
      orderLinkId: intent.clientOrderId, qty: intent.closePosition ? "0" : qty, reduceOnly: intent.reduceOnly || intent.closePosition,
      closeOnTrigger: intent.closePosition, positionIdx: intent.positionMode === "ONE_WAY" ? 0 : intent.positionDirection === "LONG" ? 1 : 2,
      ...(intent.limitPrice ? { price: intent.limitPrice } : {}), ...(conditional ? { triggerPrice: conditional,
        triggerBy: `${intent.protective!.triggerPriceRole[0]}${intent.protective!.triggerPriceRole.slice(1).toLowerCase()}Price` } : {}) };
    case "okx": return { instId: intent.venueSymbol, tdMode: intent.marginMode.toLowerCase(), side: intent.actionSide.toLowerCase(),
      posSide: intent.positionMode === "ONE_WAY" ? "net" : intent.positionDirection.toLowerCase(), ordType: intent.orderType.toLowerCase(),
      sz: qty, clOrdId: intent.clientOrderId, reduceOnly: intent.reduceOnly,
      ...(intent.limitPrice ? { px: intent.limitPrice } : {}), ...(conditional ? { triggerPx: conditional,
        triggerPxType: intent.protective!.triggerPriceRole.toLowerCase() } : {}) };
    case "kucoin": return { clientOid: intent.clientOrderId, symbol: intent.venueSymbol, side: intent.actionSide.toLowerCase(),
      type: intent.orderType === "LIMIT" ? "limit" : "market", size: intent.closePosition ? undefined : qty,
      closeOrder: intent.closePosition, reduceOnly: intent.reduceOnly, marginMode: intent.marginMode,
      ...(intent.leverage ? { leverage: intent.leverage } : {}), ...(intent.limitPrice ? { price: intent.limitPrice } : {}),
      ...(conditional ? { stop: intent.protective!.kind === "STOP_LOSS" ? "down" : "up", stopPrice: conditional,
        stopPriceType: intent.protective!.triggerPriceRole.slice(0, 2) } : {}) };
    case "gateio": return { contract: intent.venueSymbol, size: intent.closePosition ? 0 : intent.actionSide === "BUY" ? qty : `-${qty}`,
      text: intent.clientOrderId, tif: intent.timeInForce?.toLowerCase() ?? "gtc", reduce_only: intent.reduceOnly,
      close: intent.closePosition, ...(intent.limitPrice ? { price: intent.limitPrice } : { price: "0" }),
      ...(conditional ? { trigger: { price: conditional, rule: intent.protective!.kind === "STOP_LOSS" ? 2 : 1,
        price_type: intent.protective!.triggerPriceRole.toLowerCase() } } : {}) };
    case "kraken": return { orderType: intent.orderType.toLowerCase(), symbol: intent.venueSymbol,
      side: intent.actionSide.toLowerCase(), size: qty, cliOrdId: intent.clientOrderId, reduceOnly: intent.reduceOnly,
      ...(intent.limitPrice ? { limitPrice: intent.limitPrice } : {}), ...(conditional ? { stopPrice: conditional,
        triggerSignal: intent.protective!.triggerPriceRole.toLowerCase() } : {}) };
    case "hyperliquid": return { action: { type: "order", orders: [{ a: intent.venueSymbol,
      b: intent.actionSide === "BUY", p: intent.limitPrice ?? "0", s: intent.quantity, r: intent.reduceOnly,
      t: conditional ? { trigger: { isMarket: true, triggerPx: conditional, tpsl: intent.protective!.kind === "STOP_LOSS" ? "sl" : "tp" } }
        : { limit: { tif: intent.timeInForce === "POST_ONLY" ? "Alo" : intent.timeInForce === "IOC" ? "Ioc" : "Gtc" } },
      c: intent.clientOrderId }] }, nonce: contextlessNonce(intent), signature: "<BOT_EIP712_SIGNATURE>" };
    case "coinbase": return { client_order_id: intent.clientOrderId, instrument: intent.venueSymbol,
      side: intent.actionSide, type: intent.orderType, quantity: intent.quantity, reduce_only: intent.reduceOnly };
  }
}

const contextlessNonce = (intent: DerivativeOrderIntent): string => createHash("sha256")
  .update(intent.clientOrderId).digest("hex").slice(0, 16);

function paths(venue: DerivativeVenue, intent: DerivativeOrderIntent): { submit: string; query: string; cancel: string } {
  const id = encodeURIComponent(intent.clientOrderId);
  switch (venue) {
    case "binance": { const root = intent.instrument.kind === "INVERSE" ? "/dapi/v1/order" : "/fapi/v1/order";
      return { submit: root, query: `${root}?origClientOrderId=${id}&symbol=${encodeURIComponent(intent.venueSymbol)}`,
        cancel: `${root}?origClientOrderId=${id}&symbol=${encodeURIComponent(intent.venueSymbol)}` }; }
    case "bybit": return { submit: "/v5/order/create", query: `/v5/order/realtime?orderLinkId=${id}`,
      cancel: "/v5/order/cancel" };
    case "okx": return { submit: "/api/v5/trade/order", query: `/api/v5/trade/order?clOrdId=${id}&instId=${encodeURIComponent(intent.venueSymbol)}`,
      cancel: "/api/v5/trade/cancel-order" };
    case "kucoin": return { submit: "/api/v1/orders", query: `/api/v1/orders/byClientOid?clientOid=${id}`,
      cancel: `/api/v1/orders/client-order/${id}` };
    case "gateio": { const root = intent.instrument.expiry ? "/api/v4/delivery/usdt/orders" : "/api/v4/futures/usdt/orders";
      return { submit: root, query: `${root}/${id}`, cancel: `${root}/${id}` }; }
    case "kraken": return { submit: "/derivatives/api/v3/sendorder", query: `/derivatives/api/v3/openorders?cliOrdId=${id}`,
      cancel: "/derivatives/api/v3/cancelorder" };
    case "hyperliquid": return { submit: "/exchange", query: "/info", cancel: "/exchange" };
    case "coinbase": return { submit: "/api/v1/orders", query: `/api/v1/orders?client_order_id=${id}`,
      cancel: `/api/v1/orders/${id}` };
  }
}

const statuses: Record<string, DerivativeOrderSnapshot["status"]> = {
  new: "OPEN", open: "OPEN", live: "OPEN", active: "OPEN", partiallyfilled: "PARTIALLY_FILLED",
  partially_filled: "PARTIALLY_FILLED", partial: "PARTIALLY_FILLED", filled: "FILLED", closed: "FILLED",
  canceled: "CANCELED", cancelled: "CANCELED", rejected: "REJECTED", expired: "EXPIRED",
};

function status(value: unknown): DerivativeOrderSnapshot["status"] {
  const key = String(value ?? "").replace(/[ -]/g, "_").toLowerCase();
  const normalized = statuses[key] ?? statuses[key.replace(/_/g, "")];
  if (!normalized) throw new DerivativeCapabilityError(`unrecognized derivative provider lifecycle: ${String(value)}`);
  return normalized;
}

function projected(raw: unknown, venue: DerivativeVenue): Json {
  const root = record(raw);
  switch (venue) {
    case "binance": return root;
    case "bybit": return first(record(root.result).list);
    case "okx": return first(root.data);
    case "kucoin": return record(root.data);
    case "gateio": return root;
    case "kraken": return first(record(root.result).orders ?? root.orders);
    case "hyperliquid": return record(root.order ?? first(root.data));
    case "coinbase": return record(root.order ?? root);
  }
}

function pick(row: Json, ...keys: string[]): unknown {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]; return undefined;
}

function normalize(raw: unknown, intent: DerivativeOrderIntent, observedAt: string): DerivativeOrderSnapshot {
  const row = projected(raw, intent.venue);
  const providerOrderId = text(pick(row, "orderId", "ordId", "id", "order_id", "oid"), "");
  const clientOrderId = text(pick(row, "clientOrderId", "orderLinkId", "clOrdId", "clientOid", "text", "cliOrdId", "cloid", "client_order_id"), intent.clientOrderId);
  if (!providerOrderId || clientOrderId !== intent.clientOrderId) throw new DerivativeCapabilityError(
    "provider derivative order identity does not match intent");
  const providerFilled = text(pick(row, "filledContracts", "executedQty", "cumExecQty", "accFillSz", "dealSize", "fillSize", "filled_size"));
  const average = pick(row, "averageFillPrice", "avgPrice", "avgPx", "avgEntryPrice", "avg_deal_price", "price", "average_filled_price");
  const price = text(average, intent.limitPrice ?? intent.paperReferencePrice ?? intent.position?.markPrice ?? "1");
  const providerUsesBase = intent.instrument.kind === "LINEAR"
    && ["binance", "bybit", "hyperliquid", "coinbase"].includes(intent.venue);
  const filledContracts = providerUsesBase
    ? derivativeSizing(intent.instrument, "BASE", providerFilled, price).contracts : providerFilled;
  const sizing = derivativeSizing(intent.instrument, "CONTRACTS", filledContracts, price);
  const lifecycle = status(pick(row, "status", "orderStatus", "state", "isActive"));
  const feeAmount = pick(row, "fee", "cumExecFee", "fillFee", "total_fees");
  return { venue: intent.venue, environment: intent.environment, providerOrderId, clientOrderId,
    status: lifecycle, filledContracts, filledBaseQuantity: text(pick(row, "filledBaseQuantity"), sizing.baseQuantity),
    filledNotional: text(pick(row, "filledNotional", "cumExecValue", "fillNotional"), sizing.quoteNotional),
    averageFillPrice: average === undefined ? null : text(average), realizedPnl: text(pick(row, "realizedPnl", "closedPnl", "realized_pnl")),
    unrealizedPnl: text(pick(row, "unrealizedPnl", "unrealisedPnl", "unrealized_pnl")),
    pnlCurrency: text(pick(row, "pnlCurrency"), intent.instrument.settlementCurrency),
    funding: { amount: text(pick(row, "fundingAmount", "funding")), currency: text(pick(row, "fundingCurrency"), intent.instrument.settlementCurrency) },
    fee: feeAmount === undefined ? null : { amount: text(feeAmount), currency: text(pick(row, "feeCurrency", "feeCcy", "fee_currency"), intent.instrument.marginCurrency) },
    prices: { mark: pick(row, "markPrice", "mark_price") === undefined ? null : text(pick(row, "markPrice", "mark_price")),
      index: pick(row, "indexPrice", "index_price") === undefined ? null : text(pick(row, "indexPrice", "index_price")),
      last: pick(row, "lastPrice", "last_price") === undefined ? null : text(pick(row, "lastPrice", "last_price")) },
    liquidationPrice: pick(row, "liquidationPrice", "liqPrice") === undefined ? null : text(pick(row, "liquidationPrice", "liqPrice")),
    maintenanceMargin: pick(row, "maintenanceMargin", "maintMargin") === undefined ? null : text(pick(row, "maintenanceMargin", "maintMargin")),
    providerTimestamp: text(pick(row, "updateTime", "updatedAt", "timestamp"), observedAt), acknowledgedAt: observedAt,
    lastFillAt: Number(filledContracts) > 0 ? observedAt : null, rawStatus: text(pick(row, "status", "orderStatus", "state", "isActive")) };
}

function adapter(venue: DerivativeVenue): DerivativeVenueAdapter {
  const prepare = (kind: "submit" | "query" | "cancel", intent: DerivativeOrderIntent, context: VenueBuildContext) => {
    validateDerivativeIntent(intent, context.nowMs); const route = paths(venue, intent)[kind];
    if (kind === "submit") return auth(intent, context, "POST", route, submitBody(intent));
    if (kind === "query") return auth(intent, context, "GET", route);
    const body = venue === "bybit" ? { category: intent.instrument.kind.toLowerCase(), symbol: intent.venueSymbol,
      orderLinkId: intent.clientOrderId } : venue === "okx" ? { instId: intent.venueSymbol, clOrdId: intent.clientOrderId }
      : venue === "kraken" ? { cliOrdId: intent.clientOrderId } : venue === "hyperliquid"
        ? { action: { type: "cancelByCloid", cancels: [{ asset: intent.venueSymbol, cloid: intent.clientOrderId }] },
          signature: "<BOT_EIP712_SIGNATURE>" } : undefined;
    return auth(intent, context, venue === "binance" || venue === "kucoin" || venue === "gateio" || venue === "coinbase"
      ? "DELETE" : "POST", route, body);
  };
  return { capabilities: DERIVATIVE_CAPABILITIES[venue], validate: validateDerivativeIntent,
    prepareSubmit: (intent, context) => prepare("submit", intent, context),
    prepareQuery: (intent, context) => prepare("query", intent, context),
    prepareCancel: (intent, context) => prepare("cancel", intent, context),
    normalizeOrder: (raw, intent, observedAt) => normalize(raw, intent, observedAt) };
}

export const DERIVATIVE_ADAPTERS = {} as Record<DerivativeVenue, DerivativeVenueAdapter>;
for (const venue of Object.keys(DERIVATIVE_CAPABILITIES) as DerivativeVenue[]) {
  DERIVATIVE_ADAPTERS[venue] = adapter(venue);
}

export function derivativeAdapter(venue: DerivativeVenue): DerivativeVenueAdapter {
  return DERIVATIVE_ADAPTERS[venue];
}

export function derivativeFixtureContext(overrides: Partial<VenueBuildContext> = {}): VenueBuildContext {
  return { nowMs: Date.parse("2026-09-10T20:00:00.000Z"), nonce: "x3b-fixture-nonce",
    credentials: { apiKey: "fixture-key", apiSecret: "fixture-secret", passphrase: "fixture-passphrase" },
    ...overrides };
}
