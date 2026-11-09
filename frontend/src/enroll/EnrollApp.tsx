/**
 * OD-4: the Bot-origin page where an operator enters Binance keys (create /
 * replace an account) or reads a bot's webhook secret once, after starting
 * from Trading Scene. A separate Vite entry (`enroll.html`): no dashboard
 * bundle, no login, no router.
 *
 * Everything that decides WHAT this page does — purpose, network, account,
 * bot — comes from the Bot's stored ticket; the page only displays it. The
 * key fields and the MAINNET confirmation are the dashboard's own
 * (`ExchangeKeyFields`). Nothing is written to browser storage.
 */
import { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldAlert, TestTube, CheckCircle, AlertCircle } from "lucide-react";
import { Btn, CopyField, Spinner } from "../components/ui";
import {
  ExchangeKeyInputs, isMainnetConfirmed, MainnetConfirmationField,
} from "../components/ExchangeKeyFields";
import {
  enrollPost, EnrollError, type EnrollmentMeta, type KeysAnswer, type RevealAnswer,
} from "./enrollApi";

type Phase =
  | { kind: "starting" }
  | { kind: "invalid"; message: string }
  | { kind: "form"; meta: EnrollmentMeta }
  | { kind: "done"; answer: KeysAnswer }
  | { kind: "revealed"; answer: RevealAnswer }
  | { kind: "failed"; message: string; returnUrl: string | null };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-start justify-center p-6">
      <div className="w-full max-w-lg mt-10 bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl p-6">
        {children}
      </div>
    </main>
  );
}

function NetworkBadge({ testnet }: { testnet: boolean }) {
  return testnet ? (
    <span className="inline-flex items-center gap-1 text-xs text-amber-300">
      <TestTube size={12} /> Binance testnet
    </span>
  ) : (
    <span className="text-xs font-semibold text-[var(--color-danger)]">Binance MAINNET (real money)</span>
  );
}

function ReturnButton({ url, label = "Return to Trading Scene" }: { url: string | null; label?: string }) {
  if (!url) return <p className="text-xs text-[var(--color-muted)] mt-4">You can close this tab and return to Trading Scene.</p>;
  return (
    <Btn primary className="w-full justify-center mt-4" onClick={() => location.assign(url)}>
      {label}
    </Btn>
  );
}

export default function EnrollApp({ ticket }: { ticket: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [mainnetConfirmation, setMainnetConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // Review fix 4: one request at a time. A double click used to send two;
  // the loser found the session already spent and showed "Link not valid"
  // although the keys were saved. A ref, not state: it is set synchronously.
  const inFlight = useRef(false);

  useEffect(() => {
    // Exchange the ticket once (StrictMode runs effects twice in development;
    // a second exchange of a single-use ticket would fail).
    if (started.current) return;
    started.current = true;
    const start = ticket
      ? enrollPost<EnrollmentMeta>("/session", { ticket })
      : enrollPost<EnrollmentMeta>("/state", {});
    start
      .then((meta) => setPhase({ kind: "form", meta }))
      .catch((e: unknown) => setPhase({ kind: "invalid", message: e instanceof EnrollError ? e.message
        : "This link is no longer valid. Start again from Trading Scene." }));
  }, [ticket]);

  const submitKeys = async (meta: EnrollmentMeta, e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const answer = await enrollPost<KeysAnswer>("/keys", {
        apiKey, apiSecret, ...(meta.testnet === false ? { mainnetConfirmation } : {}),
      });
      setApiKey("");
      setApiSecret("");
      setPhase({ kind: "done", answer });
      // Nothing to read: go straight back. Warnings stay on screen until acknowledged.
      if (answer.returnUrl && answer.warnings.length === 0) location.assign(answer.returnUrl);
    } catch (err) {
      if (err instanceof EnrollError && err.returnUrl) {
        setPhase({ kind: "failed", message: err.message, returnUrl: err.returnUrl });
      } else if (err instanceof EnrollError && err.status === 401) {
        setPhase({ kind: "invalid", message: err.message });
      } else {
        setError(err instanceof Error ? err.message : "The keys could not be saved.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      setPhase({ kind: "revealed", answer: await enrollPost<RevealAnswer>("/reveal", {}) });
    } catch (err) {
      if (err instanceof EnrollError && err.status === 401) setPhase({ kind: "invalid", message: err.message });
      else setError(err instanceof Error ? err.message : "The secret could not be shown.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (phase.kind === "starting") {
    return <Shell><div className="flex items-center gap-2 text-sm text-[var(--color-muted)]"><Spinner size={16} /> Opening…</div></Shell>;
  }

  if (phase.kind === "invalid" || phase.kind === "failed") {
    return (
      <Shell>
        <div className="flex items-start gap-3">
          <AlertCircle size={18} className="text-[var(--color-danger)] flex-shrink-0 mt-0.5" />
          <div>
            <h1 className="text-sm font-semibold text-white">{phase.kind === "failed" ? "Enrollment failed" : "Link not valid"}</h1>
            <p className="text-sm text-[var(--color-muted)] mt-1">{phase.message}</p>
          </div>
        </div>
        <ReturnButton url={phase.kind === "failed" ? phase.returnUrl : null} />
      </Shell>
    );
  }

  if (phase.kind === "done") {
    const { answer } = phase;
    return (
      <Shell>
        <div className="flex items-start gap-3">
          <CheckCircle size={18} className="text-[var(--color-success)] flex-shrink-0 mt-0.5" />
          <div>
            <h1 className="text-sm font-semibold text-white">Keys saved for “{answer.name}”</h1>
            <p className="text-xs text-[var(--color-muted)] mt-1">
              Key ending …{answer.keyHint} · <NetworkBadge testnet={answer.testnet} />
            </p>
          </div>
        </div>
        {answer.warnings.map((w) => (
          <p key={w} className="mt-4 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">{w}</p>
        ))}
        <ReturnButton url={answer.returnUrl} />
      </Shell>
    );
  }

  if (phase.kind === "revealed") {
    const { answer } = phase;
    const json = JSON.stringify(answer.exitWebhookJson, null, 2);
    return (
      <Shell>
        <h1 className="text-sm font-semibold text-white mb-1">Webhook secret for “{answer.botName}”</h1>
        <p className="text-xs text-amber-300 mb-4">
          Shown once. Copy it into your TradingView exit alert now; this page cannot show it again.
          Anyone holding it can trigger SELL orders for this bot.
        </p>
        <CopyField label="Webhook URL" value={answer.webhookUrl} />
        <CopyField label="Webhook secret" value={answer.webhookSecret} />
        <CopyField label="TradingView exit alert message (JSON)" value={JSON.stringify(answer.exitWebhookJson)} />
        <pre className="text-xs bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg p-3 overflow-x-auto text-[var(--color-text)]">{json}</pre>
        <p className="text-xs text-[var(--color-muted)] mt-2">Direct TradingView BUY alerts are disabled; this payload only exits positions.</p>
        <ReturnButton url={answer.returnUrl} label="Done — return to Trading Scene" />
      </Shell>
    );
  }

  const { meta } = phase;

  if (meta.purpose === "reveal_webhook") {
    return (
      <Shell>
        <h1 className="text-sm font-semibold text-white">Reveal the webhook secret</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1 mb-4">Bot: <strong className="text-white">{meta.bot?.name ?? "unknown"}</strong></p>
        {error && <p className="text-xs text-[var(--color-danger)] mb-3">{error}</p>}
        <Btn primary className="w-full justify-center" loading={busy} onClick={reveal}>Show the secret once</Btn>
      </Shell>
    );
  }

  const testnet = meta.testnet !== false;
  const confirmed = isMainnetConfirmed(testnet, mainnetConfirmation);
  return (
    <Shell>
      <form onSubmit={(e) => submitKeys(meta, e)} autoComplete="off">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound size={16} className="text-[var(--color-accent)]" />
          <h1 className="text-sm font-semibold text-white">
            {meta.purpose === "replace"
              ? `Replace the keys of “${meta.account?.name ?? "account"}”`
              : `Connect “${meta.name ?? "Binance"}”`}
          </h1>
        </div>
        <p className="text-xs text-[var(--color-muted)] mb-4">
          <NetworkBadge testnet={testnet} />
          {meta.purpose === "replace" && meta.account?.keyHint && <> · current key ends …{meta.account.keyHint}</>}
        </p>
        <div className="flex items-start gap-3 px-4 py-3 mb-5 rounded-xl bg-amber-500/10 border border-amber-500/25">
          <ShieldAlert size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300 leading-relaxed">
            Use a key with <strong>read + Spot trading</strong> only. <strong>Disable withdrawals</strong> (a key that
            can withdraw is refused) and restrict it to this server's IP address. The keys are checked with Binance,
            then stored encrypted on this Bot; they are never sent to Trading Scene.
          </p>
        </div>
        <ExchangeKeyInputs apiKey={apiKey} onApiKey={setApiKey} apiSecret={apiSecret} onApiSecret={setApiSecret} />
        {!testnet && <MainnetConfirmationField value={mainnetConfirmation} onChange={setMainnetConfirmation} />}
        {error && <p className="text-xs text-[var(--color-danger)] mb-3">{error}</p>}
        <Btn primary type="submit" loading={busy} disabled={!confirmed || !apiKey || !apiSecret}
          className="w-full justify-center">
          {busy ? "Checking with Binance…" : "Check and save keys"}
        </Btn>
        <p className="text-xs text-[var(--color-muted)] mt-3">
          {meta.attemptsLeft} attempt(s) left. This page expires
          {meta.expiresAt ? ` at ${new Date(meta.expiresAt).toLocaleTimeString()}` : " in a few minutes"}.
        </p>
      </form>
    </Shell>
  );
}
