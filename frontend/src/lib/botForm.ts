/**
 * Pure bot-form model: the field set, its defaults, and the payload shape the
 * API receives. Kept free of React so the defaults — which decide real order
 * size — can be asserted in a test without rendering anything.
 */
import type { InvestmentUnit } from "../api";

export const PAIRS = [
  "BTCUSDT", "ETHUSDT", "APTUSDT", "NEARUSDT", "TIAUSDT", "SOLUSDT",
  "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT",
];

export type BotFormState = {
  name: string;
  alertType: "custom" | "tradingview";
  direction: "long" | "short" | "reversal";
  pairs: string[];
  maxInvestmentPct: number;
  maxInvestmentUnit: InvestmentUnit;
  maxActiveSmartTradesEnabled: boolean;
  maxActiveSmartTrades: number;
  exchangeAccountId: string;
  entryEnabled: boolean;
  entryVolumePct: number;
  entryOrderType: "market" | "limit";
  exitEnabled: boolean;
  takeProfitEnabled: boolean;
  takeProfitPct: number;
  stopLossEnabled: boolean;
  stopLossPct: number;
};

export const defaultBotForm: BotFormState = {
  name: "Binance Spot Signal Bot",
  alertType: "custom",
  direction: "long",
  pairs: [],
  maxInvestmentPct: 100,
  maxInvestmentUnit: "pct_bot",
  maxActiveSmartTradesEnabled: false,
  maxActiveSmartTrades: 2,
  exchangeAccountId: "",
  entryEnabled: true,
  entryVolumePct: 100,
  entryOrderType: "market",
  exitEnabled: false,
  takeProfitEnabled: false,
  takeProfitPct: 5,
  stopLossEnabled: false,
  stopLossPct: 3,
};

export function buildBotPayload(form: BotFormState) {
  return {
    ...form,
    exchangeAccountId: form.exchangeAccountId || null,
    takeProfitPct: form.takeProfitEnabled ? form.takeProfitPct : null,
    stopLossPct: form.stopLossEnabled ? form.stopLossPct : null,
    maxActiveSmartTrades: form.maxActiveSmartTradesEnabled ? form.maxActiveSmartTrades : null,
  };
}
