import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isAllowedShop } from "../lib/guard.server";
import type { AdminGraphql } from "../lib/orders/sync.server";
import { gidToId } from "../lib/orders/map";
import { buyerState, eligibleOrder, publicReviews, submitReview } from "../lib/reviews/reviews.server";
import { reviewSort } from "../lib/reviews/rules";
import { productCards } from "../lib/reviews/products.server";
import { updateStoreListing } from "../lib/storefront/update.server";

/**
 * Seller reviews for the storefront, reached through Shopify's app proxy:
 *   GET  /apps/setu-seller/reviews?seller=<entry handle>&page=1&sort=newest|highest|lowest
 *                                                                 published reviews, rating, and what this buyer can do
 *                                                                 (&only=list leaves the buyer part out: paging and re-sorting)
 *   POST /apps/setu-seller/reviews                                the signed-in buyer's review (seller, rating, comment, name,
 *                                                                 and "item" once for each product it is about)
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

const ORDER_PLACE = `#graphql
  query SetuOrderPlace($id: ID!) {
    order(id: $id) { displayAddress { city country } }
  }`;

/**
 * City and country from the address on one of the buyer's orders, shown
 * beside their name on the review. Best effort: reading addresses needs the
 * app's "protected customer data" access for addresses, so if Shopify says no
 * (or is slow) the review is saved without a place.
 */
async function orderPlace(graphql: AdminGraphql | null, orderId: bigint): Promise<{ city: string | null; country: string | null } | null> {
  if (!graphql) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const slow = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("slow")), 3000); });
    const answer = (async () => (await (await graphql(ORDER_PLACE, { variables: { id: `gid://shopify/Order/${orderId}` } })).json()) as { data?: { order: { displayAddress: { city: string | null; country: string | null } | null } | null } })();
    const body = await Promise.race([answer, slow]);
    return body.data?.order?.displayAddress ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
  const onlyList = list.page > 1 || c.url.searchParams.get("only") === "list";

  type Me = { signedIn: boolean; canReview?: boolean; unknown?: boolean; items?: { id: string; title: string }[]; review?: unknown };
  let me: Me = { signedIn: false };
  if (!onlyList && c.customerId !== null) {
    const orders = await buyerOrders(c.graphql, c.customerId);
    me = orders === null
      ? { signedIn: true, canReview: false, unknown: true }
      : { signedIn: true, ...(await buyerState(db, c.shop, vendor, c.customerId, orders)) };
  }

  // Each product a review is about, and each one the buyer can choose, gets its current title, picture and page.
  const cards = await productCards(c.graphql, c.shop, [...list.reviews.flatMap((r) => r.items.map((i) => i.id)), ...(me.items ?? []).map((i) => i.id)]);
  const card = (i: { id: string; title: string }) => {
    const k = cards.get(i.id);
    return { title: k?.title ?? i.title, url: k?.url ?? null, image: k?.image ?? null };
  };
  const shown = { ...list, reviews: list.reviews.map((r) => ({ ...r, items: r.items.map(card) })) };
  if (onlyList) return json({ ok: true, ...shown });
  return json({ ok: true, ...shown, me: me.items ? { ...me, items: me.items.map((i) => ({ id: i.id, ...card(i) })) } : me });
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

  // Where the buyer is, from the order that lets them review (the same one submitReview picks).
  const order = await eligibleOrder(db, c.shop, vendor.vendorName, orders);
  const buyerLocation = order ? await orderPlace(c.graphql, order.orderId) : null;
  const r = await submitReview(db, c.shop, { vendorId: vendor.id, customerId: c.customerId, orderIds: orders, buyerLocation, rating: f("rating"), comment: f("comment"), authorName: f("name"), productIds: form.getAll("item").filter((v): v is string => typeof v === "string") });
  if (!r.ok) return json(r, 422);
  // The rating shown on the store follows. If this fails the review is still saved; the team sees why on the vendor page.
  void updateStoreListing(db, c.shop, vendor.id).catch(() => {});
  return json({ ok: true, replaced: r.replaced });
};
