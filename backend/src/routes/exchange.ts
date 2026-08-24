import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { encrypt } from "../lib/crypto.js";
import { clientFromAccount, getUsdtBalance, getTotalBalanceUsdt } from "../services/binance.js";

export const exchangeRouter = Router();

exchangeRouter.get("/", async (_req, res) => {
  const accounts = await prisma.exchangeAccount.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      exchange: true,
      marketType: true,
      testnet: true,
      createdAt: true,
    },
  });
  res.json(accounts);
});

exchangeRouter.post("/", async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      apiKey: z.string().min(1),
      apiSecret: z.string().min(1),
      testnet: z.boolean().optional(),
    });
    const body = schema.parse(req.body);
    const account = await prisma.exchangeAccount.create({
      data: {
        name: body.name,
        apiKeyEnc: encrypt(body.apiKey),
        apiSecretEnc: encrypt(body.apiSecret),
        testnet: body.testnet ?? false,
      },
    });
    res.status(201).json({
      id: account.id,
      name: account.name,
      exchange: account.exchange,
      marketType: account.marketType,
      testnet: account.testnet,
    });
  } catch (e) {
    // BUG-10: Structured error for ZodError or DB failure
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
    }
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to create account" });
  }
});

exchangeRouter.get("/:id/balance", async (req, res) => {
  const account = await prisma.exchangeAccount.findUnique({
    where: { id: req.params.id },
  });
  if (!account) return res.status(404).json({ error: "Not found" });
  try {
    const client = clientFromAccount(account);
    const usdt = await getUsdtBalance(client);
    res.json({ usdt });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Binance error" });
  }
});

// F1: Total account valuation in USDT — all assets at live prices
exchangeRouter.get("/:id/total-balance", async (req, res) => {
  const account = await prisma.exchangeAccount.findUnique({
    where: { id: req.params.id },
  });
  if (!account) return res.status(404).json({ error: "Not found" });
  try {
    const client = clientFromAccount(account);
    const { totalUsdt, breakdown } = await getTotalBalanceUsdt(client);
    res.json({ totalUsdt, breakdown, cachedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Binance error" });
  }
});

exchangeRouter.delete("/:id", async (req, res) => {
  try {
    // BUG-06: Prevent deletion if bots are still linked — they would silently lose credentials
    const botCount = await prisma.signalBot.count({
      where: { exchangeAccountId: req.params.id },
    });
    if (botCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${botCount} bot(s) use this account. Reassign or delete them first.`,
      });
    }
    await prisma.exchangeAccount.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) {
    // BUG-10: Structured error for DB failure
    res.status(500).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});
