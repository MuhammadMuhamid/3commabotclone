import { useEffect, useState } from "react";
import { ShieldAlert, Trash2, Plus, KeyRound, TestTube, Bell, BellOff } from "lucide-react";
import { api, type ExchangeAccount } from "../api";
import { Btn, Input, Badge, Spinner, toast } from "../components/ui";

export default function Settings() {
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [name, setName] = useState("My Binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [testnet, setTestnet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushSupported] = useState(() => "serviceWorker" in navigator && "PushManager" in window);
  const [pushConfigured, setPushConfigured] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushPublicKey, setPushPublicKey] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  const load = () => {
    setLoadingAccounts(true);
    api.exchange
      .list()
      .then(setAccounts)
      .catch(console.error)
      .finally(() => setLoadingAccounts(false));
  };

  useEffect(() => {
    load();
    api.notifications.status().then((s) => {
      setPushConfigured(s.enabled); setPushSubscribed(s.subscribed); setPushPublicKey(s.publicKey);
    }).catch(() => {});
  }, []);

  const decodeVapidKey = (value: string): ArrayBuffer => {
    const padded = value + "=".repeat((4 - value.length % 4) % 4);
    const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  };

  const enablePush = async () => {
    if (!pushPublicKey) return;
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(pushPublicKey),
      });
      await api.notifications.subscribe(subscription.toJSON());
      setPushSubscribed(true);
      toast("BUY/SELL execution notifications enabled on this device.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not enable notifications", "error");
    } finally { setPushBusy(false); }
  };

  const disablePush = async () => {
    setPushBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.notifications.unsubscribe(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setPushSubscribed(false);
      toast("Notifications disabled on this device.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not disable notifications", "error");
    } finally { setPushBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.exchange.create({ name, apiKey, apiSecret, testnet });
      setApiKey("");
      setApiSecret("");
      setName("My Binance");
      setTestnet(false);
      toast("Exchange account connected.", "success");
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to connect account", "error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, accountName: string) => {
    if (!confirm(`Remove "${accountName}"? Bots using it will lose their credentials.`)) return;
    try {
      await api.exchange.remove(id);
      toast("Account removed.", "success");
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to remove account", "error");
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Settings</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Connect Binance API keys to enable live trading.
        </p>
      </div>

      {/* Security notice */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/25">
        <ShieldAlert size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-300 leading-relaxed">
          <strong>Security:</strong> Use a Binance API key with <strong>read + spot trading</strong> permissions only.
          Disable withdrawals and whitelist this server's IP address in Binance API settings.
        </p>
      </div>

      <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-[var(--color-panel-2)] flex items-center justify-center">
              {pushSubscribed ? <Bell size={17} className="text-[var(--color-accent)]" /> : <BellOff size={17} className="text-[var(--color-muted)]" />}
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Mobile order notifications</h2>
              <p className="text-xs text-[var(--color-muted)] mt-1 max-w-md">
                Receive only confirmed Binance BUY and SELL execution notifications. Signal receipt and failed orders do not generate mobile pushes.
              </p>
              {!pushSupported && <p className="text-xs text-amber-300 mt-2">Install Signal Bot on your phone’s Home Screen, then open Settings from the installed app.</p>}
              {!pushConfigured && <p className="text-xs text-amber-300 mt-2">Push delivery is awaiting server configuration.</p>}
            </div>
          </div>
          <Btn primary={!pushSubscribed} loading={pushBusy}
            disabled={!pushSupported || !pushConfigured || pushBusy}
            onClick={pushSubscribed ? disablePush : enablePush}>
            {pushSubscribed ? "Disable" : "Enable"}
          </Btn>
        </div>
      </div>

      {/* Add account form */}
      <form
        onSubmit={submit}
        className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl p-6"
      >
        <div className="flex items-center gap-2 mb-5">
          <KeyRound size={16} className="text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold text-white">Add Exchange Account</h2>
        </div>

        <Input
          label="Account name"
          value={name}
          onChange={setName}
          placeholder="e.g. My Binance Main"
        />
        <Input
          label="API Key"
          value={apiKey}
          onChange={setApiKey}
          placeholder="Binance API key"
        />
        <Input
          label="API Secret"
          value={apiSecret}
          onChange={setApiSecret}
          type="password"
          placeholder="Binance API secret"
        />

        <label className="flex items-center gap-2.5 mb-5 cursor-pointer group">
          <input
            type="checkbox"
            checked={testnet}
            onChange={(e) => setTestnet(e.target.checked)}
            className="w-4 h-4 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] accent-[var(--color-accent)]"
          />
          <div className="flex items-center gap-1.5">
            <TestTube size={13} className="text-[var(--color-muted)]" />
            <span className="text-sm text-[var(--color-muted)] group-hover:text-white transition-colors">
              Use Binance testnet
            </span>
          </div>
        </label>

        <Btn primary type="submit" loading={saving} className="w-full justify-center">
          <Plus size={14} />
          {saving ? "Connecting…" : "Connect Exchange Account"}
        </Btn>
      </form>

      {/* Connected accounts */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-white">Connected Accounts</h2>
          <span className="text-xs text-[var(--color-muted)]">({accounts.length})</span>
        </div>

        {loadingAccounts ? (
          <div className="flex items-center gap-2 text-[var(--color-muted)] text-sm py-6">
            <Spinner size={16} />
            Loading accounts…
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-sm text-[var(--color-muted)] py-6 text-center border border-dashed border-[var(--color-border)] rounded-xl">
            No accounts connected yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl px-4 py-3 card-hover"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[var(--color-panel-2)] flex items-center justify-center">
                    <KeyRound size={14} className="text-[var(--color-accent)]" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{a.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs text-[var(--color-muted)]">Binance Spot</span>
                      {a.testnet && <Badge variant="warning">Testnet</Badge>}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(a.id, a.name)}
                  className="p-2 rounded-lg text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-dim)] transition-all"
                  title="Remove account"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
