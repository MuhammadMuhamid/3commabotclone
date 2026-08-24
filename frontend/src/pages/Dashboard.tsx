import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  TrendingUp, TrendingDown, Layers, DollarSign, BarChart3,
  Bot, ChevronRight, ArrowUpRight, ArrowDownRight, Clock,
  Zap, X, Play, Square, Pencil, RefreshCw, Wallet, Scissors, Trash2,
} from "lucide-react";
import {
  api, formatPair, type BotListItem, type SmartTrade, type Stats, type ExchangeAccount,
} from "../api";
import {
  Btn, Badge, StatusDot, LongBadge, Skeleton, toast,
} from "../components/ui";

type BotFilter = "all" | "active" | "stopped";

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
      await api.trades.partialClose(trade.id, pct);
      toast(`Partial close (${pct}%) executed`, "success");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Partial close failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-2xl w-full max-w-sm p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <Scissors size={15} className="text-[var(--color-accent)]" />
            <h3 className="text-sm font-semibold text-white">Partial Close</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-[var(--color-muted)] hover:text-white transition-colors"
          >
            <X size={15} />
          </button>
        </div>

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
      </div>
    </div>
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
    if (!confirm(`Delete "${b.name}"?\n\nHistorical trade data will be preserved in your Trade History.`)) return;
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

  const handleDelete = async () => {
    if (!confirm(`Delete this ${formatPair(t.pair)} trade from history?\nThis cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.trades.remove(t.id);
      toast("Trade deleted from history", "success");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
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
      await api.trades.close(t.id);
      toast("Trade closed", "success");
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
            closedReasonBadge[t.closedReason ?? ""] ?? <Badge variant="muted">{t.status}</Badge>
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
          {tab === "active" ? (
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
          ) : (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-dim)] transition-all disabled:opacity-40"
              title="Delete from history"
            >
              <Trash2 size={13} />
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

export default function Dashboard() {
  const [botFilter, setBotFilter]   = useState<BotFilter>("all");
  const [bots, setBots]             = useState<BotListItem[]>([]);
  const [tradeTab, setTradeTab]     = useState<"active" | "history">("active");
  const [stats, setStats]           = useState<Stats | null>(null);
  const [trades, setTrades]         = useState<SmartTrade[]>([]);
  const [accounts, setAccounts]     = useState<ExchangeAccount[]>([]);
  const [dryRun, setDryRun]         = useState(false);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [botList, s, t, c, accs] = await Promise.all([
        api.bots.list(),
        api.stats(),
        api.trades.list(tradeTab),
        api.config(),
        api.exchange.list(),
      ]);
      setBots(botList);
      setStats(s);
      setTrades(t);
      setDryRun(c.dryRun);
      setAccounts(accs);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load(false);
    const id = setInterval(() => load(true), 15000);
    return () => clearInterval(id);
  }, [tradeTab]);

  const filteredBots = bots.filter((b) =>
    botFilter === "active" ? b.status === "active" :
    botFilter === "stopped" ? b.status !== "active" : true
  );

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
          {dryRun && (
            <span className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 font-medium">
              <Zap size={11} />DRY RUN
            </span>
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

        {/* History stats bar — shown when viewing closed trades */}
        {tradeTab === "history" && !loading && (
          <HistoryStatsBar trades={trades} />
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
              ) : trades.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Layers size={32} className="text-[var(--color-border)]" />
                      <p className="text-[var(--color-muted)] text-sm">No {tradeTab} trades</p>
                    </div>
                  </td>
                </tr>
              ) : (
                trades.map((t) => (
                  <TradeRow key={t.id} trade={t} tab={tradeTab} onClose={() => load(false)} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && trades.length > 0 && (
          <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
            <RefreshCw size={10} className={refreshing ? "animate-spin" : ""} />
            PnL refreshes every 30 seconds · Net of 0.1% fees
            <ChevronRight size={10} />
            {trades.length} trade{trades.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
