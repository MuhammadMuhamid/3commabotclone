import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { clientFromAccount, getUsdtBalance, getTotalBalanceUsdt } from "../services/binance.js";
import { asyncHandler } from "../middleware/errors.js";
import { ControlRefusal } from "../services/controlCommands.js";
import {
  accountNameSchema, apiKeySchema, apiSecretSchema, assertCanStoreSecrets, assertMainnetConfirmed,
  createExchangeAccount, deleteExchangeAccountGuarded,
} from "../services/exchangeAccounts.js";

export const exchangeRouter = Router();

function sendRefusal(res: Response, error: unknown): boolean {
  if (!(error instanceof ControlRefusal)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

const createAccountSchema = z.object({
  name: accountNameSchema,
  apiKey: apiKeySchema,
  apiSecret: apiSecretSchema,
  /*
   * U5: REQUIRED. It used to be optional and default to false, so any
   * client that omitted it created a MAINNET account — inside an
   * installation whose process default is testnet. The choice of network
   * is always explicit.
   */
  testnet: z.boolean({
    required_error: "testnet is required: true for Binance testnet, false for mainnet",
    invalid_type_error: "testnet must be true or false",
  }),
  /** Required, exactly "MAINNET", when testnet is false — checked here, not only in the browser. */
  mainnetConfirmation: z.string().max(16).optional(),
});

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

exchangeRouter.post("/", asyncHandler(async (req, res) => {
  try {
    // Refuse to persist a live exchange credential when key material is
    // missing or unusable (finding X-07): a blob encrypted under the wrong key
    // cannot be read back, and one under a *published* key is readable by
    // anyone with the source.
    assertCanStoreSecrets();
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      // Only zod's message — never an input value.
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input", code: "invalid_request" });
      return;
    }
    const body = parsed.data;
    assertMainnetConfirmed(body.testnet, body.mainnetConfirmation);
    const account = await createExchangeAccount(body);
    res.status(201).json({
      id: account.id,
      name: account.name,
      exchange: account.exchange,
      marketType: account.marketType,
      testnet: account.testnet,
    });
  } catch (error) {
    if (sendRefusal(res, error)) return;
    throw error; // masked 500, logged without the body (X1)
  }
}));

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

exchangeRouter.delete("/:id", asyncHandler(async (req, res) => {
  // BUG-06: refused while anything references the account — now atomic and
  // shared with C16 (`deleteExchangeAccountGuarded`).
  try {
    await deleteExchangeAccountGuarded(String(req.params.id));
  } catch (error) {
    if (sendRefusal(res, error)) return;
    throw error;
  }
  res.status(204).send();
}));
