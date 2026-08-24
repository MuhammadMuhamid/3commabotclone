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
    const entryJson = JSON.stringify(created.entryWebhookJson ?? {}, null, 2);
    const exitJson  = JSON.stringify(created.exitWebhookJson ?? {}, null, 2);
    return (
      <div className="p-6 max-w-3xl mx-auto">
        {/* Success banner */}
        <div className="flex items-center gap-3 mb-6 p-4 rounded-xl bg-[var(--color-success-dim)] border border-[var(--color-success)]/30">
          <CheckCircle size={20} className="text-[var(--color-success)] flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[var(--color-success)]">Bot created!</p>
            <p className="text-xs text-[var(--color-muted)] mt-0.5">
              Configure your TradingView alerts with the details below.
            </p>
          </div>
        </div>

        <Section
          title="Webhook Setup"
          desc="Copy these into your TradingView alert settings."
          side={<Webhook size={16} className="text-[var(--color-muted)] mt-2" />}
        >
          <CopyField label="Webhook URL" value={created.webhookUrl} />
          <p className="text-xs text-[var(--color-muted)] mb-5 leading-relaxed">
            Paste this URL into the <strong className="text-white">Webhook URL</strong> field of your
            TradingView alert. Set the alert condition to{" "}
            <strong className="text-white">alert() function calls only</strong>.
          </p>

          <CopyField label="Entry signal JSON (paste into Message field)" value={entryJson} />
          <p className="text-xs text-[var(--color-muted)] mb-5 leading-relaxed">
            Use <code className="text-[var(--color-accent)]">{"{{strategy.order.action}}"}</code> for the action and{" "}
            <code className="text-[var(--color-accent)]">{"{{ticker}}"}</code> for the symbol — TradingView fills these at alert time.
          </p>

          <CopyField label="Exit signal JSON (optional separate alert)" value={exitJson} />
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
