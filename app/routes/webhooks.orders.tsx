import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isAllowedShop } from "../lib/guard.server";
import { removeOrder } from "../lib/orders/sync.server";
import { enqueueOrder } from "../lib/orders/queue.server";

/**
 * orders/create, orders/updated, orders/cancelled, orders/fulfilled,
 * orders/partially_fulfilled, refunds/create, orders/delete
 *
 * authenticate.webhook verifies Shopify's HMAC signature (bad signatures get 401).
 * The payload only tells us WHICH order changed; the order itself is re-read
 * from the Admin API so stored lines always match Shopify.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  if (!isAllowedShop(shop)) return new Response(); // ignore, never store

  const p = payload as { id?: number | string; order_id?: number | string; admin_graphql_api_id?: string };
  const orderId = topic === "REFUNDS_CREATE" ? p.order_id : p.id;
  if (orderId === undefined || orderId === null) return new Response();
  const actor = `webhook:${topic.toLowerCase().replace("_", "/")}`;

  if (topic === "ORDERS_DELETE") {
    await removeOrder(db, shop, BigInt(orderId), actor);
    return new Response();
  }
  if (!admin) return new Response(); // app uninstalled

  const gid = topic === "REFUNDS_CREATE" ? `gid://shopify/Order/${orderId}` : (p.admin_graphql_api_id ?? `gid://shopify/Order/${orderId}`);
  enqueueOrder(db, admin.graphql, shop, gid, actor);
  return new Response();
};
