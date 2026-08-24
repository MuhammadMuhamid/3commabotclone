import webpush from "web-push";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";

export type ExecutionNotification = {
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  quoteAmount: number;
  price: number;
  orderId: string;
  pnlPct?: number;
};

let configured = false;
function configure(): boolean {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    configured = true;
  }
  return true;
}

export function pushEnabled(): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

/** Send only after Binance has returned a successful filled order. */
export async function sendExecutionNotification(event: ExecutionNotification): Promise<void> {
  if (!configure()) return;
  const subscriptions = await prisma.pushSubscription.findMany();
  if (subscriptions.length === 0) return;
  const isBuy = event.side === "buy";
  const payload = JSON.stringify({
    title: `${isBuy ? "🟢 BUY" : "🔴 SELL"} EXECUTED · ${event.symbol}`,
    body: isBuy
      ? `${event.quoteAmount.toFixed(2)} USDT at ${event.price.toPrecision(7)}`
      : `${event.quantity.toPrecision(7)} sold at ${event.price.toPrecision(7)}${event.pnlPct == null ? "" : ` · P/L ${event.pnlPct >= 0 ? "+" : ""}${event.pnlPct.toFixed(2)}%`}`,
    url: "/",
    tag: `execution-${event.orderId}`,
  });

  await Promise.allSettled(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, payload, { TTL: 300, urgency: "high" });
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {});
      } else {
        console.error("Push delivery failed", status ?? "unknown");
      }
    }
  }));
}
