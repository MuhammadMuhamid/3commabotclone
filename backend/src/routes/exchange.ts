import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { canStoreSecrets, encrypt } from "../lib/crypto.js";
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
    // Refuse to persist a live exchange credential when key material is
    // missing or unusable. `assertConfig()` already prevents the server from
    // starting in that state, but this is the write that would be
    // unrecoverable: a blob encrypted under the wrong key cannot be read back,
    // and one encrypted under a *published* key is readable by anyone with the
    // source (finding X-07).
    if (!canStoreSecrets()) {
      return res.status(503).json({
        error:
          "Cannot store exchange credentials: ENCRYPTION_KEY and SCRYPT_SALT " +
          "are not configured. See backend/.env.example.",
      });
    }
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
    const [botCount, manualOrderCount, manualPositionCount, spotExecutionCount, derivativeExecutionCount] = await Promise.all([
      prisma.signalBot.count({ where: { exchangeAccountId: req.params.id } }),
      prisma.manualOrder.count({ where: { exchangeAccountId: req.params.id } }),
      prisma.smartTrade.count({ where: { exchangeAccountId: req.params.id } }),
      prisma.spotExecutionOrder.count({ where: { exchangeAccountId: req.params.id } }),
      prisma.derivativeExecutionOrder.count({ where: { exchangeAccountId: req.params.id } }),
    ]);
    if (botCount > 0 || manualOrderCount > 0 || manualPositionCount > 0 || spotExecutionCount > 0
        || derivativeExecutionCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${botCount} bot(s), ${manualOrderCount} manual order(s), and ` +
          `${manualPositionCount} manual position record(s), and ${spotExecutionCount} Spot execution order(s) ` +
          `and ${derivativeExecutionCount} derivatives execution order(s) ` +
          "use this account. Preserve or reassign them first.",
      });
    }
    await prisma.exchangeAccount.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) {
    // BUG-10: Structured error for DB failure
    res.status(500).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});
