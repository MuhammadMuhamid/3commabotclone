/**
 * A simulated process restart for the D1/D2 suites.
 *
 * Run as a SEPARATE node process against the parent test's SQLite file, so
 * every in-process structure (locks, counters, module state) starts empty —
 * exactly what a real restart gives the boot reconcilers in `index.ts`:
 * `reconcileManualTrading()` -> `reconcilePendingManualOrders(_, 100)` and
 * `reconcilePendingStrategyIntents()`. Those are invoked here with an in-memory
 * fake exchange instead of the default real clients. No network.
 *
 * argv[2]: JSON `{ book: FakeOrder-like[], price?, freeBase? }` describing what
 * the exchange holds now. Prints one JSON line with what reached the fake.
 */
import { fakeBinance } from "./fakeBinance.js";

const spec = JSON.parse(process.argv[2] ?? "{}") as {
  book?: { clientOrderId: string; side: string; type?: string; status: string;
    executedQty: string; cummulativeQuoteQty: string; orderId?: string }[];
  price?: string;
  freeBase?: string;
  runProtection?: boolean;
};

const { config } = await import("../../src/config.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { BinanceManualExchange } = await import("../../src/services/manualExchange.js");
const { reconcilePendingManualOrders } = await import("../../src/services/manualTrading.js");
const { checkManualProtection } = await import("../../src/services/manualProtection.js");
const { reconcilePendingStrategyIntents, strategyMarketAdapter } =
  await import("../../src/services/strategyOrderIntent.js");

config.dryRun = false;
config.manualTradingEnabled = true;

const exchange = fakeBinance({ price: spec.price ?? "100", freeBase: spec.freeBase ?? "10" });
for (const order of spec.book ?? []) exchange.seed(order);

await reconcilePendingManualOrders((account) =>
  new BinanceManualExchange(account, { client: exchange.client, dryRun: false }), 100);
await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(exchange.client, false));
if (spec.runProtection) {
  await checkManualProtection((account) =>
    new BinanceManualExchange(account, { client: exchange.client, dryRun: false }));
}
await prisma.$disconnect();
process.stdout.write(`${JSON.stringify({
  submissions: exchange.submissions.length, lookups: exchange.lookups.length,
})}\n`);
