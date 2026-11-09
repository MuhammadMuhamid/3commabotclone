/**
 * OD-4: check submitted exchange keys BEFORE anything is stored.
 *
 * The only new exchange call this slice adds. It is read-only (`accountInfo`,
 * and on mainnet `apiPermission` = `/sapi/v1/account/apiRestrictions`) and
 * runs against a client built from the SUBMITTED keys, never a stored one.
 * The client factory is injectable so tests use a fake and never reach
 * Binance.
 *
 * Refusals never echo the exchange's own text (it can quote the request).
 *
 * [EXT-UNVERIFIED] Binance semantics this relies on: `accountInfo.canTrade`;
 * spot permission reported in `permissions` (legacy) or `permissionSets`
 * (newer) or `accountType: "SPOT"`; `/sapi` is unavailable on testnet, so
 * withdrawal and IP-restriction settings are not checked there (said so in
 * the answer).
 */
import { clientFromKeys } from "./binance.js";

export interface ProbeAccountInfo {
  canTrade?: boolean;
  permissions?: string[];
  permissionSets?: string[][];
  accountType?: string;
}

export interface ProbeApiRestrictions {
  enableWithdrawals?: boolean;
  ipRestrict?: boolean;
  enableSpotAndMarginTrading?: boolean;
}

export interface ProbeClient {
  accountInfo(): Promise<ProbeAccountInfo>;
  apiPermission(): Promise<ProbeApiRestrictions>;
}

/** Injectable: how submitted keys become a (read-only) probe client. */
export const enrollmentProbeClient: {
  fromKeys: (keys: { apiKey: string; apiSecret: string }, testnet: boolean) => ProbeClient;
  timeoutMs: number;
} = {
  fromKeys: (keys, testnet) => {
    // Through the one exchange seam (services/binance.ts), as every exchange call.
    const client = clientFromKeys(keys, testnet);
    return {
      accountInfo: () => client.accountInfo() as Promise<ProbeAccountInfo>,
      apiPermission: () => client.apiPermission() as Promise<ProbeApiRestrictions>,
    };
  },
  timeoutMs: 10_000,
};

export type ProbeOutcome =
  | { ok: true; warnings: string[] }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      /** A refusal caused by the keys themselves (counted against the session). */
      keysAtFault: boolean;
    };

/** Definite "these keys are not accepted" answers; anything else is transport/unknown. */
const AUTH_CODES = new Set([-2014, -2015, -1022, -2008, -1002]);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe timed out")), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error("probe failed")); });
  });
}

function classifyProbeError(error: unknown): ProbeOutcome {
  const code = Number((error as { code?: unknown } | null)?.code);
  if (AUTH_CODES.has(code)) {
    return { ok: false, status: 422, code: "keys_rejected", keysAtFault: true,
      message: "Binance rejected these keys (invalid key, wrong secret, or this server's IP is not allowed). Nothing was stored." };
  }
  return { ok: false, status: 503, code: "exchange_unavailable", keysAtFault: false,
    message: "Binance could not be reached to check these keys. Nothing was stored; try again." };
}

function hasSpot(info: ProbeAccountInfo): boolean {
  if (Array.isArray(info.permissions) && info.permissions.includes("SPOT")) return true;
  if (Array.isArray(info.permissionSets) && info.permissionSets.some((set) => Array.isArray(set) && set.includes("SPOT"))) {
    return true;
  }
  return info.accountType === "SPOT";
}

export async function probeExchangeKeys(
  keys: { apiKey: string; apiSecret: string },
  testnet: boolean
): Promise<ProbeOutcome> {
  const warnings: string[] = [];
  let client: ProbeClient;
  try {
    client = enrollmentProbeClient.fromKeys(keys, testnet);
  } catch (error) {
    return classifyProbeError(error);
  }

  let info: ProbeAccountInfo;
  try {
    info = await withTimeout(client.accountInfo(), enrollmentProbeClient.timeoutMs);
  } catch (error) {
    return classifyProbeError(error);
  }
  if (info.canTrade !== true) {
    return { ok: false, status: 422, code: "keys_cannot_trade", keysAtFault: true,
      message: "These keys cannot trade. Enable Spot trading for the key on Binance, then try again." };
  }
  if (!hasSpot(info)) {
    return { ok: false, status: 422, code: "keys_not_spot", keysAtFault: true,
      message: "These keys do not have Spot permission. Enable Spot & Margin trading for the key, then try again." };
  }

  if (testnet) {
    warnings.push("Binance testnet cannot report withdrawal or IP-restriction settings, so they were not checked.");
    return { ok: true, warnings };
  }

  let restrictions: ProbeApiRestrictions;
  try {
    restrictions = await withTimeout(client.apiPermission(), enrollmentProbeClient.timeoutMs);
  } catch (error) {
    return classifyProbeError(error);
  }
  if (restrictions.enableWithdrawals === true) {
    return { ok: false, status: 422, code: "withdrawals_enabled", keysAtFault: true,
      message: "This key can WITHDRAW funds. Create a key with withdrawals disabled; it is refused." };
  }
  if (restrictions.enableSpotAndMarginTrading === false) {
    return { ok: false, status: 422, code: "keys_cannot_trade", keysAtFault: true,
      message: "Spot & Margin trading is not enabled for this key. Enable it on Binance, then try again." };
  }
  if (restrictions.ipRestrict !== true) {
    warnings.push("This key is not restricted to trusted IPs. Restrict it to this server's IP address on Binance.");
  }
  return { ok: true, warnings };
}
