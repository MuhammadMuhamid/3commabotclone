/**
 * The exchange-key entry pieces, shared by the dashboard's Settings page and
 * the Bot-origin enrollment page (`enroll.html`, OD-4), so both ask for keys
 * and for the mainnet confirmation in exactly the same way.
 *
 * Both key inputs are `type="password"` with `autocomplete="off"`: the API key
 * used to be a plain text field (parity inventory §5 #11), visible over a
 * shoulder and offered back by autofill.
 *
 * The typed MAINNET confirmation is sent to the server, which verifies it —
 * the check here only explains the refusal before submitting.
 */
import { Input } from "./ui";

export const MAINNET_CONFIRMATION_WORD = "MAINNET";

export function isMainnetConfirmed(testnet: boolean, typed: string): boolean {
  return testnet || typed === MAINNET_CONFIRMATION_WORD;
}

export function ExchangeKeyInputs({
  apiKey, onApiKey, apiSecret, onApiSecret,
}: {
  apiKey: string;
  onApiKey: (v: string) => void;
  apiSecret: string;
  onApiSecret: (v: string) => void;
}) {
  return (
    <>
      <Input
        label="API Key"
        value={apiKey}
        onChange={onApiKey}
        type="password"
        autoComplete="off"
        placeholder="Binance API key"
      />
      <Input
        label="API Secret"
        value={apiSecret}
        onChange={onApiSecret}
        type="password"
        autoComplete="off"
        placeholder="Binance API secret"
      />
    </>
  );
}

export function MainnetConfirmationField({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-5 px-3 py-3 rounded-lg bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30">
      <p className="text-xs text-[var(--color-danger)] mb-2 leading-relaxed">
        <strong>Mainnet:</strong> bots using this account place real-money orders on Binance.
        Type <code>{MAINNET_CONFIRMATION_WORD}</code> to confirm.
      </p>
      <Input
        label="Mainnet confirmation"
        value={value}
        onChange={onChange}
        autoComplete="off"
        placeholder={MAINNET_CONFIRMATION_WORD}
      />
    </div>
  );
}
