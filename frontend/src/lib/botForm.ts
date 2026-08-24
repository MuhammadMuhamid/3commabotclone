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
  /**
   * BOT-012: only "long" is implemented. `binance.ts` hardcodes BUY and SELL,
   * and the value's only backend consumer was a cosmetic label — so a user
   * could configure a short bot, watch it accept signals, and get long
   * positions. The API now refuses anything else.
   */
  direction: "long";
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

/**
 * The defaults a NEW bot starts with.
 *
 * BOT-003 / BOT-015: these were `maxInvestmentPct: 100`, `entryVolumePct: 100`,
 * `exitEnabled: false`, `stopLossEnabled: false` and `takeProfitEnabled: false`
 * — so a bot created by filling in only a name and a pair converted the entire
 * free USDT balance into one spot position with NO automated exit path, and
 * then refused every exit webhook.
 *
 * They now match the database and API defaults: a 5 % position, exits enabled,
 * and a stop loss on. The API additionally refuses a position of
 * `UNPROTECTED_SIZE_LIMIT_PCT` or more with the stop loss turned off, so the
 * old configuration cannot be rebuilt by hand either.
 */
export const defaultBotForm: BotFormState = {
  name: "Binance Spot Signal Bot",
  alertType: "custom",
  direction: "long",
  pairs: [],
  maxInvestmentPct: 5,
  maxInvestmentUnit: "pct_bot",
  maxActiveSmartTradesEnabled: false,
  maxActiveSmartTrades: 2,
  exchangeAccountId: "",
  entryEnabled: true,
  entryVolumePct: 100,
  entryOrderType: "market",
  exitEnabled: true,
  takeProfitEnabled: false,
  takeProfitPct: 5,
  stopLossEnabled: true,
  stopLossPct: 3,
};

/** Mirrors the API's refusal, so the form can explain it before submitting. */
export const UNPROTECTED_SIZE_LIMIT_PCT = 50;

export function unsafeConfigReason(form: BotFormState): string | null {
  const isPct = form.maxInvestmentUnit === "pct_bot" || form.maxInvestmentUnit === "pct_trade";
  if (isPct) {
    const effective = (form.maxInvestmentPct * form.entryVolumePct) / 100;
    if (effective >= UNPROTECTED_SIZE_LIMIT_PCT && !form.stopLossEnabled) {
      return (
        `A position of ${UNPROTECTED_SIZE_LIMIT_PCT}% of the balance or more requires a ` +
        "stop loss. Enable Stop loss, or reduce the investment or entry volume."
      );
    }
  }
  if (form.stopLossEnabled && form.stopLossPct <= 0) {
    return "Stop loss % must be greater than 0.";
  }
  if (form.takeProfitEnabled && form.takeProfitPct <= 0) {
    return "Take profit % must be greater than 0.";
  }
  return null;
}

export function buildBotPayload(form: BotFormState) {
  return {
    ...form,
    exchangeAccountId: form.exchangeAccountId || null,
    takeProfitPct: form.takeProfitEnabled ? form.takeProfitPct : null,
    stopLossPct: form.stopLossEnabled ? form.stopLossPct : null,
    maxActiveSmartTrades: form.maxActiveSmartTradesEnabled ? form.maxActiveSmartTrades : null,
  };
}
