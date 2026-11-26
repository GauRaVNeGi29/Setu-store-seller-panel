import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isAllowedShop } from "../lib/guard.server";
import type { AdminGraphql } from "../lib/orders/sync.server";
import { gidToId } from "../lib/orders/map";
import { buyerState, publicReviews, submitReview } from "../lib/reviews/reviews.server";
import { reviewSort } from "../lib/reviews/rules";
import { updateStoreListing } from "../lib/storefront/update.server";

/**
 * Seller reviews for the storefront, reached through Shopify's app proxy:
 *   GET  /apps/setu-seller/reviews?seller=<entry handle>&page=1&sort=newest|highest|lowest
 *                                                                 published reviews, rating, and what this buyer can do
 *                                                                 (&only=list leaves the buyer part out: paging and re-sorting)
 *   POST /apps/setu-seller/reviews                                the signed-in buyer's review (seller, rating, comment, name, item)
 *
 * authenticate.public.appProxy checks Shopify's signature, so the shop and
 * logged_in_customer_id in the query are Shopify's word, not the browser's.
 * Who bought what is never taken from the browser: the buyer's orders are
 * read from Shopify and matched against the seller's shipped order lines.
 */

const BUYER_ORDERS = `#graphql
  query SetuBuyerOrders($query: String!) {
    orders(first: 100, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { id } }
  }`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

async function context(request: Request) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !isAllowedShop(session.shop)) throw json({ ok: false, error: "Reviews aren't available right now." }, 404);
  const url = new URL(request.url);
  const id = url.searchParams.get("logged_in_customer_id") ?? "";
  return { shop: session.shop, graphql: (admin?.graphql ?? null) as AdminGraphql | null, url, customerId: /^\d{1,19}$/.test(id) ? BigInt(id) : null };
}

/** The seller behind a store entry handle (what the theme knows the seller by). */
const findVendor = (shop: string, handle: string) =>
  handle && handle.length <= 255
    ? db.vendor.findFirst({ where: { shop, storeEntryHandle: handle }, select: { id: true, vendorName: true, status: true } })
    : Promise.resolve(null);

/** The buyer's orders, from Shopify. Null when Shopify can't be asked right now. */
async function buyerOrders(graphql: AdminGraphql | null, customerId: bigint): Promise<bigint[] | null> {
  if (!graphql) return null;
  try {
    const body = (await (await graphql(BUYER_ORDERS, { variables: { query: `customer_id:${customerId}` } })).json()) as { data?: { orders: { nodes: { id: string }[] } } };
    return body.data ? body.data.orders.nodes.map((o) => gidToId(o.id)) : null;
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const c = await context(request);
  const vendor = await findVendor(c.shop, c.url.searchParams.get("seller") ?? "");
  if (!vendor) return json({ ok: false, error: "This seller has no reviews page yet." }, 404);
  const list = await publicReviews(db, c.shop, vendor.id, Number(c.url.searchParams.get("page")) || 1, reviewSort(c.url.searchParams.get("sort")));
  // "Show more" and re-sorting need only the list: no need to ask Shopify for the buyer's orders again.
  if (list.page > 1 || c.url.searchParams.get("only") === "list") return json({ ok: true, ...list });

  let me: { signedIn: boolean; canReview?: boolean; unknown?: boolean; items?: { id: string; title: string }[]; review?: unknown } = { signedIn: false };
  if (c.customerId !== null) {
    const orders = await buyerOrders(c.graphql, c.customerId);
    me = orders === null
      ? { signedIn: true, canReview: false, unknown: true }
      : { signedIn: true, ...(await buyerState(db, c.shop, vendor, c.customerId, orders)) };
  }
  return json({ ok: true, ...list, me });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const c = await context(request);
  if (c.customerId === null) return json({ ok: false, error: "Sign in to your account to leave a review." }, 401);
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > 20_000) return json({ ok: false, error: "That review is too long." }, 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "The review didn't arrive. Please try again." }, 400);
  }
  const f = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const vendor = await findVendor(c.shop, f("seller"));
  if (!vendor) return json({ ok: false, error: "This seller can't be reviewed right now." }, 404);
  const orders = await buyerOrders(c.graphql, c.customerId);
  if (orders === null) return json({ ok: false, error: "We couldn't check your orders just now. Please try again in a minute." }, 503);

  const r = await submitReview(db, c.shop, { vendorId: vendor.id, customerId: c.customerId, orderIds: orders, rating: f("rating"), comment: f("comment"), authorName: f("name"), productId: f("item") });
  if (!r.ok) return json(r, 422);
  // The rating shown on the store follows. If this fails the review is still saved; the team sees why on the vendor page.
  void updateStoreListing(db, c.shop, vendor.id).catch(() => {});
  return json({ ok: true, replaced: r.replaced });
};
