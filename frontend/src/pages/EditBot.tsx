import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CheckCircle, Webhook } from "lucide-react";
import { api, type SignalBot } from "../api";
import { BotFormFields, buildBotPayload, defaultBotForm, type BotFormState } from "../components/BotFormFields";
import { Btn, CopyField, Section, Spinner, toast } from "../components/ui";

function botToForm(bot: SignalBot): BotFormState {
  return {
    name: bot.name,
    alertType: bot.alertType as BotFormState["alertType"],
    direction: bot.direction as BotFormState["direction"],
    pairs: [...bot.pairs],
    maxInvestmentPct: bot.maxInvestmentPct,
    maxInvestmentUnit: bot.maxInvestmentUnit,
    maxActiveSmartTradesEnabled: bot.maxActiveSmartTradesEnabled,
    maxActiveSmartTrades: bot.maxActiveSmartTrades ?? 2,
    exchangeAccountId: bot.exchangeAccountId ?? "",
    entryEnabled: bot.entryEnabled,
    entryVolumePct: bot.entryVolumePct,
    entryOrderType: bot.entryOrderType as BotFormState["entryOrderType"],
    exitEnabled: bot.exitEnabled,
    takeProfitEnabled: bot.takeProfitEnabled,
    takeProfitPct: bot.takeProfitPct ?? 5,
    stopLossEnabled: bot.stopLossEnabled,
    stopLossPct: bot.stopLossPct ?? 3,
  };
}

export default function EditBot() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [form, setForm] = useState<BotFormState>(defaultBotForm);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SignalBot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The webhook secret is masked in every routine response, so the
  // ready-to-paste JSON has to be fetched deliberately. See BOT-016.
  const [revealed, setRevealed] = useState<SignalBot | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.bots
      .get(id)
      .then((bot) => setForm(botToForm(bot)))
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load bot"))
      .finally(() => setLoading(false));
  }, [id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    if (form.pairs.length === 0) {
      setSubmitError("Select at least one trading pair.");
      return;
    }
    setSubmitError(null);
    setSaving(true);
    try {
      const bot = await api.bots.update(id, buildBotPayload(form));
      setSaved(bot);
      toast("Bot updated successfully!", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save bot";
      setSubmitError(msg);
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 p-16 text-[var(--color-muted)]">
        <Spinner size={20} />
        <span className="text-sm">Loading bot…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6 max-w-lg">
        <div className="px-4 py-3 rounded-xl bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-[var(--color-danger)] text-sm mb-4">
          {loadError}
        </div>
        <Btn onClick={() => nav("/")}>Back to Dashboard</Btn>
      </div>
    );
  }

  const reveal = async () => {
    if (!id) return;
    setRevealing(true);
    setRevealError(null);
    try {
      setRevealed(await api.bots.reveal(id));
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : "Could not load the webhook secret");
    } finally {
      setRevealing(false);
    }
  };

  if (saved) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6 p-4 rounded-xl bg-[var(--color-success-dim)] border border-[var(--color-success)]/30">
          <CheckCircle size={20} className="text-[var(--color-success)] flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[var(--color-success)]">Bot updated!</p>
            <p className="text-xs text-[var(--color-muted)] mt-0.5">
              Your webhook secret is unchanged — existing TV alerts continue to work.
            </p>
          </div>
        </div>

        <Section
          title="Webhook (unchanged)"
          desc="Your existing TradingView alerts don't need updating."
          side={<Webhook size={16} className="text-[var(--color-muted)] mt-2" />}
        >
          <CopyField label="Webhook URL" value={saved.webhookUrl} />

          {revealed?.entryWebhookJson ? (
            <>
              <CopyField
                label="Entry signal JSON"
                value={JSON.stringify(revealed.entryWebhookJson, null, 2)}
              />
              {revealed.exitWebhookJson && (
                <CopyField
                  label="Exit signal JSON"
                  value={JSON.stringify(revealed.exitWebhookJson, null, 2)}
                />
              )}
              <p className="text-[11px] text-[var(--color-warning)] leading-relaxed">
                These payloads contain the webhook secret — the only
                authentication on the order-placing endpoint. Do not paste them
                anywhere but your own TradingView alert.
              </p>
            </>
          ) : (
            <div>
              <Btn onClick={reveal} disabled={revealing}>
                {revealing ? "Loading…" : "Reveal signal JSON"}
              </Btn>
              <p className="text-[11px] text-[var(--color-muted)] mt-2 leading-relaxed">
                The secret is masked by default and served only when you ask for
                it. Your existing alerts already have it and keep working.
              </p>
              {revealError && (
                <p className="text-[11px] text-[var(--color-danger)] mt-2">{revealError}</p>
              )}
            </div>
          )}
        </Section>

        <div className="flex gap-3 justify-end mt-2">
          <Btn onClick={() => setSaved(null)}>Keep editing</Btn>
          <Btn primary onClick={() => nav("/")}>Go to Dashboard</Btn>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-6 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-white">Edit Signal Bot</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Changes take effect on the next webhook signal. Your secret is unchanged.
        </p>
      </div>

      {submitError && (
        <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-[var(--color-danger)] text-sm">
          <span className="flex-shrink-0 mt-0.5">✕</span>
          {submitError}
        </div>
      )}

      <BotFormFields form={form} setForm={setForm} />

      <div className="flex justify-end gap-3 mt-2">
        <Btn onClick={() => nav("/")}>Cancel</Btn>
        <Btn primary type="submit" loading={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Btn>
      </div>
    </form>
  );
}
