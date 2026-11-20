import type { PrismaClient } from "@prisma/client";
import { syncOrder, type AdminGraphql } from "./sync.server";

/**
 * One order change sends several webhooks at once (e.g. a fulfilment sends
 * orders/updated, orders/partially_fulfilled and orders/fulfilled). Webhooks
 * only queue the order; after a short pause each queued order is re-read
 * once. Shopify gets its 200 straight away.
 *
 * In-memory: anything lost on a restart is repaired by the next webhook for
 * that order or by "Resync all orders".
 */

type Job = { gid: string; actor: string; attempts: number; notBefore: number };
type ShopQueue = { db: PrismaClient; graphql: AdminGraphql; jobs: Map<string, Job>; running: boolean };

const queues = new Map<string, ShopQueue>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let opts = { debounceMs: 2000, retryDelayMs: 5000, maxAttempts: 3 };
/** Test hook. */
export function configureOrderQueue(o: Partial<typeof opts>) { opts = { ...opts, ...o }; }

export function enqueueOrder(db: PrismaClient, graphql: AdminGraphql, shop: string, orderGid: string, actor: string) {
  let q = queues.get(shop);
  if (!q) { q = { db, graphql, jobs: new Map(), running: false }; queues.set(shop, q); }
  q.db = db; q.graphql = graphql;
  if (!q.jobs.has(orderGid)) q.jobs.set(orderGid, { gid: orderGid, actor, attempts: 0, notBefore: 0 });
  if (!q.running) void run(shop, q);
}

export async function drainOrderQueue(shop: string) {
  while (queues.get(shop)?.running) await wait(20);
}

async function run(shop: string, q: ShopQueue) {
  q.running = true;
  try {
    await wait(opts.debounceMs);
    while (q.jobs.size) {
      const now = Date.now();
      const due = [...q.jobs.values()].find((j) => j.notBefore <= now);
      if (!due) { await wait(50); continue; }
      q.jobs.delete(due.gid);
      try {
        await syncOrder(q.db, q.graphql, shop, due.gid, due.actor);
      } catch (e) {
        if (due.attempts + 1 < opts.maxAttempts) {
          q.jobs.set(due.gid, { ...due, attempts: due.attempts + 1, notBefore: Date.now() + opts.retryDelayMs });
        } else {
          console.error(`[vendor-portal] giving up on ${due.gid} for ${shop}`, e);
        }
      }
    }
  } finally {
    q.running = false;
  }
}
