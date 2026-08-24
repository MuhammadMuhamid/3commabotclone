import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, KeyRound, Shield, ShieldCheck, Eye, EyeOff, Copy } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { Spinner } from "../components/ui";

type Step = "loading" | "register" | "credentials" | "totp_setup" | "totp_verify";

export default function Login() {
  const { user, loading: authLoading, setUser } = useAuth();
  const nav = useNavigate();

  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Credential fields
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);

  // MFA fields
  const [setupToken, setSetupToken] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // Redirect already-authenticated users away from login
  useEffect(() => {
    if (!authLoading && user) nav("/", { replace: true });
  }, [user, authLoading, nav]);

  // Determine initial screen: register or login.
  // Always add .catch() — a 429, network error, or any other failure must
  // fall through to the login form instead of leaving the spinner up forever.
  useEffect(() => {
    api.auth.status()
      .then(({ setup }) => setStep(setup ? "credentials" : "register"))
      .catch(() => setStep("credentials")); // safe default: show login form
  }, []);

  const err = (msg: string) => { setError(msg); setBusy(false); };

  // ── Register ──────────────────────────────────────────────────────────────
  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPw) { err("Passwords do not match"); return; }
    if (password.length < 12) { err("Password must be at least 12 characters"); return; }
    setBusy(true); setError(null);
    try {
      await api.auth.register(username, password);
      setStep("credentials");
      setPassword(""); setConfirmPw("");
    } catch (e) {
      err(e instanceof Error ? e.message : "Registration failed");
    }
  };

  // ── Login ─────────────────────────────────────────────────────────────────
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.auth.login(username, password);
      setSetupToken(res.setupToken);

      if (res.step === "totp_setup") {
        // First time — fetch QR code immediately
        const qr = await api.auth.totpQr(res.setupToken);
        setQrCode(qr.qrCode);
        setManualKey(qr.manualKey);
        setStep("totp_setup");
      } else {
        setStep("totp_verify");
      }
    } catch (e) {
      err(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  // ── TOTP enable / verify ──────────────────────────────────────────────────
  const handleTotp = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) { err("Enter the 6-digit code from your authenticator"); return; }
    setBusy(true); setError(null);
    try {
      const fn = step === "totp_setup" ? api.auth.totpEnable : api.auth.totpVerify;
      const res = await fn(setupToken, code);
      setUser({ username: res.username, totpEnabled: true });
      nav("/", { replace: true });
    } catch (e) {
      err(e instanceof Error ? e.message : "Invalid code");
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const copyKey = () => {
    navigator.clipboard.writeText(manualKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Focus code input whenever we land on a TOTP step ────────────────────
  // autoFocus alone is unreliable in React conditional renders — we must
  // explicitly focus via ref after the step state update settles.
  useEffect(() => {
    if (step === "totp_setup" || step === "totp_verify") {
      // Small timeout allows the DOM to fully paint before focusing
      const t = setTimeout(() => codeRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [step]);

  // ── TOTP code: strip non-digits, auto-submit when 6 digits entered ───────
  const onCodeChange = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    // Auto-submit as soon as 6 digits are in place
    if (digits.length === 6) {
      setTimeout(() => {
        document.getElementById("totp-submit-btn")?.click();
      }, 80);
    }
  };

  // ── Layout ────────────────────────────────────────────────────────────────
  if (step === "loading") {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-[var(--color-accent)] flex items-center justify-center mb-3">
            <Activity size={22} className="text-black" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">Signal Bot</h1>
          <p className="text-xs text-[var(--color-muted)] mt-1">
            {step === "register"    && "Create your admin account"}
            {step === "credentials" && "Sign in to your account"}
            {step === "totp_setup"  && "Set up two-factor authentication"}
            {step === "totp_verify" && "Enter your authenticator code"}
          </p>
        </div>

        <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-2xl p-6">

          {/* ── Error ──────────────────────────────────────────────────── */}
          {error && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-[var(--color-danger)] text-sm flex items-center gap-2">
              <span className="flex-shrink-0">✕</span>
              {error}
            </div>
          )}

          {/* ── Register ───────────────────────────────────────────────── */}
          {step === "register" && (
            <form onSubmit={handleRegister} className="space-y-4">
              <Field label="Username" icon={<KeyRound size={14} />}>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Choose a username"
                  autoComplete="username"
                  required
                  className="auth-input"
                />
              </Field>

              <Field label="Password" icon={<Shield size={14} />}
                right={<EyeToggle show={showPw} toggle={() => setShowPw(!showPw)} />}
              >
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 12 characters"
                  autoComplete="new-password"
                  required
                  className="auth-input"
                />
              </Field>

              <Field label="Confirm password">
                <input
                  type={showPw ? "text" : "password"}
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  placeholder="Repeat your password"
                  autoComplete="new-password"
                  required
                  className="auth-input"
                />
              </Field>

              <p className="text-[10px] text-[var(--color-muted)] leading-relaxed">
                After registering you will complete mandatory two-factor authentication setup before accessing the dashboard.
              </p>

              <AuthBtn loading={busy}>Create Account</AuthBtn>
            </form>
          )}

          {/* ── Login ──────────────────────────────────────────────────── */}
          {step === "credentials" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label="Username" icon={<KeyRound size={14} />}>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Your username"
                  autoComplete="username"
                  autoFocus
                  required
                  className="auth-input"
                />
              </Field>

              <Field label="Password" icon={<Shield size={14} />}
                right={<EyeToggle show={showPw} toggle={() => setShowPw(!showPw)} />}
              >
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  autoComplete="current-password"
                  required
                  className="auth-input"
                />
              </Field>

              <AuthBtn loading={busy}>Sign In</AuthBtn>
            </form>
          )}

          {/* ── TOTP Setup ─────────────────────────────────────────────── */}
          {step === "totp_setup" && (
            <form onSubmit={handleTotp} className="space-y-5">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-accent-dim)] border border-[var(--color-accent)]/20">
                <ShieldCheck size={15} className="text-[var(--color-accent)] flex-shrink-0" />
                <p className="text-xs text-[var(--color-accent)] leading-relaxed">
                  Scan this QR code with <strong>Google Authenticator</strong>, <strong>Authy</strong>, or any TOTP app. MFA is mandatory.
                </p>
              </div>

              {/* QR code */}
              {qrCode && (
                <div className="flex flex-col items-center gap-3">
                  <div className="p-2 bg-white rounded-xl">
                    <img src={qrCode} alt="TOTP QR Code" className="w-44 h-44" />
                  </div>

                  {/* Manual key */}
                  <div className="w-full">
                    <p className="text-[10px] text-[var(--color-muted)] mb-1">Or enter manually:</p>
                    <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg">
                      <code className="flex-1 text-[10px] text-[var(--color-accent)] break-all font-mono tracking-wider">
                        {manualKey}
                      </code>
                      <button type="button" onClick={copyKey}
                        className="text-[var(--color-muted)] hover:text-white transition-colors flex-shrink-0"
                        title="Copy key"
                      >
                        {copied
                          ? <span className="text-[10px] text-[var(--color-success)]">✓</span>
                          : <Copy size={12} />
                        }
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <Field label="Verification code" icon={<ShieldCheck size={14} />}>
                <input
                  ref={codeRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => onCodeChange(e.target.value)}
                  placeholder="000000"
                  className="auth-input text-center text-lg tracking-[0.5em] font-mono"
                />
              </Field>

              <AuthBtn id="totp-submit-btn" loading={busy}>Activate MFA & Continue</AuthBtn>
            </form>
          )}

          {/* ── TOTP Verify ────────────────────────────────────────────── */}
          {step === "totp_verify" && (
            <form onSubmit={handleTotp} className="space-y-5">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)]">
                <ShieldCheck size={15} className="text-[var(--color-accent)] flex-shrink-0" />
                <p className="text-xs text-[var(--color-muted)]">
                  Open your authenticator app and enter the 6-digit code for <strong className="text-white">Signal Bot</strong>.
                </p>
              </div>

              <Field label="Authenticator code" icon={<ShieldCheck size={14} />}>
                <input
                  ref={codeRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => onCodeChange(e.target.value)}
                  placeholder="000000"
                  className="auth-input text-center text-lg tracking-[0.5em] font-mono"
                />
              </Field>

              <AuthBtn id="totp-submit-btn" loading={busy}>Verify & Sign In</AuthBtn>

              <button
                type="button"
                onClick={() => { setStep("credentials"); setCode(""); setError(null); }}
                className="w-full text-xs text-[var(--color-muted)] hover:text-white transition-colors py-1"
              >
                ← Back to login
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[10px] text-[var(--color-muted)] mt-5">
          Signal Bot · Private trading platform
        </p>
      </div>

      {/* Inline styles for auth inputs (avoids polluting global CSS) */}
      <style>{`
        .auth-input {
          width: 100%;
          background: var(--color-panel-2);
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          color: white;
          font-size: 0.875rem;
          outline: none;
          transition: border-color 150ms;
        }
        .auth-input:focus {
          border-color: var(--color-accent);
        }
        .auth-input::placeholder {
          color: var(--color-muted);
        }
      `}</style>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({
  label,
  icon,
  right,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)]">
          {icon}
          {label}
        </label>
        {right}
      </div>
      {children}
    </div>
  );
}

function EyeToggle({ show, toggle }: { show: boolean; toggle: () => void }) {
  return (
    <button
      type="button"
      onClick={toggle}
      className="text-[var(--color-muted)] hover:text-white transition-colors"
      tabIndex={-1}
    >
      {show ? <EyeOff size={13} /> : <Eye size={13} />}
    </button>
  );
}

function AuthBtn({ loading, children, id }: { loading: boolean; children: React.ReactNode; id?: string }) {
  return (
    <button
      id={id}
      type="submit"
      disabled={loading}
      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[var(--color-accent)] text-black font-semibold text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {loading ? <Spinner size={14} /> : null}
      {loading ? "Please wait…" : children}
    </button>
  );
}
