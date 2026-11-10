import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  TrendingUp, TrendingDown, Layers, DollarSign, BarChart3,
  Bot, ChevronRight, ArrowUpRight, ArrowDownRight, Clock,
  Zap, X, Play, Square, Pencil, RefreshCw, Wallet, Scissors, ShieldAlert, PauseCircle,
  Archive, ArchiveRestore,
} from "lucide-react";
import {
  api, formatPair, type BotListItem, type SmartTrade, type Stats, type ExchangeAccount,
  type EntriesStatus,
} from "../api";
import {
  Btn, Badge, StatusDot, LongBadge, Skeleton, toast,
} from "../components/ui";
import { Dialog } from "../components/Dialog";
import { startDashboardPolling } from "../dashboardPolling";

type BotFilter = "all" | "active" | "stopped";

/** What a Bot halt does — the policy, stated as the contract states it (F2). */
const HALT_POLICY =
  "While the Bot is halted, TP/SL protection is not checked and TradingView exits are refused; " +
  "your own SELL / Close / Partial still work.";

/** What "Pause new entries" does (OD-3) — separate from the halt. */
const ENTRIES_PAUSE_POLICY =
  "While new entries are paused, every BUY is refused (signals and manual). Exits, TP/SL " +
  "protection and your own SELL / Close / Partial keep working. A LIMIT BUY already resting " +
  "at the exchange is not stopped by the pause unless you also cancel it.";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtUsdt(n: number, digits = 4) {
  const abs = Math.abs(n).toFixed(digits);
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function fmtDuration(since: string) {
  const ms = Math.max(0, Date.now() - new Date(since).getTime());
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// ─── History stats helpers ────────────────────────────────────────────────────

function calcHistoryStats(trades: SmartTrade[]) {
  const winners = trades.filter((t) => t.pnlUsdt > 0);
  const losers  = trades.filter((t) => t.pnlUsdt < 0);

  const totalProfitUsdt = winners.reduce((s, t) => s + t.pnlUsdt, 0);
  const totalProfitPct  = winners.reduce((s, t) => s + t.pnlPct,  0);

  const totalLossUsdt = losers.reduce((s, t) => s + t.pnlUsdt, 0);
  const totalLossPct  = losers.reduce((s, t) => s + t.pnlPct,  0);

  const totalPnlUsdt = trades.reduce((s, t) => s + t.pnlUsdt, 0);

  // Max drawdown = the single worst losing trade
  const worstTrade = losers.length > 0
    ? losers.reduce((min, t) => t.pnlUsdt < min.pnlUsdt ? t : min, losers[0])
    : null;
  const maxDdUsdt = worstTrade?.pnlUsdt ?? 0;
  const maxDdPct  = worstTrade?.pnlPct  ?? 0;

  return { totalProfitUsdt, totalProfitPct, totalLossUsdt, totalLossPct, totalPnlUsdt, maxDdUsdt, maxDdPct };
}

function HistoryStatsBar({ trades }: { trades: SmartTrade[] }) {
  const [visible, setVisible] = useState(true);
  if (trades.length === 0) return null;

  const { totalProfitUsdt, totalProfitPct, totalLossUsdt, totalLossPct, totalPnlUsdt, maxDdUsdt, maxDdPct } =
    calcHistoryStats(trades);
  const netPos = totalPnlUsdt >= 0;

  return (
    <div className="border-b border-[var(--color-border)]">
      {/* Toggle row */}
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-panel-2)]/40">
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
          <BarChart3 size={11} />
          <span className="uppercase tracking-wide font-semibold">History Summary</span>
          <span>· {trades.length} trades</span>
        </div>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="text-[10px] text-[var(--color-muted)] hover:text-white transition-colors px-2 py-0.5 rounded border border-[var(--color-border)] hover:border-[#3a4d66]"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>

      {/* Stats row */}
      {visible && (
        <div className="flex flex-wrap items-center gap-5 px-4 py-3 bg-[var(--color-panel-2)]/20">
          {/* Total Profit */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-muted)]">Total Profit</span>
            <span className="text-sm font-bold text-[var(--color-success)]">
              +{totalProfitUsdt.toFixed(4)} USDT
            </span>
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-[var(--color-success-dim)] text-[var(--color-success)]">
              +{totalProfitPct.toFixed(2)}%
            </span>
          </div>

          <div className="w-px h-4 bg-[var(--color-border)]" />

          {/* Total Loss */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-muted)]">Total Loss</span>
            <span className="text-sm font-bold text-[var(--color-danger)]">
              {totalLossUsdt.toFixed(4)} USDT
            </span>
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-[var(--color-danger-dim)] text-[var(--color-danger)]">
              {totalLossPct.toFixed(2)}%
            </span>
          </div>

          <div className="w-px h-4 bg-[var(--color-border)]" />

          {/* Total P&L */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-muted)]">Total P&L</span>
            <span className={`text-sm font-bold ${netPos ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
              {netPos ? "+" : ""}{totalPnlUsdt.toFixed(4)} USDT
            </span>
          </div>

          {maxDdUsdt < 0 && (
            <>
              <div className="w-px h-4 bg-[var(--color-border)]" />
              {/* Max Drawdown */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-muted)]">Max Drawdown</span>
                <span className="text-sm font-bold text-[var(--color-danger)]">
                  {maxDdUsdt.toFixed(4)} USDT
                </span>
                <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-[var(--color-danger-dim)] text-[var(--color-danger)]">
                  {maxDdPct.toFixed(2)}%
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── F1: Live Balance Widget ──────────────────────────────────────────────────

const BALANCE_TTL = 60_000; // 60s client-side cache — avoids hammering Binance

function BalanceWidget({ account }: { account: ExchangeAccount }) {
  const [totalUsdt, setTotalUsdt] = useState<number | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(false);
  const cacheRef = useRef<{ value: number; ts: number } | null>(null);

  const refresh = useCallback(async () => {
    if (cacheRef.current && Date.now() - cacheRef.current.ts < BALANCE_TTL) {
      setTotalUsdt(cacheRef.current.value);
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const data = await api.exchange.totalBalance(account.id);
      cacheRef.current = { value: data.totalUsdt, ts: Date.now() };
      setTotalUsdt(data.totalUsdt);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, BALANCE_TTL);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl px-5 py-4 card-hover">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">
          Total Balance
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-muted)]">{account.name}</span>
          <div className="w-7 h-7 rounded-lg bg-[var(--color-panel-2)] flex items-center justify-center">
            <Wallet size={14} className="text-[var(--color-muted)]" />
          </div>
        </div>
      </div>
      {loading ? (
        <>
          <Skeleton className="h-7 w-36 mb-1.5" />
          <Skeleton className="h-3.5 w-24" />
        </>
      ) : error ? (
        <div className="text-sm text-[var(--color-danger)]">
          Binance error
          <button
            type="button"
            onClick={refresh}
            className="ml-2 text-[10px] text-[var(--color-muted)] hover:text-white underline"
          >
            retry
          </button>
        </div>
      ) : (
        <>
          <div className="text-2xl font-bold tracking-tight text-white">
            {fmtUsdt(totalUsdt ?? 0, 2)}
          </div>
          <div className="text-xs text-[var(--color-muted)] mt-1">
            Refreshes every 60s
          </div>
        </>
      )}
    </div>
  );
}

// ─── F4: Partial Close Modal ──────────────────────────────────────────────────

const PRESETS = [25, 50, 75];

function PartialCloseModal({
  trade,
  onDone,
  onClose,
}: {
  trade: SmartTrade;
  onDone: () => void;
  onClose: () => void;
}) {
  const [pct, setPct]   = useState(50);
  const [busy, setBusy] = useState(false);
  const pair = formatPair(trade.pair);
  const base = pair.split("/")[0];

  const sellQty   = trade.quantity * (pct / 100);
  const sellCost  = trade.quoteSpent * (pct / 100);
  const entryP    = trade.entryPrice ?? 0;
  const currentP  = trade.currentPrice ?? entryP;
  const estRev    = sellQty * currentP * 0.999; // after sell fee
  const estPnl    = estRev - sellCost * 1.001;   // also deduct buy fee

  const execute = async () => {
    if (!confirm(`Sell ${pct}% of your ${pair} position at market price?`)) return;
    setBusy(true);
    try {
      const result = await api.trades.partialClose(trade.id, pct);
      if ("status" in result) {
        // Submitted, outcome not yet known: never announced as sold or failed.
        toast(result.detail, "info");
        onDone();
        return;
      }
      // BOT-P1-6: report what the exchange actually filled, not what was asked
      // for. A zero fill sold nothing and must never be announced as executed.
      if (result.executedQty > 0) {
        toast(
          `Partial close (${pct}%): sold ${result.executedQty} of ${result.requestedQty} ${base}`,
          result.executedQty >= result.requestedQty ? "success" : "info"
        );
      } else {
        toast(result.detail ?? `Partial close (${pct}%) filled nothing; position unchanged`, "error");
      }
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Partial close failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Partial Close"
      icon={<Scissors size={15} className="text-[var(--color-accent)]" aria-hidden="true" />}
    >
      <>
        {/* Position summary */}
        <div className="bg-[var(--color-panel-2)] rounded-xl p-3 mb-5 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Pair</span>
            <span className="text-white font-medium">{pair}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Full position</span>
            <span className="text-white">{trade.quantity.toFixed(6)} {base}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Cost basis</span>
            <span className="text-white">{fmtUsdt(trade.quoteSpent, 2)}</span>
          </div>
        </div>

        {/* Preset % buttons */}
        <p className="text-xs text-[var(--color-muted)] mb-2">Amount to close</p>
        <div className="flex gap-2 mb-3">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPct(p)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-all ${
                pct === p
                  ? "bg-[var(--color-accent)] text-black border-transparent"
                  : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-white hover:border-[#3a4d66]"
              }`}
            >
              {p}%
            </button>
          ))}
        </div>

        {/* Custom slider */}
        <input
          type="range"
          min={1}
          max={99}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          aria-label="Percentage of the position to close"
          aria-valuetext={`${pct} percent`}
          className="w-full accent-[var(--color-accent)] mb-1"
        />
        <div className="text-center text-lg font-bold text-[var(--color-accent)] mb-4">
          {pct}%
        </div>

        {/* Preview */}
        <div className="bg-[var(--color-panel-2)] rounded-xl p-3 mb-5 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Selling</span>
            <span className="text-white">{sellQty.toFixed(6)} {base}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-muted)]">Est. revenue <span className="text-[8px]">(after 0.1% fee)</span></span>
            <span className="text-white">{fmtUsdt(estRev, 2)}</span>
          </div>
          <div className="flex justify-between border-t border-[var(--color-border)] pt-1.5 mt-1.5">
            <span className="text-[var(--color-muted)]">Est. net P&L</span>
            <span className={`font-semibold ${estPnl >= 0 ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
              {estPnl >= 0 ? "+" : ""}{fmtUsdt(estPnl, 2)}
            </span>
          </div>
        </div>

        <p className="text-[10px] text-[var(--color-muted)] mb-4 leading-relaxed">
          A market sell order will execute immediately. The remaining {100 - pct}% of the position stays open.
        </p>

        <div className="flex gap-3">
          <Btn className="flex-1 justify-center" onClick={onClose}>Cancel</Btn>
          <Btn primary className="flex-1 justify-center" onClick={execute} loading={busy}>
            <Scissors size={13} />
            Close {pct}%
          </Btn>
        </div>
      </>
    </Dialog>
  );
}

// ─── Metric Card ─────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  trend,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  trend?: "up" | "down" | "neutral";
  loading?: boolean;
}) {
  const trendColor =
    trend === "up" ? "text-[var(--color-success)]" :
    trend === "down" ? "text-[var(--color-danger)]" : "text-white";

  return (
    <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl px-5 py-4 card-hover">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">{label}</span>
        <div className="w-7 h-7 rounded-lg bg-[var(--color-panel-2)] flex items-center justify-center">
          <Icon size={14} className="text-[var(--color-muted)]" />
        </div>
      </div>
      {loading ? (
        <>
          <Skeleton className="h-7 w-32 mb-1.5" />
          <Skeleton className="h-3.5 w-20" />
        </>
      ) : (
        <>
          <div className={`text-2xl font-bold tracking-tight ${trendColor}`}>{value}</div>
          {sub && <div className="text-xs text-[var(--color-muted)] mt-1">{sub}</div>}
        </>
      )}
    </div>
  );
}

// ─── Bot Row ─────────────────────────────────────────────────────────────────

function BotRow({
  bot: b,
  onChange,
}: {
  bot: BotListItem;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const neg = b.totalProfit < 0;
  const maxSt = b.maxActiveSmartTradesEnabled ? (b.maxActiveSmartTrades ?? 0) : null;
  const stLabel = maxSt != null ? `${b.activeSmartTrades}/${maxSt}` : String(b.activeSmartTrades);
  const isActive = b.status === "active";

  const toggle = async () => {
    /*
     * BOT-034: starting a bot arms real order flow, and it was the one
     * money-touching action with no confirmation — delete, close and partial
     * close all had one. Stopping needs no confirmation: it is the safe
     * direction.
     */
    if (!isActive) {
      const size = `${b.maxInvestmentLabel} per entry`;
      const guards = [
        b.stopLossEnabled ? `stop loss ${b.stopLossPct ?? "?"}%` : "NO STOP LOSS",
        b.takeProfitEnabled ? `take profit ${b.takeProfitPct ?? "?"}%` : "no take profit",
        b.exitEnabled ? "exits enabled" : "EXITS DISABLED",
      ].join(", ");
      const warning =
        `Start "${b.name}"?\n\n` +
        `Pairs: ${b.pairs.join(", ")}\n` +
        `Size: ${size}\n` +
        `Guards: ${guards}\n\n` +
        "Once started, an incoming webhook places a real Binance Spot order " +
        "unless the server is in DRY RUN.";
      if (!confirm(warning)) return;
    }
    setBusy(true);
    try {
      await api.bots.toggle(b.id);
      toast(`Bot ${isActive ? "stopped" : "started"}`, "success");
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    // F5: inform user that trade history is preserved
    if (!confirm(
      `Delete "${b.name}"?\n\nHistorical trade data will be preserved in your Trade History. ` +
      "A bot with active trades or orders still being reconciled cannot be deleted: close them first."
    )) return;
    setBusy(true);
    try {
      await api.bots.remove(b.id);
      toast("Bot deleted — trade history preserved", "success");
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-panel-2)]/40 transition-colors group">
      <td className="p-3 pl-4">
        <div className="flex items-center gap-2.5">
          <StatusDot active={isActive} />
          <div>
            <div className="font-medium text-sm text-white">{b.name}</div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {b.pairs.slice(0, 3).map((p) => (
                <span key={p} className="text-[10px] px-1.5 py-0.5 bg-[var(--color-panel-3)] border border-[var(--color-border)] rounded text-[var(--color-muted)] font-medium">
                  {formatPair(p)}
                </span>
              ))}
              {b.pairs.length > 3 && (
                <span className="text-[10px] text-[var(--color-muted)]">+{b.pairs.length - 3}</span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="p-3 text-sm text-[var(--color-muted)]">
        {b.exchangeAccount?.name ?? <span className="text-[var(--color-warning)] text-xs">No account</span>}
      </td>
      <td className="p-3 text-sm text-[var(--color-text)]">{b.maxInvestmentLabel}</td>
      <td className={`p-3 text-sm font-medium ${neg ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
        <span className="flex items-center gap-1">
          {neg ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}
          {fmtUsdt(b.totalProfit)}
        </span>
      </td>
      <td className="p-3 text-sm">
        <span className="text-[var(--color-accent)] font-medium">{stLabel}</span>
      </td>
      <td className="p-3">
        <span className="text-sm text-[var(--color-text)]">{b.signalCount}</span>
      </td>
      <td className="p-3">
        <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
          <Clock size={11} />
          {fmtDuration(b.tradingSince)}
        </span>
      </td>
      <td className="p-3">
        <Badge variant={isActive ? "success" : "muted"}>{isActive ? "Active" : "Stopped"}</Badge>
      </td>
      <td className="p-3 pr-4">
        <div className="flex items-center gap-1.5 opacity-70 group-hover:opacity-100 transition-opacity">
          <Link to={`/edit/${b.id}`}>
            <Btn small className="gap-1"><Pencil size={11} />Edit</Btn>
          </Link>
          <Btn small onClick={toggle} disabled={busy} className={isActive ? "text-amber-400 border-amber-400/30 bg-amber-400/10 hover:bg-amber-400/20" : "text-[var(--color-success)] border-[var(--color-success)]/30 bg-[var(--color-success-dim)] hover:brightness-110"}>
            {isActive ? <Square size={11} /> : <Play size={11} />}
            {isActive ? "Stop" : "Start"}
          </Btn>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-dim)] transition-all disabled:opacity-40"
            title="Delete bot (history preserved)"
          >
            <X size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Trade Row ───────────────────────────────────────────────────────────────

function TradeRow({
  trade: t,
  tab,
  onClose,
}: {
  trade: SmartTrade;
  tab: string;
  onClose: () => void;
}) {
  const [busy, setBusy]                     = useState(false);
  const [showPartial, setShowPartial]       = useState(false);

  /*
   * Feature B: Archive replaced Delete. A delete erased realised P&L from the
   * totals and the daily-loss window; Archive only hides the row. The server
   * refuses a trade that is not fully resolved and says why.
   */
  const handleArchive = async () => {
    if (!confirm(
      `Archive this ${formatPair(t.pair)} trade?\n\nIt will be hidden from History. ` +
      "Its P&L and daily-loss history are kept. You can restore it."
    )) return;
    setBusy(true);
    try {
      await api.trades.archive(t.id);
      toast("Trade archived. Its P&L is still counted.", "success");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Archive failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    setBusy(true);
    try {
      await api.trades.restore(t.id);
      toast("Trade restored to History", "success");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Restore failed", "error");
    } finally {
      setBusy(false);
    }
  };
  const pair      = formatPair(t.pair);
  const base      = pair.split("/")[0];
  const date      = tab === "active" ? t.createdAt : (t.closedAt ?? t.createdAt);
  const neg       = t.pnlUsdt < 0;
  const accountName = t.bot.exchangeAccount?.name ?? "No account";
  const pnlBarW   = Math.min(100, Math.abs(t.pnlPct));

  const closedReasonBadge: Record<string, React.ReactElement> = {
    signal_exit:     <Badge variant="accent">Signal Exit</Badge>,
    take_profit:     <Badge variant="success">Take Profit</Badge>,
    stop_loss:       <Badge variant="danger">Stop Loss</Badge>,
    closed_manually: <Badge variant="warning">Closed Manually</Badge>,
    partial_close:   <Badge variant="muted">Partial Close</Badge>,
  };

  const handleClose = async () => {
    if (!confirm("Close this trade at market price?")) return;
    setBusy(true);
    try {
      const result = await api.trades.close(t.id);
      const warning = (result.detail as { warning?: string } | undefined)?.warning;
      if (result.status === "pending") {
        toast("Close submitted; the outcome is not known yet and is being reconciled.", "info");
      } else if (result.status === "ignored_duplicate") {
        // Only when an earlier exit already closed the position. A recent exit
        // that left it open is refused (409 exit_recent) and shown as an error.
        toast("No new order was placed: an earlier exit already closed this position.", "info");
      } else if (warning) {
        toast(warning, "info");
      } else {
        toast("Trade closed", "success");
      }
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Close failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const totalPartialPnl = (t.partialCloses ?? []).reduce((s, p) => s + p.pnlUsdt, 0);
  const hasPartials = (t.partialCloses ?? []).length > 0;

  return (
    <>
      <tr className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-panel-2)]/40 transition-colors">
        {/* Pair */}
        <td className="p-3 pl-4">
          <div className="font-medium text-sm text-white">{pair}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[10px] text-[var(--color-muted)]">{accountName}</span>
            <LongBadge />
          </div>
        </td>
        {/* Date */}
        <td className="p-3 text-xs text-[var(--color-muted)]">
          <div>{new Date(date).toLocaleDateString()}</div>
          <div>{new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        </td>
        {/* Volume */}
        <td className="p-3">
          <div className="text-sm text-white">{t.quantity.toFixed(4)} {base}</div>
          <div className="text-xs text-[var(--color-muted)]">{t.quoteSpent.toFixed(2)} USDT</div>
          {hasPartials && (
            <div className="text-[10px] text-[var(--color-accent)] mt-0.5">
              {t.partialCloses!.length} partial close{t.partialCloses!.length > 1 ? "s" : ""}
            </div>
          )}
        </td>
        {/* Price */}
        <td className="p-3">
          {tab === "active" ? (
            <div className="text-xs">
              <div className="text-[var(--color-muted)]">
                Entry <span className="text-white font-medium">${t.entryPrice?.toFixed(4) ?? "—"}</span>
              </div>
              <div className="text-[var(--color-muted)]">
                Now <span className={`font-medium ${neg ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
                  ${t.currentPrice?.toFixed(4) ?? "—"}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {closedReasonBadge[t.closedReason ?? ""] ?? <Badge variant="muted">{t.status}</Badge>}
              {t.archivedAt && <Badge variant="muted">Archived</Badge>}
            </div>
          )}
        </td>
        {/* P&L (net after fees) */}
        <td className="p-3">
          <div className={`text-sm font-semibold ${neg ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
            {neg ? "−" : "+"}{Math.abs(t.pnlUsdt).toFixed(4)} USDT
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <div className="w-20 h-1 bg-[var(--color-panel-3)] rounded overflow-hidden">
              <div
                className={`h-full rounded bar-fill ${neg ? "bg-[var(--color-danger)]" : "bg-[var(--color-success)]"}`}
                style={{ width: `${pnlBarW}%` }}
              />
            </div>
            <span className={`text-[10px] font-medium ${neg ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
              {neg ? "" : "+"}{t.pnlPct.toFixed(2)}%
            </span>
          </div>
          {/* F3: fee note */}
          <div className="text-[9px] text-[var(--color-muted)] mt-0.5">net after fees</div>
          {hasPartials && totalPartialPnl !== 0 && (
            <div className={`text-[9px] mt-0.5 ${totalPartialPnl >= 0 ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
              partial: {totalPartialPnl >= 0 ? "+" : ""}{totalPartialPnl.toFixed(2)} USDT
            </div>
          )}
        </td>
        {/* Bot / Age */}
        <td className="p-3">
          <div className="text-xs text-white">{t.bot.name}</div>
          <div className="flex items-center gap-1 text-[10px] text-[var(--color-muted)] mt-0.5">
            <Clock size={10} />
            {fmtDuration(t.createdAt)}
          </div>
        </td>
        {/* Actions */}
        <td className="p-3 pr-4 text-right">
          {tab === "active" && t.source === "manual" ? (
            /*
             * U3: a manual position was opened from Trading Scene and is
             * closed from its Trade panel (SELL), which keeps the manual
             * ledger and its TP/SL correct. The Bot refuses Close / Partial
             * for it, so they are not offered.
             */
            <span
              className="text-[10px] text-[var(--color-muted)]"
              title="Opened from Trading Scene. Close it from the Trading Scene Trade panel (SELL)."
            >
              Managed in Trading Scene
            </span>
          ) : tab === "active" ? (
            <div className="flex items-center gap-1.5 justify-end">
              {/* F4: Partial close */}
              <Btn
                small
                onClick={() => setShowPartial(true)}
                disabled={busy}
                className="text-[var(--color-accent)] border-[var(--color-accent)]/30 bg-[var(--color-accent-dim)] hover:brightness-110"
              >
                <Scissors size={10} />
                Partial
              </Btn>
              <Btn small onClick={handleClose} disabled={busy} danger>
                {busy ? "…" : "Close"}
              </Btn>
            </div>
          ) : t.archivedAt ? (
            <button
              type="button"
              onClick={handleRestore}
              disabled={busy}
              className="p-1.5 rounded text-[var(--color-muted)] hover:text-white hover:bg-[var(--color-panel-3)] transition-all disabled:opacity-40"
              title="Restore to History"
              aria-label={`Restore ${pair} trade to History`}
            >
              <ArchiveRestore size={13} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleArchive}
              disabled={busy || Boolean(t.archiveBlocked)}
              className="p-1.5 rounded text-[var(--color-muted)] hover:text-white hover:bg-[var(--color-panel-3)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              title={t.archiveBlocked
                ? `Cannot archive yet: ${t.archiveBlocked.message}`
                : "Archive (hide from History; P&L is kept)"}
              aria-label={`Archive ${pair} trade`}
            >
              <Archive size={13} />
            </button>
          )}
        </td>
      </tr>

      {/* F4: Partial close modal */}
      {showPartial && (
        <PartialCloseModal
          trade={t}
          onDone={() => { setShowPartial(false); onClose(); }}
          onClose={() => setShowPartial(false)}
        />
      )}
    </>
  );
}

// ─── Table skeleton ───────────────────────────────────────────────────────────

function TableSkeleton({ cols, rows = 3 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-[var(--color-border-subtle)]">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="p-3">
              <Skeleton className="h-5" style={{ width: `${60 + Math.random() * 30}%` } as React.CSSProperties} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ${
        active
          ? "bg-[var(--color-panel-3)] text-white"
          : "text-[var(--color-muted)] hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-dim)]"
          : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[#3a4d66] hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/**
 * The trading-mode badge (BOT-034).
 *
 * Four states, and `UNKNOWN` is deliberately one of them: if the status call
 * fails, saying so is correct, whereas defaulting to LIVE would alarm and
 * defaulting to DRY RUN would reassure — both without evidence.
 */
/**
 * Which Binance an order would actually reach.
 *
 * Two answers, not one: `BINANCE_TESTNET` is the process-wide default, and each
 * stored exchange account carries its OWN flag which overrides it for that
 * account's bots. An operator reading only the first could believe every order
 * is on testnet while an account sends some to mainnet — so a disagreement is
 * shown as its own state rather than folded into either.
 */
function ExchangeBadge({ exchange }: {
  exchange: {
    envTestnet: boolean;
    accounts: { id: string; name: string; testnet: boolean }[];
    mixed: boolean;
    note: string;
  } | null;
}) {
  if (!exchange) return null;
  const label = exchange.mixed ? "MIXED NET" : exchange.envTestnet ? "TESTNET" : "MAINNET";
  const style = exchange.mixed
    ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : exchange.envTestnet
      ? "bg-[var(--color-panel-2)] text-[var(--color-muted)] border-[var(--color-border)]"
      : "bg-[var(--color-danger-dim)] text-[var(--color-danger)] border-[var(--color-danger)]/40";
  const detail = exchange.accounts.length === 0
    ? exchange.note
    : `${exchange.note} Accounts: ${
        exchange.accounts.map((a) => `${a.name} (${a.testnet ? "testnet" : "mainnet"})`).join(", ")}`;
  return (
    <span
      title={detail}
      aria-label={detail}
      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium ${style}`}
    >
      {label}
    </span>
  );
}

function OpsBadge({ mode, halted, reason }: {
  mode: "DRY_RUN" | "HALTED" | "LIVE" | "UNKNOWN";
  /**
   * Read from `risk.tradingHalted`, not from `mode`: DRY_RUN outranks HALTED in
   * `mode`, and production runs DRY_RUN, so a halt was invisible (0.4).
   */
  halted: boolean;
  reason: string | null;
}) {
  const styles: Record<typeof mode, string> = {
    DRY_RUN: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    HALTED: "bg-[var(--color-danger-dim)] text-[var(--color-danger)] border-[var(--color-danger)]/40",
    LIVE: "bg-[var(--color-success-dim)] text-[var(--color-success)] border-[var(--color-success)]/40",
    UNKNOWN: "bg-[var(--color-panel-2)] text-[var(--color-muted)] border-[var(--color-border)]",
  };
  const label: Record<typeof mode, string> = {
    DRY_RUN: "DRY RUN",
    HALTED: "HALTED",
    LIVE: "LIVE",
    UNKNOWN: "MODE UNKNOWN",
  };
  const title =
    mode === "HALTED" ? `Trading is halted${reason ? `: ${reason}` : ""}`
    : mode === "DRY_RUN" ? "Orders are simulated — nothing reaches the exchange"
    : mode === "LIVE" ? "A webhook will place a REAL Binance Spot order"
    : "Could not read the trading mode from the server";
  const haltTitle = `Trading is halted${reason ? `: ${reason}` : ""}. ${HALT_POLICY}`;
  return (
    <>
      <span
        title={title}
        aria-label={title}
        className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium ${styles[mode]}`}
      >
        <Zap size={11} aria-hidden="true" />{label[mode]}
      </span>
      {/* A dry-run Bot can be halted too: shown alongside DRY RUN, never hidden by it. */}
      {halted && mode !== "HALTED" && (
        <span
          title={haltTitle}
          aria-label={haltTitle}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium ${styles.HALTED}`}
        >
          <ShieldAlert size={11} aria-hidden="true" />HALTED
        </span>
      )}
    </>
  );
}

/** OD-3: the entries pause pill, shown beside (never instead of) the mode and the halt. */
function EntriesPausedPill({ entries }: { entries: EntriesStatus }) {
  const title = `New entries are paused${entries.reason ? `: ${entries.reason}` : ""}. ` +
    ENTRIES_PAUSE_POLICY +
    (entries.workingEntryLimits > 0
      ? ` ${entries.workingEntryLimits} LIMIT BUY(s) still working at the exchange.` : "");
  return (
    <span
      title={title}
      aria-label={title}
      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium bg-amber-500/15 text-amber-400 border-amber-500/30"
    >
      <PauseCircle size={11} aria-hidden="true" />ENTRIES PAUSED
    </span>
  );
}

export default function Dashboard() {
  const [botFilter, setBotFilter]   = useState<BotFilter>("all");
  const [bots, setBots]             = useState<BotListItem[]>([]);
  const [tradeTab, setTradeTab]     = useState<"active" | "history">("active");
  const [stats, setStats]           = useState<Stats | null>(null);
  const [trades, setTrades]         = useState<SmartTrade[]>([]);
  // Feature B: archived trades are hidden from the History list by default,
  // but every History total is computed from ALL closed trades.
  const [showArchived, setShowArchived] = useState(false);
  const [accounts, setAccounts]     = useState<ExchangeAccount[]>([]);
  const [opsMode, setOpsMode]       = useState<"DRY_RUN" | "HALTED" | "LIVE" | "UNKNOWN">("UNKNOWN");
  const [haltReason, setHaltReason] = useState<string | null>(null);
  // The halt itself, independent of DRY_RUN (finding 0.4). Null = unknown.
  const [halted, setHalted]         = useState<boolean | null>(null);
  const [exchange, setExchange] = useState<{
    envTestnet: boolean;
    accounts: { id: string; name: string; testnet: boolean }[];
    mixed: boolean;
    note: string;
  } | null>(null);
  /*
   * V1-UX-2: what a stop loss actually IS on this installation. The backend
   * has always computed the honest sentence — with `EXCHANGE_STOPS_ENABLED`
   * off there is no resting order at Binance, so protection is a 30-second
   * in-process poll and stops entirely while this process is down — and the
   * frontend has always TYPED it. Nothing rendered it, while the bot form
   * requires a stop for any position at or above half the balance.
   */
  const [protectiveOrders, setProtectiveOrders] = useState<{
    enabled: boolean;
    status: string;
    note: string;
  } | null>(null);
  const [haltBusy, setHaltBusy]     = useState(false);
  // OD-3: null = unknown, or an older Bot without the switch (control hidden).
  const [entries, setEntries]       = useState<EntriesStatus | null>(null);
  const [entriesBusy, setEntriesBusy] = useState(false);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /** BOT-011: halt or resume all trading, with the confirmation the API requires. */
  const toggleHalt = async () => {
    if (halted) {
      if (!confirm(
        "Resume trading?\n\nThis re-arms the automation: signals, TradingView exits and " +
        "the TP/SL monitors. If the halt was latched by the daily-loss limit, the API " +
        "will refuse until that limit is clear."
      )) return;
      setHaltBusy(true);
      try {
        await api.ops.resume();
        toast("Trading resumed", "success");
        await load(true);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Could not resume", "error");
      } finally {
        setHaltBusy(false);
      }
      return;
    }
    const reason = prompt(
      "Halt the Bot's automation.\n\n" +
      "Signals and new entries are refused until you resume. " + HALT_POLICY + "\n\n" +
      "Give a reason so the halt is explicable later:"
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast("A reason of at least 3 characters is required", "error");
      return;
    }
    setHaltBusy(true);
    try {
      const result = await api.ops.halt(reason.trim());
      toast(
        result.alreadyHalted
          ? `Already halted${result.haltedBy ? ` (${result.haltedBy})` : ""}; the existing halt was kept`
          : "Trading halted",
        result.alreadyHalted ? "info" : "success"
      );
      await load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not halt", "error");
    } finally {
      setHaltBusy(false);
    }
  };

  /** OD-3: pause or resume NEW entries. Independent of the halt. */
  const toggleEntries = async () => {
    if (!entries) return;
    if (entries.paused) {
      if (!confirm(
        "Resume new entries?\n\nSignals and manual BUYs will be placed again. The halt, if any, " +
        "is not changed by this."
      )) return;
      setEntriesBusy(true);
      try {
        await api.ops.entries({ paused: false });
        toast("New entries resumed", "success");
        await load(true);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Could not resume entries", "error");
      } finally {
        setEntriesBusy(false);
      }
      return;
    }
    const reason = prompt(
      "Pause NEW entries.\n\n" + ENTRIES_PAUSE_POLICY + "\n\n" +
      "Give a reason so the pause is explicable later:"
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast("A reason of at least 3 characters is required", "error");
      return;
    }
    // Explicit opt-in: a pause never changes resting orders unless asked to.
    const cancelWorkingEntries = entries.workingEntryLimits > 0 && confirm(
      `${entries.workingEntryLimits} manual LIMIT BUY(s) are still working at the exchange, and a ` +
      "pause does not stop them.\n\nAlso cancel them now? (OK = cancel them, Cancel = leave them working)"
    );
    setEntriesBusy(true);
    try {
      const result = await api.ops.entries({ paused: true, reason: reason.trim(), cancelWorkingEntries });
      const unconfirmed = (result.canceledEntries ?? [])
        .filter((c) => c.outcome === "unknown" || c.outcome === "failed");
      toast(
        !result.changed ? "New entries were already paused; the existing pause was kept"
          : unconfirmed.length > 0
            ? `New entries paused. ${unconfirmed.length} LIMIT BUY cancel(s) NOT confirmed — check them`
            : "New entries paused",
        unconfirmed.length > 0 ? "error" : result.changed ? "success" : "info"
      );
      await load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not pause entries", "error");
    } finally {
      setEntriesBusy(false);
    }
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [botList, s, t, accs, ops] = await Promise.all([
        api.bots.list(),
        api.stats(),
        // History loads archived trades too, so its summary stays truthful;
        // the list hides them unless "Show archived" is on.
        api.trades.list(tradeTab, undefined, tradeTab === "history" ? "include" : undefined),
        api.exchange.list(),
        // A failure here must not blank the dashboard — the badge falls back to
        // UNKNOWN, which is an honest answer, rather than to LIVE or DRY RUN.
        api.ops.status().catch(() => null),
      ]);
      setBots(botList);
      setStats(s);
      setTrades(t);
      setAccounts(accs);
      setOpsMode(ops ? ops.mode : "UNKNOWN");
      setHaltReason(ops?.risk.haltedReason ?? null);
      setHalted(ops?.risk.tradingHalted ?? null);
      setEntries(ops?.entries ?? null);
      setExchange(ops?.exchange ?? null);
      setProtectiveOrders(ops?.protectiveOrders ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tradeTab]);

  useEffect(() => {
    void load(false);
    return startDashboardPolling(() => load(true));
  }, [load]);

  const filteredBots = bots.filter((b) =>
    botFilter === "active" ? b.status === "active" :
    botFilter === "stopped" ? b.status !== "active" : true
  );

  const archivedCount = tradeTab === "history" ? trades.filter((t) => t.archivedAt).length : 0;
  const visibleTrades = tradeTab === "history" && !showArchived
    ? trades.filter((t) => !t.archivedAt) : trades;

  const activeBots  = bots.filter((b) => b.status === "active").length;
  const stoppedBots = bots.filter((b) => b.status !== "active").length;
  const upnl  = stats?.upnl  ?? 0;
  const today = stats?.todayPnl ?? 0;
  const primaryAccount = accounts[0] ?? null;

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-xs text-[var(--color-muted)] mt-0.5">Live trading overview</p>
        </div>
        <div className="flex items-center gap-3">
          {/*
            BOT-034: three states, and none of them is a guess. DRY RUN means
            nothing reaches the exchange; HALTED means orders are refused;
            LIVE means a webhook places a real order. Previously only DRY RUN
            was shown, and a halt did not exist to be shown.
          */}
          <OpsBadge mode={opsMode} halted={halted === true} reason={haltReason} />
          {entries?.paused && <EntriesPausedPill entries={entries} />}
          <ExchangeBadge exchange={exchange} />
          {/*
            Finding 0.4: shown in DRY_RUN too. A halt gates a dry run exactly as
            it gates a live one, and production runs DRY_RUN. Hidden only while
            the halt state is unknown.
          */}
          {halted !== null && (
            <Btn
              small
              onClick={toggleHalt}
              disabled={haltBusy}
              className={
                halted
                  ? "text-[var(--color-success)] border-[var(--color-success)]/30 bg-[var(--color-success-dim)]"
                  : "text-[var(--color-danger)] border-[var(--color-danger)]/30 bg-[var(--color-danger-dim)]"
              }
            >
              {halted ? "Resume trading" : "Halt trading"}
            </Btn>
          )}
          {/* OD-3: shown only when the Bot reports the switch (an older Bot has none). */}
          {entries && (
            <Btn
              small
              onClick={toggleEntries}
              disabled={entriesBusy}
              className={
                entries.paused
                  ? "text-[var(--color-success)] border-[var(--color-success)]/30 bg-[var(--color-success-dim)]"
                  : "text-amber-400 border-amber-500/30 bg-amber-500/15"
              }
            >
              {entries.paused ? "Resume new entries" : "Pause new entries"}
            </Btn>
          )}
          <button
            type="button"
            onClick={() => load(false)}
            disabled={refreshing}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-muted)] hover:text-white hover:border-[#3a4d66] transition-all disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
          <Link to="/create">
            <Btn primary><Zap size={13} />Create Bot</Btn>
          </Link>
        </div>
      </div>

      {/* Error banner */}
      {loadError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-[var(--color-danger)] text-sm">
          <X size={15} className="flex-shrink-0" />
          {loadError}
        </div>
      )}

      {/* The halt, stated where it cannot be missed, whatever the dry-run setting (0.4) */}
      {halted && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-xs text-[var(--color-danger)]">
          <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <span className="font-semibold">Bot halted{haltReason ? `: ${haltReason}` : ""}. </span>
            {HALT_POLICY}
          </span>
        </div>
      )}

      {/* OD-3: the entries pause, stated where it cannot be missed; independent of the halt */}
      {entries?.paused && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
          <PauseCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <span className="font-semibold">New entries paused{entries.reason ? `: ${entries.reason}` : ""}. </span>
            {ENTRIES_PAUSE_POLICY}
            {entries.workingEntryLimits > 0 &&
              ` ${entries.workingEntryLimits} manual LIMIT BUY(s) are still working at the exchange.`}
          </span>
        </div>
      )}

      {/* What protects an open position, stated rather than implied (V1-UX-2) */}
      {protectiveOrders && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--color-panel-2)] border border-[var(--color-border)] text-xs text-[var(--color-muted)]">
          <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <span className="text-white font-medium">Stop loss and take profit: </span>
            {protectiveOrders.note}
          </span>
        </div>
      )}

      {/* Metric cards — 5 columns when account connected, 4 otherwise */}
      <div className={`grid gap-4 ${primaryAccount ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-2 lg:grid-cols-4"}`}>
        {/* F1: live balance widget — only when an exchange account is connected */}
        {primaryAccount && <BalanceWidget account={primaryAccount} />}

        <MetricCard
          label="Unrealized PnL"
          value={loading ? "—" : fmtUsdt(upnl)}
          sub={loading ? "" : `${stats?.activeCount ?? 0} open position${stats?.activeCount !== 1 ? "s" : ""}`}
          icon={upnl >= 0 ? TrendingUp : TrendingDown}
          trend={upnl > 0 ? "up" : upnl < 0 ? "down" : "neutral"}
          loading={loading}
        />
        <MetricCard
          label="Today's PnL"
          value={loading ? "—" : fmtUsdt(today)}
          sub={loading ? "" : `${stats?.closedCount ?? 0} trades closed`}
          icon={today >= 0 ? TrendingUp : TrendingDown}
          trend={today > 0 ? "up" : today < 0 ? "down" : "neutral"}
          loading={loading}
        />
        <MetricCard
          label="Value Locked"
          value={loading ? "—" : fmtUsdt(stats?.locked ?? 0, 2)}
          sub={loading ? "" : `${stats?.activeCount ?? 0} active trades`}
          icon={DollarSign}
          loading={loading}
        />
        <MetricCard
          label="Bots"
          value={loading ? "—" : String(stats?.botCount ?? 0)}
          sub={loading ? "" : `${stats?.activeBotCount ?? 0} running · ${stats?.stoppedBotCount ?? 0} stopped`}
          icon={Bot}
          loading={loading}
        />
      </div>

      {/* Bots table */}
      <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <BarChart3 size={15} className="text-[var(--color-muted)]" />
            <h2 className="font-semibold text-sm text-white">Your Bots</h2>
            <span className="text-xs text-[var(--color-muted)]">({bots.length})</span>
          </div>
          <div className="flex items-center gap-2">
            <FilterChip active={botFilter === "all"}     onClick={() => setBotFilter("all")}     label={`All (${bots.length})`} />
            <FilterChip active={botFilter === "active"}  onClick={() => setBotFilter("active")}  label={`Active (${activeBots})`} />
            <FilterChip active={botFilter === "stopped"} onClick={() => setBotFilter("stopped")} label={`Stopped (${stoppedBots})`} />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wider border-b border-[var(--color-border)]">
                <th className="p-3 pl-4 text-left">Bot</th>
                <th className="p-3 text-left">Exchange</th>
                <th className="p-3 text-left">Investment</th>
                <th className="p-3 text-left">Total Profit</th>
                <th className="p-3 text-left">Trades</th>
                <th className="p-3 text-left">Signals</th>
                <th className="p-3 text-left">Age</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 pr-4 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton cols={9} />
              ) : filteredBots.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <Bot size={36} className="text-[var(--color-border)]" />
                      <p className="text-[var(--color-muted)] text-sm">No bots yet.</p>
                      <Link to="/create">
                        <Btn primary small><Zap size={11} />Create Signal Bot</Btn>
                      </Link>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredBots.map((b) => (
                  <BotRow key={b.id} bot={b} onChange={() => load(false)} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* SmartTrades table */}
      <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <Layers size={15} className="text-[var(--color-muted)]" />
            <h2 className="font-semibold text-sm text-white">SmartTrades</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <TabBtn
              active={tradeTab === "active"}
              onClick={() => setTradeTab("active")}
              label={`Active (${stats?.activeCount ?? 0})`}
            />
            <TabBtn
              active={tradeTab === "history"}
              onClick={() => setTradeTab("history")}
              label={`History (${stats?.closedCount ?? 0})`}
            />
          </div>
        </div>

        {/* History stats bar — shown when viewing closed trades. Computed from
            ALL closed trades, archived included: Archive never changes P&L. */}
        {tradeTab === "history" && !loading && (
          <>
            <HistoryStatsBar trades={trades} />
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-[var(--color-border)] text-[11px] text-[var(--color-muted)]">
              <span>
                Totals include archived trades{archivedCount > 0 ? ` (${archivedCount} archived)` : ""}.
              </span>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                Show archived
              </label>
            </div>
          </>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wider border-b border-[var(--color-border)]">
                <th className="p-3 pl-4 text-left">Pair</th>
                <th className="p-3 text-left">Date</th>
                <th className="p-3 text-left">Volume</th>
                <th className="p-3 text-left">Price</th>
                <th className="p-3 text-left">Net P&L</th>
                <th className="p-3 text-left">Bot / Age</th>
                <th className="p-3 pr-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableSkeleton cols={7} />
              ) : visibleTrades.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Layers size={32} className="text-[var(--color-border)]" />
                      <p className="text-[var(--color-muted)] text-sm">
                        No {tradeTab} trades{archivedCount > 0 && !showArchived ? " (archived trades are hidden)" : ""}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                visibleTrades.map((t) => (
                  <TradeRow key={t.id} trade={t} tab={tradeTab} onClose={() => load(false)} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && visibleTrades.length > 0 && (
          <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
            <RefreshCw size={10} className={refreshing ? "animate-spin" : ""} />
            PnL refreshes every 30 seconds · Net of 0.1% fees
            <ChevronRight size={10} />
            {visibleTrades.length} trade{visibleTrades.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
