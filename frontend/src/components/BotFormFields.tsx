import { useEffect, useState } from "react";
import { TrendingUp, Wifi, Plus, X } from "lucide-react";
import { api, INVESTMENT_UNIT_LABELS, type ExchangeAccount, type InvestmentUnit } from "../api";
import { PAIRS, defaultBotForm, buildBotPayload, type BotFormState } from "../lib/botForm";

export { PAIRS, defaultBotForm, buildBotPayload };
export type { BotFormState };
import { Input, Section, Toggle, Badge } from "./ui";

// ─── Alert Type Card ────────────────────────────────────────────────────

function AlertCard({
  title,
  desc,
  selected,
  onClick,
  icon: Icon,
}: {
  title: string;
  desc: string;
  selected: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 rounded-xl border transition-all duration-150 ${
        selected
          ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)] shadow-[0_0_0_1px_var(--color-accent)]"
          : "border-[var(--color-border)] hover:border-[#3a4d66] hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Icon
          size={16}
          className={selected ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"}
        />
        <div className={`text-sm font-semibold ${selected ? "text-[var(--color-accent)]" : "text-white"}`}>
          {title}
        </div>
      </div>
      <p className="text-xs text-[var(--color-muted)] leading-relaxed">{desc}</p>
    </button>
  );
}

// ─── Direction Pill ──────────────────────────────────────────────────────

function DirPill({
  value,
  active,
  onClick,
}: {
  value: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-all ${
        active
          ? "bg-[var(--color-accent)] text-black"
          : "text-[var(--color-muted)] hover:text-white hover:bg-[var(--color-panel-3)]"
      }`}
    >
      {value}
    </button>
  );
}

// ─── BotFormFields ───────────────────────────────────────────────────────

export function BotFormFields({
  form,
  setForm,
}: {
  form: BotFormState;
  setForm: React.Dispatch<React.SetStateAction<BotFormState>>;
}) {
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [pairInput, setPairInput] = useState("");

  useEffect(() => {
    api.exchange.list().then(setAccounts).catch(console.error);
  }, []);

  useEffect(() => {
    if (!form.exchangeAccountId) { setBalance(null); return; }
    setBalanceLoading(true);
    api.exchange
      .balance(form.exchangeAccountId)
      .then((b) => setBalance(b.usdt))
      .catch(() => setBalance(null))
      .finally(() => setBalanceLoading(false));
  }, [form.exchangeAccountId]);

  const togglePair = (p: string) =>
    setForm((f) => ({
      ...f,
      pairs: f.pairs.includes(p) ? f.pairs.filter((x) => x !== p) : [...f.pairs, p],
    }));

  const addCustomPair = () => {
    const p = pairInput.trim().toUpperCase().replace(/\//g, "");
    if (p && !form.pairs.includes(p)) {
      setForm((f) => ({ ...f, pairs: [...f.pairs, p] }));
      setPairInput("");
    }
  };

  const approxUsdt =
    balance != null && form.maxInvestmentUnit.startsWith("pct")
      ? ((balance * form.maxInvestmentPct) / 100).toFixed(2)
      : null;

  return (
    <>
      {/* ── Main ── */}
      <Section
        title="Main"
        desc="Bot name, exchange account, direction and trading pairs."
      >
        {/* Alert type */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <AlertCard
            title="Custom Signal"
            desc="Any signal source via webhook JSON."
            icon={Wifi}
            selected={form.alertType === "custom"}
            onClick={() => setForm((f) => ({ ...f, alertType: "custom" }))}
          />
          <AlertCard
            title="TradingView Strategy"
            desc="Automate Pine Script strategy alerts."
            icon={TrendingUp}
            selected={form.alertType === "tradingview"}
            onClick={() => setForm((f) => ({ ...f, alertType: "tradingview" }))}
          />
        </div>

        <Input
          label="Bot name"
          value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          placeholder="e.g. NEAR/TIA Spot Bot"
        />

        {/* Exchange select */}
        <label className="block mb-4">
          <span className="text-xs font-medium text-[var(--color-muted)] block mb-1.5 uppercase tracking-wide">
            Exchange account
          </span>
          <select
            value={form.exchangeAccountId}
            onChange={(e) => setForm((f) => ({ ...f, exchangeAccountId: e.target.value }))}
            className="w-full bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]/30 transition-all"
          >
            <option value="">— Select account (add in Settings) —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · Binance Spot {a.testnet ? "(testnet)" : ""}
              </option>
            ))}
          </select>
          {form.exchangeAccountId && (
            <div className="mt-1.5 text-xs text-[var(--color-muted)]">
              {balanceLoading ? (
                "Fetching balance…"
              ) : balance != null ? (
                <span>
                  Available:{" "}
                  <span className="text-[var(--color-success)] font-medium">
                    {balance.toFixed(2)} USDT
                  </span>
                </span>
              ) : (
                <span className="text-[var(--color-warning)]">Could not fetch balance</span>
              )}
            </div>
          )}
        </label>

        {/* Direction */}
        {/*
          BOT-012: "short" and "reversal" were offered here with no caveat,
          accepted by the API and stored — while `binance.ts` hardcodes BUY and
          SELL and the value's only backend consumer was a cosmetic label. A
          user could configure a short bot, watch it accept signals, and get
          long positions. Only the implemented direction is offered now, and it
          says why, in the same way `entryOrderType`'s unimplemented "limit"
          state is already warned about below.
        */}
        <label className="block mb-4">
          <span className="text-xs font-medium text-[var(--color-muted)] block mb-1.5 uppercase tracking-wide">
            Direction
          </span>
          <div className="flex gap-1 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-xl p-1 w-fit">
            <DirPill value="long" active onClick={() => setForm((f) => ({ ...f, direction: "long" }))} />
          </div>
          <p className="text-[11px] text-[var(--color-muted)] mt-1.5 leading-relaxed">
            Spot long only. Short and reversal are not implemented — the order
            side is fixed in the exchange client — so they are no longer offered
            rather than accepted and ignored.
          </p>
        </label>

        {/* Pairs */}
        <label className="block mb-4">
          <span className="text-xs font-medium text-[var(--color-muted)] block mb-2 uppercase tracking-wide">
            Pairs
          </span>
          <div className="flex flex-wrap gap-2 mb-3 max-h-32 overflow-y-auto">
            {PAIRS.map((p) => {
              const sel = form.pairs.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePair(p)}
                  className={`px-2.5 py-1 rounded-lg text-xs border font-medium transition-all ${
                    sel
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
                      : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[#3a4d66] hover:text-white"
                  }`}
                >
                  {p.replace("USDT", "/USDT")}
                </button>
              );
            })}
          </div>

          {/* Custom pair input */}
          <div className="flex gap-2">
            <input
              value={pairInput}
              onChange={(e) => setPairInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustomPair())}
              placeholder="Custom e.g. WIFUSDT"
              className="flex-1 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--color-accent)] transition-all placeholder:text-[var(--color-muted)]"
            />
            <button
              type="button"
              onClick={addCustomPair}
              className="px-3 border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-muted)] hover:text-white hover:border-[#3a4d66] transition-all flex items-center gap-1"
            >
              <Plus size={13} />Add
            </button>
          </div>

          {/* Selected chips */}
          {form.pairs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {form.pairs.map((p) => (
                <span
                  key={p}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 bg-[var(--color-panel-3)] border border-[var(--color-border)] rounded-full text-[var(--color-accent)]"
                >
                  {p.replace("USDT", "/USDT")}
                  <button type="button" onClick={() => togglePair(p)} className="hover:text-[var(--color-danger)] transition-colors">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </label>

        {/* Max investment */}
        <label className="block mb-4">
          <span className="text-xs font-medium text-[var(--color-muted)] block mb-1.5 uppercase tracking-wide">
            Max. investment per order
          </span>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={0.01}
              step={form.maxInvestmentUnit.startsWith("usdt") ? 1 : 0.1}
              value={form.maxInvestmentPct}
              onChange={(e) => setForm((f) => ({ ...f, maxInvestmentPct: Number(e.target.value) }))}
              className="w-28 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--color-accent)] transition-all"
            />
            <select
              value={form.maxInvestmentUnit}
              onChange={(e) =>
                setForm((f) => ({ ...f, maxInvestmentUnit: e.target.value as InvestmentUnit }))
              }
              className="flex-1 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--color-accent)] transition-all"
            >
              {(Object.entries(INVESTMENT_UNIT_LABELS) as [InvestmentUnit, string][]).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          {approxUsdt && (
            <p className="text-xs text-[var(--color-muted)] mt-1.5">
              ≈{" "}
              <span className="text-[var(--color-success)] font-medium">{approxUsdt} USDT</span>
              {" "}of {balance?.toFixed(2)} USDT available
            </p>
          )}
        </label>

        {/* Max active SmartTrades */}
        <Toggle
          label="Cap concurrent SmartTrades"
          desc="Limit how many open trades this bot can have at once."
          on={form.maxActiveSmartTradesEnabled}
          onChange={(v) => setForm((f) => ({ ...f, maxActiveSmartTradesEnabled: v }))}
        />
        {form.maxActiveSmartTradesEnabled && (
          <div className="ml-0 mt-2">
            <Input
              label="Max concurrent trades"
              type="number"
              value={String(form.maxActiveSmartTrades)}
              min={1}
              step={1}
              onChange={(v) =>
                setForm((f) => ({ ...f, maxActiveSmartTrades: Math.max(1, Number(v)) }))
              }
              hint="e.g. 2 = at most 2 open trades simultaneously"
            />
          </div>
        )}
      </Section>

      {/* ── Order Settings ── */}
      <Section
        title="Order Settings"
        desc="Control how entries and exits are handled, and set automatic take-profit / stop-loss levels."
      >
        <Toggle
          label="Entry orders"
          desc="Allow buy signals from TradingView to open new positions."
          on={form.entryEnabled}
          onChange={(v) => setForm((f) => ({ ...f, entryEnabled: v }))}
        />

        {form.entryEnabled && (
          <div className="ml-0 mt-2 space-y-0 border-l-2 border-[var(--color-border)] pl-4 mb-2">
            <Input
              label="Volume per order (%)"
              type="number"
              value={String(form.entryVolumePct)}
              min={1}
              step={1}
              onChange={(v) => setForm((f) => ({ ...f, entryVolumePct: Number(v) }))}
              hint="Percentage of Max. investment to use for each order (default 100)."
              right={<span>%</span>}
            />
            <label className="block mb-4">
              <span className="text-xs font-medium text-[var(--color-muted)] block mb-1.5 uppercase tracking-wide">
                Order type
              </span>
              <div className="flex gap-1 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-xl p-1 w-fit">
                {(["market", "limit"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, entryOrderType: t }))}
                    className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-all ${
                      form.entryOrderType === t
                        ? "bg-[var(--color-accent)] text-black"
                        : "text-[var(--color-muted)] hover:text-white hover:bg-[var(--color-panel-3)]"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {form.entryOrderType === "limit" && (
                <p className="text-xs text-amber-400 mt-2 flex items-center gap-1">
                  <span>⚠</span> Limit orders are stored but only market orders execute. Limit support is planned.
                </p>
              )}
            </label>
          </div>
        )}

        <div className="border-t border-[var(--color-border)] pt-4 mt-2">
          <Toggle
            label="Exit orders"
            desc="Allow sell signals from TradingView to close positions."
            on={form.exitEnabled}
            onChange={(v) => setForm((f) => ({ ...f, exitEnabled: v }))}
          />
        </div>

        <div className="border-t border-[var(--color-border)] pt-4 mt-2">
          <Toggle
            label="Take profit"
            desc="Automatically close when PnL reaches this percentage."
            on={form.takeProfitEnabled}
            onChange={(v) => setForm((f) => ({ ...f, takeProfitEnabled: v }))}
          />
          {form.takeProfitEnabled && (
            <div className="mt-2 ml-0 border-l-2 border-[var(--color-success)]/40 pl-4">
              <Input
                label="Take profit threshold"
                type="number"
                value={String(form.takeProfitPct)}
                min={0.1}
                step={0.1}
                onChange={(v) => setForm((f) => ({ ...f, takeProfitPct: Number(v) }))}
                hint="e.g. 3 = close when PnL ≥ +3%"
                right={<span>%</span>}
              />
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] pt-4 mt-2">
          <Toggle
            label="Stop loss"
            /*
             * V1-UX-2: say what this control actually is. There is no resting
             * stop order at Binance unless EXCHANGE_STOPS_ENABLED is on, and it
             * is off by default — so this is a 30-second poll inside the bot
             * process, and it protects nothing while that process is down.
             */
            desc={
              "Automatically close to limit losses at this percentage. This is a " +
              "30-second check inside this bot's own process, not a resting stop " +
              "order at Binance: it cannot act while the server is down, and a " +
              "price gap is closed at the next check rather than at your level."
            }
            on={form.stopLossEnabled}
            onChange={(v) => setForm((f) => ({ ...f, stopLossEnabled: v }))}
          />
          {form.stopLossEnabled && (
            <div className="mt-2 ml-0 border-l-2 border-[var(--color-danger)]/40 pl-4">
              <Input
                label="Stop loss threshold"
                type="number"
                value={String(form.stopLossPct)}
                min={0.1}
                step={0.1}
                onChange={(v) => setForm((f) => ({ ...f, stopLossPct: Number(v) }))}
                hint="e.g. 3 = close when PnL ≤ −3%"
                right={<span>%</span>}
              />
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="danger">−{form.stopLossPct}%</Badge>
                <span className="text-xs text-[var(--color-muted)]">will trigger automatic exit</span>
              </div>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}
