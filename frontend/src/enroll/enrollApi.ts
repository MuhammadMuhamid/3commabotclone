/**
 * The enrollment page's only transport: same-origin JSON POSTs to
 * `/api/enroll/*`. The browser adds `Origin` and `Sec-Fetch-Site`, which the
 * Bot requires (X8); the `enroll_session` cookie (HttpOnly, Path=/api/enroll)
 * travels on its own. Nothing here stores anything in the browser.
 */
export interface EnrollmentMeta {
  enrollmentId: string;
  purpose: "create" | "replace" | "reveal_webhook";
  testnet: boolean | null;
  name: string | null;
  account: { id: string; name: string; testnet: boolean; keyHint: string | null } | null;
  bot: { id: string; name: string } | null;
  expiresAt: string | null;
  attemptsLeft: number;
}

export interface KeysAnswer {
  enrollmentId: string;
  accountId: string;
  name: string;
  testnet: boolean;
  keyHint: string;
  warnings: string[];
  returnUrl: string | null;
}

export interface RevealAnswer {
  enrollmentId: string;
  botId: string;
  botName: string;
  webhookUrl: string;
  webhookSecret: string;
  exitWebhookJson: Record<string, string>;
  returnUrl: string | null;
}

export class EnrollError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly returnUrl: string | null
  ) {
    super(message);
  }
}

export async function enrollPost<T>(path: "/session" | "/state" | "/keys" | "/reveal", body: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/enroll${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new EnrollError(0, "network", "The Bot could not be reached. Check your connection and try again.", null);
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new EnrollError(response.status, String(data.code ?? "error"),
      typeof data.error === "string" ? data.error : "Request failed.",
      typeof data.returnUrl === "string" ? data.returnUrl : null);
  }
  return data as T;
}
