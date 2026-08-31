import fs from "node:fs";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import {
  getBotRiskLimits, readBotRiskSnapshotSince,
  type BotRiskLimits, type BotRiskSnapshot,
} from "./riskControls.js";

export type ExchangeMode = "TESTNET" | "MAINNET" | "MIXED";

export interface BotOperationalStatus {
  service: { reachable: true; name: "signal-bot"; version: string | null };
  execution: {
    mode: "DRY_RUN" | "HALTED" | "LIVE";
    dryRun: boolean;
    halted: boolean;
    haltedBy: string | null;
    haltedReason: string | null;
  };
  exchange: {
    mode: ExchangeMode;
    processDefault: "TESTNET" | "MAINNET";
    configuredAccounts: { total: number; testnet: number; mainnet: number };
  };
  realisedPnl: {
    currency: "USDT";
    today: number;
    dayStart: string;
    timezone: "UTC";
    rollingWindowHours: number;
    rolling: number;
  };
  openTrades: { count: number; exposureQuote: number; currency: "USDT" };
  dailyLossProtection: {
    authority: "BOT";
    limitQuote: number | null;
    windowHours: number;
    realisedPnlInWindow: number;
    enabled: boolean;
  };
  time: string;
}

function packageVersion(): string | null {
  try {
    const raw = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const value = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function utcDayStart(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

interface OperationalStatusAuthDependencies {
  findBot: (secret: string) => Promise<{ id: string } | null>;
  readStatus: () => Promise<BotOperationalStatus>;
}

const defaultAuthDependencies: OperationalStatusAuthDependencies = {
  findBot: (secret) => prisma.signalBot.findUnique({
    where: { webhookSecret: secret },
    select: { id: true },
  }),
  readStatus: () => readBotOperationalStatus(),
};

/** Authenticate before reading any account-level state. Null means 401. */
export async function readBotOperationalStatusForSecret(
  secret: string,
  deps: OperationalStatusAuthDependencies = defaultAuthDependencies
): Promise<BotOperationalStatus | null> {
  const bot = await deps.findBot(secret);
  return bot ? deps.readStatus() : null;
}

export function buildBotOperationalStatus(input: {
  limits: BotRiskLimits;
  rolling: BotRiskSnapshot;
  today: BotRiskSnapshot;
  accounts: Array<{ testnet: boolean }>;
  now: number;
  dryRun: boolean;
  binanceTestnet: boolean;
  version: string | null;
}): BotOperationalStatus {
  const { limits, rolling, today, accounts, now } = input;
  const dayStart = utcDayStart(now);
  const testnet = accounts.filter((account) => account.testnet).length;
  const mainnet = accounts.length - testnet;
  const configuredModes = new Set(accounts.map((account) => account.testnet));
  // The process default remains a possible route for bots without an account.
  configuredModes.add(input.binanceTestnet);
  const exchangeMode: ExchangeMode = configuredModes.size > 1
    ? "MIXED"
    : input.binanceTestnet ? "TESTNET" : "MAINNET";

  return {
    service: { reachable: true, name: "signal-bot", version: input.version },
    execution: {
      mode: input.dryRun ? "DRY_RUN" : limits.tradingHalted ? "HALTED" : "LIVE",
      dryRun: input.dryRun,
      halted: limits.tradingHalted,
      haltedBy: limits.haltedBy,
      haltedReason: limits.haltedReason,
    },
    exchange: {
      mode: exchangeMode,
      processDefault: input.binanceTestnet ? "TESTNET" : "MAINNET",
      configuredAccounts: { total: accounts.length, testnet, mainnet },
    },
    realisedPnl: {
      currency: "USDT",
      today: today.realisedPnlInWindow,
      dayStart: dayStart.toISOString(),
      timezone: "UTC",
      rollingWindowHours: limits.dailyLossWindowHours,
      rolling: rolling.realisedPnlInWindow,
    },
    openTrades: {
      count: rolling.openTrades,
      exposureQuote: rolling.openExposureQuote,
      currency: "USDT",
    },
    dailyLossProtection: {
      authority: "BOT",
      limitQuote: limits.maxDailyLossQuote,
      windowHours: limits.dailyLossWindowHours,
      realisedPnlInWindow: rolling.realisedPnlInWindow,
      enabled: limits.maxDailyLossQuote !== null,
    },
    time: new Date(now).toISOString(),
  };
}

/** Read only from durable bot state; this function never contacts Binance. */
export async function readBotOperationalStatus(now = Date.now()): Promise<BotOperationalStatus> {
  const limits = await getBotRiskLimits();
  const dayStart = utcDayStart(now);
  const [rolling, today, accounts] = await Promise.all([
    readBotRiskSnapshotSince(new Date(now - limits.dailyLossWindowHours * 3_600_000)),
    readBotRiskSnapshotSince(dayStart),
    prisma.exchangeAccount.findMany({ select: { testnet: true } }),
  ]);

  return buildBotOperationalStatus({
    limits, rolling, today, accounts, now,
    dryRun: config.dryRun,
    binanceTestnet: config.binanceTestnet,
    version: packageVersion(),
  });
}
