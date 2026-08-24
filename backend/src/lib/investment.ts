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

export function calcOrderQuoteUsdt(
  bot: SignalBot,
  usdtBalance: number,
  webhookQuote?: number | null
): number {
  const amount = bot.maxInvestmentPct;
  const unit = normalizeInvestmentUnit(bot.maxInvestmentUnit || "pct_bot");

  let base: number;
  if (unit === "usdt_bot" || unit === "usdt_trade") {
    base = amount;
  } else {
    base = (usdtBalance * amount) / 100;
  }

  const configuredMaximum = Math.max(0, (base * bot.entryVolumePct) / 100);
  // A webhook may request a smaller order, but it must never override the
  // bot's configured risk ceiling or exceed the available USDT balance.
  const requested = webhookQuote == null ? configuredMaximum : webhookQuote;
  return Math.max(0, Math.min(requested, configuredMaximum, usdtBalance));
}
