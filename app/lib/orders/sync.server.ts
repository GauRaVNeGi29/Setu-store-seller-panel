import type { PrismaClient } from "@prisma/client";
import { gidToId, orderToLines, type ShopifyOrder, type VendorLine } from "./map";

/**
 * Keeps VendorOrderLine in step with Shopify.
 *
 * Webhook payloads are never trusted for content: every webhook only names
 * an order, and the order is re-read from the Admin API (read-only). So the
 * stored lines always match Shopify at the moment of the read, whatever order
 * webhooks arrive in.
 */

export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<{ json: () => Promise<{ data?: unknown; errors?: unknown }> }>;

const LINE_PAGE = 50;

const ORDER_FIELDS = `
  id name createdAt updatedAt cancelledAt currencyCode
  displayFinancialStatus displayFulfillmentStatus
  lineItems(first: ${LINE_PAGE}, after: $lineCursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title variantTitle sku vendor quantity currentQuantity unfulfilledQuantity
      product { id } variant { id }
      originalUnitPriceSet { shopMoney { amount } }
      discountedTotalSet { shopMoney { amount } }
    }
  }
  refunds {
    id
    refundLineItems(first: 100) { nodes { quantity lineItem { id } subtotalSet { shopMoney { amount } } } }
  }
`;

export const ORDER_QUERY = `#graphql
  query SetuVendorOrder($id: ID!, $lineCursor: String) {
    order(id: $id) { ${ORDER_FIELDS} }
  }`;

export const ORDERS_PAGE_QUERY = `#graphql
  query SetuVendorOrdersPage($cursor: String, $lineCursor: String) {
    orders(first: 10, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }`;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
type RawOrder = Omit<ShopifyOrder, "lineItems"> & { lineItems: Page<ShopifyOrder["lineItems"]["nodes"][number]> };

async function call<T>(graphql: AdminGraphql, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors).slice(0, 500)}`);
  if (!body.data) throw new Error("Shopify GraphQL returned no data");
  return body.data;
}

/** Reads the remaining line items of an order with more than LINE_PAGE lines. */
async function completeLines(graphql: AdminGraphql, order: RawOrder): Promise<ShopifyOrder> {
  const nodes = [...order.lineItems.nodes];
  let page = order.lineItems.pageInfo;
  while (page.hasNextPage) {
    const data = await call<{ order: RawOrder | null }>(graphql, ORDER_QUERY, { id: order.id, lineCursor: page.endCursor });
    if (!data.order) break;
    nodes.push(...data.order.lineItems.nodes);
    page = data.order.lineItems.pageInfo;
  }
  return { ...order, lineItems: { nodes } };
}

export async function fetchOrder(graphql: AdminGraphql, orderGid: string): Promise<ShopifyOrder | null> {
  const data = await call<{ order: RawOrder | null }>(graphql, ORDER_QUERY, { id: orderGid, lineCursor: null });
  return data.order ? completeLines(graphql, data.order) : null;
}

const toRow = (shop: string, l: VendorLine) => ({ shop, ...l });

/** Replaces the stored lines of one order with what Shopify says now. Idempotent. */
export async function saveOrder(db: PrismaClient, shop: string, order: ShopifyOrder, actor: string) {
  const lines = orderToLines(order);
  const orderId = gidToId(order.id);
  const keep = lines.map((l) => l.lineItemId);
  await db.$transaction([
    db.vendorOrderLine.deleteMany({ where: { shop, orderId, lineItemId: { notIn: keep } } }),
    ...lines.map((l) =>
      db.vendorOrderLine.upsert({
        where: { shop_lineItemId: { shop, lineItemId: l.lineItemId } },
        create: toRow(shop, l),
        update: toRow(shop, l),
      }),
    ),
    db.auditLog.create({
      data: {
        shop, actor, action: "order.synced", target: `order:${orderId}`,
        detail: { name: order.name, lines: lines.length, vendors: [...new Set(lines.map((l) => l.vendorName))] },
      },
    }),
  ]);
  return lines;
}

export async function removeOrder(db: PrismaClient, shop: string, orderId: bigint, actor: string) {
  const { count } = await db.vendorOrderLine.deleteMany({ where: { shop, orderId } });
  await db.auditLog.create({ data: { shop, actor, action: "order.removed", target: `order:${orderId}`, detail: { lines: count } } });
  return count;
}

/** Re-reads one order; removes it locally if Shopify no longer has it. */
export async function syncOrder(db: PrismaClient, graphql: AdminGraphql, shop: string, orderGid: string, actor: string) {
  const order = await fetchOrder(graphql, orderGid);
  if (!order) return { removed: await removeOrder(db, shop, gidToId(orderGid), actor) };
  return { lines: (await saveOrder(db, shop, order, actor)).length };
}

/**
 * Reads every order and rebuilds the table: used on first install, by the
 * "Resync all orders" button, and to repair anything a missed webhook left
 * behind. Orders that exist locally but not in Shopify are removed.
 */
export async function fullSync(db: PrismaClient, graphql: AdminGraphql, shop: string, actor: string) {
  const seen = new Set<bigint>();
  let cursor: string | null = null;
  try {
    do {
      const data: { orders: Page<RawOrder> } = await call(graphql, ORDERS_PAGE_QUERY, { cursor, lineCursor: null });
      for (const raw of data.orders.nodes) {
        const order = await completeLines(graphql, raw);
        await saveOrder(db, shop, order, actor);
        seen.add(gidToId(order.id));
      }
      cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    } while (cursor);

    const stored = await db.vendorOrderLine.findMany({ where: { shop }, select: { orderId: true }, distinct: ["orderId"] });
    for (const { orderId } of stored) if (!seen.has(orderId)) await removeOrder(db, shop, orderId, actor);

    await db.syncState.upsert({
      where: { shop },
      create: { shop, lastFullSyncAt: new Date(), lastFullSyncCount: seen.size, lastError: null },
      update: { lastFullSyncAt: new Date(), lastFullSyncCount: seen.size, lastError: null },
    });
    await db.auditLog.create({ data: { shop, actor, action: "sync.full", detail: { orders: seen.size } } });
    return { orders: seen.size };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.syncState.upsert({ where: { shop }, create: { shop, lastError: message }, update: { lastError: message } });
    throw e;
  }
}
