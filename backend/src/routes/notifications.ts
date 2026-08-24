import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { pushEnabled } from "../services/push.js";

export const notificationsRouter = Router();

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256),
  }),
}).strict();

notificationsRouter.get("/status", async (_req, res) => {
  const userId = res.locals.userId as string;
  const subscriptions = await prisma.pushSubscription.count({ where: { userId } });
  res.json({ enabled: pushEnabled(), subscribed: subscriptions > 0, subscriptions,
    publicKey: pushEnabled() ? config.vapidPublicKey : null });
});

notificationsRouter.post("/subscribe", async (req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: "Push notifications are not configured" });
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid push subscription" });
  const userId = res.locals.userId as string;
  const { endpoint, keys } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth },
  });
  res.status(201).json({ ok: true });
});

notificationsRouter.delete("/subscribe", async (req, res) => {
  const parsed = z.object({ endpoint: z.string().url().max(2048) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid endpoint" });
  const userId = res.locals.userId as string;
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint: parsed.data.endpoint } });
  res.json({ ok: true });
});
