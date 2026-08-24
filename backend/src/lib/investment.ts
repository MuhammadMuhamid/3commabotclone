import type { SignalBot } from "@prisma/client";

export const INVESTMENT_UNITS = {
  pct_bot: "% total USDT balance per Bot",
  pct_trade: "% total USDT balance per SmartTrade",
  usdt_bot: "USDT per Bot",
  usdt_trade: "USDT per SmartTrade",
} as const;

export type InvestmentUnit = keyof typeof INVESTMENT_UNITS;

const LEGACY_UNITS: Record<string, InvestmentUnit> = {
  "% USDT per Bot": "pct_bot",
  "% USDT per SmartTrade": "pct_trade",
  "USDT per Bot": "usdt_bot",
  "USDT per SmartTrade": "usdt_trade",
};

export function normalizeInvestmentUnit(unit: string): InvestmentUnit {
  if (unit in INVESTMENT_UNITS) return unit as InvestmentUnit;
  return LEGACY_UNITS[unit] ?? "pct_bot";
}

export function formatInvestmentLabel(amount: number, unit: string): string {
  const u = normalizeInvestmentUnit(unit);
  if (u === "usdt_bot" || u === "usdt_trade") return `${amount} USDT`;
  return `${amount}%`;
}

/** True for the units that mean "across this bot", not "per trade". */
export function isPerBotUnit(unit: string): boolean {
  const u = normalizeInvestmentUnit(unit);
  return u === "pct_bot" || u === "usdt_bot";
}

export function calcOrderQuoteUsdt(
  bot: SignalBot,
  usdtBalance: number,
  webhookQuote?: number | null,
  /**
   * Quote currency this bot already has committed across its OPEN trades.
   *
   * BOT-013: `usdt_bot` and `usdt_trade` — and `pct_bot` and `pct_trade` —
   * computed identically. Nothing summed the existing `quoteSpent`, so
   * "100 USDT per Bot" with three concurrent positions deployed 300 USDT: the
   * per-Bot units meant nothing, and the difference between the two was
   * cosmetic.
   *
   * Defaults to 0 so a caller that genuinely has no open positions — or an old
   * caller — behaves exactly as before for the per-trade units.
   */
  alreadyCommittedQuote = 0
): number {
  const amount = bot.maxInvestmentPct;
  const unit = normalizeInvestmentUnit(bot.maxInvestmentUnit || "pct_bot");

  let base: number;
  if (unit === "usdt_bot" || unit === "usdt_trade") {
    base = amount;
  } else {
    // A percentage of the balance. For a per-Bot unit the balance is the
    // reference point, and what is already committed is subtracted from the
    // resulting allowance below rather than from the balance — otherwise the
    // allowance would shrink twice.
    base = (usdtBalance * amount) / 100;
  }

  let configuredMaximum = Math.max(0, (base * bot.entryVolumePct) / 100);

  if (isPerBotUnit(unit)) {
    // "per Bot" is a CEILING on the bot's total commitment, so what is already
    // committed comes out of it. Once the ceiling is reached the allowance is
    // zero, and the caller refuses the order rather than opening another
    // full-sized position.
    configuredMaximum = Math.max(0, configuredMaximum - Math.max(0, alreadyCommittedQuote));
  }

  // A webhook may request a smaller order, but it must never override the
  // bot's configured risk ceiling or exceed the available USDT balance.
  const requested = webhookQuote == null ? configuredMaximum : webhookQuote;
  return Math.max(0, Math.min(requested, configuredMaximum, usdtBalance));
}
