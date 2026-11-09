/**
 * OD-5: the environment a strategy order is routed to, decided ONCE, when
 * its intent is reserved, from exactly the inputs that choose the endpoint:
 *
 *   - DRY_RUN when the process runs dry (`strategyMarketAdapter` simulates);
 *   - otherwise the bot's exchange account's own network
 *     (`clientForIntent` -> `clientFromAccount`: testnet flag picks the host);
 *   - otherwise the process credentials' network (`clientFromEnv`:
 *     BINANCE_TESTNET picks the host).
 *
 * The value is stored on the intent and never re-derived: a restart with
 * BINANCE_TESTNET flipped, or an account later re-pointed, cannot relabel an
 * order that already happened.
 */
import type { SignalBot } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";

export type ExecutionEnvironment = "DRY_RUN" | "TESTNET" | "MAINNET" | "UNKNOWN";

export const EXECUTION_ENVIRONMENTS: readonly ExecutionEnvironment[] = ["DRY_RUN", "TESTNET", "MAINNET", "UNKNOWN"];

export async function executionEnvironmentForBot(
  bot: Pick<SignalBot, "exchangeAccountId">
): Promise<ExecutionEnvironment> {
  if (config.dryRun) return "DRY_RUN";
  if (bot.exchangeAccountId) {
    const account = await prisma.exchangeAccount.findUnique({
      where: { id: bot.exchangeAccountId }, select: { testnet: true },
    });
    if (!account) return "UNKNOWN"; // the reconciler cannot route it either
    return account.testnet ? "TESTNET" : "MAINNET";
  }
  return config.binanceTestnet ? "TESTNET" : "MAINNET";
}
