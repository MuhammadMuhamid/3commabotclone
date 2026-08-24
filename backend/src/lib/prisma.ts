import { PrismaClient } from "@prisma/client";
import { MONEY_FIELDS, quantizeData } from "./money.js";

/**
 * BOT-023: money is stored as SQLite `REAL`. Every write of a monetary field
 * goes through `quantizeData` here rather than at ~60 call sites, so a value
 * cannot drift through repeated read → arithmetic → write cycles. See
 * `lib/money.ts` for what this does and does not guarantee.
 */
function withMoneyQuantization(client: PrismaClient) {
  return client.$extends({
    name: "quantize-money",
    query: {
      $allModels: {
        async create({ model, args, query }) {
          if (MONEY_FIELDS[model]) args.data = quantizeData(model, args.data) as typeof args.data;
          return query(args);
        },
        async update({ model, args, query }) {
          if (MONEY_FIELDS[model]) args.data = quantizeData(model, args.data) as typeof args.data;
          return query(args);
        },
        async updateMany({ model, args, query }) {
          if (MONEY_FIELDS[model]) args.data = quantizeData(model, args.data) as typeof args.data;
          return query(args);
        },
        async upsert({ model, args, query }) {
          if (MONEY_FIELDS[model]) {
            args.create = quantizeData(model, args.create) as typeof args.create;
            args.update = quantizeData(model, args.update) as typeof args.update;
          }
          return query(args);
        },
        async createMany({ model, args, query }) {
          if (MONEY_FIELDS[model]) args.data = quantizeData(model, args.data) as typeof args.data;
          return query(args);
        },
      },
    },
  });
}

export const prisma = withMoneyQuantization(new PrismaClient());
