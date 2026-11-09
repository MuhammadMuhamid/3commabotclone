import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Webhook } from "lucide-react";
import { api, type SignalBot } from "../api";
import { BotFormFields, buildBotPayload, defaultBotForm, type BotFormState } from "../components/BotFormFields";
import { Btn, CopyField, Section, toast } from "../components/ui";

export default function CreateBot() {
  const nav = useNavigate();
  const [created, setCreated] = useState<SignalBot | null>(null);
  const [form, setForm] = useState<BotFormState>(defaultBotForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.pairs.length === 0) {
      setError("Select at least one trading pair.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const bot = await api.bots.create(buildBotPayload(form));
      setCreated(bot);
      toast("Bot created successfully!", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create bot";
      setError(msg);
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    // The creation response is the one place the secret is served unprompted:
    // this is the only moment the operator has to copy it out.
    //
    // U4: there is no entry-signal JSON. Direct TradingView BUY alerts are
    // disabled — the Platform is the sole BUY authority — so the backend never
    // sends an entry payload, and rendering one showed an empty `{}` with
    // instructions for a path that is refused.
    const exitJson = JSON.stringify(created.exitWebhookJson ?? {}, null, 2);
    const setup = created.tradingViewSetup;
    return (
      <div className="p-6 max-w-3xl mx-auto">
        {/* Success banner */}
        <div className="flex items-center gap-3 mb-6 p-4 rounded-xl bg-[var(--color-success-dim)] border border-[var(--color-success)]/30">
          <CheckCircle size={20} className="text-[var(--color-success)] flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[var(--color-success)]">Bot created!</p>
            <p className="text-xs text-[var(--color-muted)] mt-0.5">
              Copy the webhook secret now; afterwards it is shown only on an explicit Reveal.
            </p>
          </div>
        </div>

        <Section
          title="Webhook Setup"
          desc="Entries come from Trading Scene. TradingView may send exit (SELL) alerts only."
          side={<Webhook size={16} className="text-[var(--color-muted)] mt-2" />}
        >
          <CopyField label="Webhook URL" value={created.webhookUrl} />
          <CopyField
            label="Webhook secret — paste into the Trading Scene deployment"
            value={created.webhookSecret}
          />
          {setup && (
            <p className="text-xs text-[var(--color-muted)] mb-5 leading-relaxed">
              {setup.note}
            </p>
          )}

          <CopyField label="Optional: TradingView exit (SELL) alert message" value={exitJson} />
          <p className="text-[11px] text-[var(--color-warning)] leading-relaxed">
            The secret and this payload are the only authentication on the order-placing
            endpoint. Do not paste them anywhere but your own deployment and alert.
          </p>
        </Section>

        <div className="flex gap-3 justify-end mt-2">
          <Btn onClick={() => { setCreated(null); setForm(defaultBotForm); }}>Create Another</Btn>
          <Btn primary onClick={() => nav("/")}>Go to Dashboard</Btn>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-6 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-white">Create Signal Bot</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Configure your bot's trading parameters. You'll get the webhook URL after creation.
        </p>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-[var(--color-danger)] text-sm">
          <span className="flex-shrink-0 mt-0.5">✕</span>
          {error}
        </div>
      )}

      <BotFormFields form={form} setForm={setForm} />

      <div className="flex justify-end gap-3 mt-2">
        <Btn onClick={() => nav("/")}>Cancel</Btn>
        <Btn primary type="submit" loading={saving}>
          {saving ? "Creating…" : "Create Signal Bot"}
        </Btn>
      </div>
    </form>
  );
}
