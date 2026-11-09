/**
 * Exchange-account custody, shared by the Classic dashboard
 * (`routes/exchange.ts`), the Platform's signed commands (C15, C16, C19) and
 * the Bot-origin enrollment page (`routes/enroll.ts`, OD-4).
 *
 * Key material only ever moves INTO this module: it is encrypted on the way
 * to the database and never returned. Reads expose names, networks, a
 * four-character key hint and usage counts — nothing that authenticates.
 */
import { z } from "zod";
import type { ExchangeAccount, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { canStoreSecrets, encrypt } from "../lib/crypto.js";
import { clientFromAccount, getTotalBalanceUsdt, type BinanceClient } from "./binance.js";
import { ControlRefusal } from "./controlCommands.js";

export const ACCOUNT_NAME_MAX = 64;
/** Binance keys are 64 characters; anything past this is not a key. */
const KEY_MAX = 256;

export const accountNameSchema = z.string().trim().min(1, "name is required")
  .max(ACCOUNT_NAME_MAX, `name must be at most ${ACCOUNT_NAME_MAX} characters`);
export const apiKeySchema = z.string().trim().min(1, "apiKey is required").max(KEY_MAX, "apiKey is too long");
export const apiSecretSchema = z.string().trim().min(1, "apiSecret is required")
  .max(KEY_MAX, "apiSecret is too long");

/** The last four characters of an API key: enough to recognise it, not to use it. */
export function keyHintOf(apiKey: string): string {
  return apiKey.trim().slice(-4);
}

/** Refuse before anything is written when key material cannot be stored safely. */
export function assertCanStoreSecrets(): void {
  if (!canStoreSecrets()) {
    throw new ControlRefusal(503, "secrets_unavailable",
      "Cannot store exchange credentials: ENCRYPTION_KEY and SCRYPT_SALT are not configured. " +
      "See backend/.env.example.");
  }
}

/**
 * The typed MAINNET confirmation, verified by the server (parity inventory §5
 * #10). The dashboard used to check it in the browser only, so any other
 * client created a real-money account with `testnet:false` alone.
 */
export function assertMainnetConfirmed(testnet: boolean, confirmation: unknown): void {
  if (!testnet && confirmation !== "MAINNET") {
    throw new ControlRefusal(400, "mainnet_confirmation_required",
      "A mainnet (real-money) account needs the typed confirmation mainnetConfirmation: \"MAINNET\".");
  }
}

/** The extended client inside an interactive transaction (or the client itself). */
type Tx = Pick<typeof prisma, "exchangeAccount">;

export interface AccountKeys { apiKey: string; apiSecret: string }

/** Store a new account. Callers have already validated and (for OD-4) probed the keys. */
export async function createExchangeAccount(
  input: { name: string } & AccountKeys & { testnet: boolean },
  tx: Tx = prisma
): Promise<ExchangeAccount> {
  assertCanStoreSecrets();
  return tx.exchangeAccount.create({ data: {
    name: input.name.trim(),
    apiKeyEnc: encrypt(input.apiKey.trim()),
    apiSecretEnc: encrypt(input.apiSecret.trim()),
    keyHint: keyHintOf(input.apiKey),
    testnet: input.testnet,
  } });
}

/**
 * Replace an account's keys in place (OD-4 `replace`). The network never
 * changes here — a different network is a different account — so the write is
 * conditional on the network the enrollment was issued for.
 */
export async function replaceExchangeAccountKeys(
  id: string, keys: AccountKeys, expectedTestnet: boolean, tx: Tx = prisma
): Promise<ExchangeAccount> {
  assertCanStoreSecrets();
  const updated = await tx.exchangeAccount.updateMany({
    where: { id, testnet: expectedTestnet },
    data: {
      apiKeyEnc: encrypt(keys.apiKey.trim()),
      apiSecretEnc: encrypt(keys.apiSecret.trim()),
      keyHint: keyHintOf(keys.apiKey),
    },
  });
  if (updated.count !== 1) {
    throw new ControlRefusal(409, "account_unavailable",
      "That exchange account no longer exists, or is on a different network.");
  }
  return tx.exchangeAccount.findUniqueOrThrow({ where: { id } });
}

export interface ExchangeAccountView {
  id: string;
  name: string;
  exchange: string;
  marketType: string;
  testnet: boolean;
  createdAt: string;
  keyHint: string | null;
  botsUsing: number;
  openTrades: number;
}

/** Open positions held on an account: manual positions carry it, strategy trades inherit it from their bot. */
function openTradesWhere(id: string): Prisma.SmartTradeWhereInput {
  return { status: "active", OR: [{ exchangeAccountId: id }, { bot: { exchangeAccountId: id } }] };
}

/** C15: every account, no key material. */
export async function listExchangeAccounts(): Promise<ExchangeAccountView[]> {
  const accounts = await prisma.exchangeAccount.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, exchange: true, marketType: true, testnet: true, createdAt: true, keyHint: true },
  });
  return Promise.all(accounts.map(async (a) => {
    const [botsUsing, openTrades] = await Promise.all([
      prisma.signalBot.count({ where: { exchangeAccountId: a.id } }),
      prisma.smartTrade.count({ where: openTradesWhere(a.id) }),
    ]);
    return {
      id: a.id, name: a.name, exchange: a.exchange, marketType: a.marketType, testnet: a.testnet,
      createdAt: a.createdAt.toISOString(), keyHint: a.keyHint ?? null, botsUsing, openTrades,
    };
  }));
}

/**
 * Delete an account only when nothing references it (BUG-06), atomically.
 *
 * The reference counts and the delete run in one transaction, and the delete
 * itself matches only while every relation is still empty, so a bot linked or
 * an order placed after the counts cannot be orphaned. (The schema's default
 * for these optional relations is SET NULL: without this guard a bot would
 * silently lose its credentials.)
 */
export async function deleteExchangeAccountGuarded(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const exists = await tx.exchangeAccount.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new ControlRefusal(404, "account_not_found", "Not found");
    const [bots, manualOrders, positions, spot, derivatives] = await Promise.all([
      tx.signalBot.count({ where: { exchangeAccountId: id } }),
      tx.manualOrder.count({ where: { exchangeAccountId: id } }),
      tx.smartTrade.count({ where: { exchangeAccountId: id } }),
      tx.spotExecutionOrder.count({ where: { exchangeAccountId: id } }),
      tx.derivativeExecutionOrder.count({ where: { exchangeAccountId: id } }),
    ]);
    const inUse = () => new ControlRefusal(409, "account_in_use",
      `Cannot delete: ${bots} bot(s), ${manualOrders} manual order(s), ${positions} manual position ` +
      `record(s), ${spot} Spot execution order(s) and ${derivatives} derivatives execution order(s) ` +
      "use this account. Preserve or reassign them first.");
    if (bots + manualOrders + positions + spot + derivatives > 0) throw inUse();
    const removed = await tx.exchangeAccount.deleteMany({ where: {
      id,
      bots: { none: {} },
      manualOrders: { none: {} },
      smartTrades: { none: {} },
      spotExecutionOrders: { none: {} },
      derivativeExecutionOrders: { none: {} },
    } });
    if (removed.count !== 1) throw inUse();
  });
}

/** Injectable for tests: how a stored account becomes an exchange client (C19). */
export const accountBalanceClient: { resolve: (account: ExchangeAccount) => BinanceClient } = {
  resolve: (account) => clientFromAccount(account),
};

export interface AccountBalanceView {
  usdtFree: number;
  totalUsdt: number;
  breakdown: Array<{ asset: string; free: number; locked: number; usdt: number }>;
  cachedAt: string;
}

/**
 * C19: the account's balances, valued in USDT. Keys are decrypted
 * server-side; only numbers leave. Any exchange failure is one typed 502 —
 * the exchange's own text is not passed on.
 */
export async function readAccountBalance(id: string): Promise<AccountBalanceView> {
  const account = await prisma.exchangeAccount.findUnique({ where: { id } });
  if (!account) throw new ControlRefusal(404, "account_not_found", "That exchange account does not exist.");
  try {
    const client = accountBalanceClient.resolve(account);
    const info = await client.accountInfo();
    const valued = await getTotalBalanceUsdt({
      accountInfo: async () => info,
      prices: client.prices.bind(client),
    } as unknown as BinanceClient);
    const byAsset = new Map(info.balances.map((b) => [b.asset, b]));
    const usdt = byAsset.get("USDT");
    return {
      usdtFree: Number.parseFloat(usdt?.free ?? "0") || 0,
      totalUsdt: valued.totalUsdt,
      breakdown: valued.breakdown.map((row) => {
        const balance = byAsset.get(row.asset);
        return {
          asset: row.asset,
          free: Number.parseFloat(balance?.free ?? "0") || 0,
          locked: Number.parseFloat(balance?.locked ?? "0") || 0,
          usdt: row.valueUsdt,
        };
      }),
      cachedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof ControlRefusal) throw error;
    throw new ControlRefusal(502, "exchange_unavailable",
      "The exchange could not be reached, or refused this account's keys. Nothing was changed.");
  }
}
