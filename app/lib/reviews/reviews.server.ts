import type { PrismaClient } from "@prisma/client";
import { ANONYMOUS_AUTHOR, AUTHOR_MAX, COMMENT_MAX, HIDE_REASON_MAX, LOCATION_MAX, PUBLIC_PAGE, REVIEW_ITEMS_MAX, REVIEWS_PER_PAGE, type ReviewSort, type ReviewSummary } from "./rules";
import { mailReview, mailReviewVisibility } from "../mail/notify.server";

/**
 * Buyers' ratings of vendors.
 *
 *  - Only a buyer with a shipped, not-cancelled order from the vendor can
 *    review them. The caller says which orders are the buyer's (from Shopify);
 *    the check against the vendor's order lines happens here.
 *  - One review per buyer per vendor. Sending another replaces it.
 *  - Reviews are published at once. The Setu Store team can hide one; a hidden
 *    review isn't counted in the rating and isn't shown to buyers, but the
 *    vendor still sees it, marked as hidden.
 *  - The vendor never learns who the buyer is: only the name the buyer chose
 *    to show and the order number.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type ReviewInput = {
  vendorId: string;
  customerId: bigint;
  /** The buyer's orders, as Shopify reports them. */
  orderIds: bigint[];
  rating: unknown;
  comment?: unknown;
  /** Name to show with the review. Empty shows "Verified buyer". */
  authorName?: unknown;
  /** The products the review is about: each must be one the buyer bought from this vendor. Optional. */
  productIds?: unknown;
  /**
   * Where the buyer is: city and country from the address on their order, as
   * Shopify reports it (never from the browser). Null when it isn't known.
   */
  buyerLocation?: { city?: string | null; country?: string | null } | null;
};

const text = (v: unknown) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").trim();

/** Tidies the name a buyer wants shown: one line, no links, capped. */
export function displayAuthor(v: unknown): string {
  const name = text(v).replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, AUTHOR_MAX).trim();
  return name || ANONYMOUS_AUTHOR;
}

/** "Bengaluru, India": city and country on one line, or null when neither is known. */
export function buyerLocationText(place: ReviewInput["buyerLocation"]): string | null {
  const part = (v: unknown) => text(v).replace(/\s+/g, " ").replace(/[<>]/g, "");
  const line = [part(place?.city), part(place?.country)].filter(Boolean).join(", ").slice(0, LOCATION_MAX).trim();
  return line || null;
}

/** The buyer's most recent order that includes shipped items from this vendor, if any. */
export async function eligibleOrder(db: PrismaClient, shop: string, vendorName: string, orderIds: bigint[]) {
  if (!orderIds.length) return null;
  const line = await db.vendorOrderLine.findFirst({
    where: { shop, vendorName, orderId: { in: orderIds }, orderCancelled: false, fulfilledQuantity: { gt: 0 } },
    orderBy: { orderCreatedAt: "desc" },
    select: { orderId: true, orderName: true },
  });
  return line;
}

/** The products from this vendor that have shipped to the buyer, newest order first: what a review can be "about". */
export async function eligibleItems(db: PrismaClient, shop: string, vendorName: string, orderIds: bigint[]) {
  if (!orderIds.length) return [];
  const lines = await db.vendorOrderLine.findMany({
    where: { shop, vendorName, orderId: { in: orderIds }, orderCancelled: false, fulfilledQuantity: { gt: 0 }, productId: { not: null } },
    orderBy: [{ orderCreatedAt: "desc" }, { title: "asc" }],
    select: { productId: true, title: true },
  });
  const seen = new Set<string>();
  const items: { id: string; title: string }[] = [];
  for (const l of lines) {
    const id = l.productId!.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, title: l.title });
  }
  return items;
}

/** Adds the buyer's review of a vendor, or replaces the one they already left. */
export async function submitReview(db: PrismaClient, shop: string, input: ReviewInput): Promise<Result<{ id: string; replaced: boolean }>> {
  const vendor = await db.vendor.findFirst({ where: { id: input.vendorId, shop }, select: { id: true, vendorName: true, status: true } });
  if (!vendor || vendor.status !== "active") return { ok: false, error: "This seller can't be reviewed right now." };

  const rating = typeof input.rating === "string" && /^[1-5]$/.test(input.rating.trim()) ? Number(input.rating) : input.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: "Choose a rating from 1 to 5 stars." };
  const comment = text(input.comment);
  if (comment.length > COMMENT_MAX) return { ok: false, error: `Keep your review under ${COMMENT_MAX} characters.` };

  const order = await eligibleOrder(db, shop, vendor.vendorName, input.orderIds);
  if (!order) return { ok: false, error: "You can review a seller once an order from them has shipped." };

  // Which products it is about: only ones this buyer has received from this vendor, each once, in the order chosen.
  const wanted = [...new Set((Array.isArray(input.productIds) ? input.productIds : [input.productIds])
    .map((v) => (typeof v === "string" || typeof v === "bigint" ? String(v).trim() : "")).filter(Boolean))];
  if (wanted.length > REVIEW_ITEMS_MAX) return { ok: false, error: `Choose up to ${REVIEW_ITEMS_MAX} products.` };
  let items: { id: string; title: string }[] = [];
  if (wanted.length) {
    const bought = await eligibleItems(db, shop, vendor.vendorName, input.orderIds);
    items = wanted.map((id) => bought.find((i) => i.id === id)).filter((i): i is { id: string; title: string } => !!i);
    if (items.length !== wanted.length) return { ok: false, error: "Choose from the items you bought from this seller." };
  }

  const data = { rating, comment: comment || null, authorName: displayAuthor(input.authorName), orderId: order.orderId, orderName: order.orderName };
  const key = { shop_vendorId_customerId: { shop, vendorId: vendor.id, customerId: input.customerId } };
  const before = await db.vendorReview.findUnique({ where: key, select: { id: true, rating: true } });
  // A review the team has hidden stays hidden when the buyer changes it.
  const rows = items.map((i, position) => ({ productId: BigInt(i.id), title: i.title, position }));
  const where = buyerLocationText(input.buyerLocation);
  const saved = await db.vendorReview.upsert({
    where: key,
    create: { shop, vendorId: vendor.id, customerId: input.customerId, ...data, buyerLocation: where, items: { create: rows } },
    // If the place couldn't be read this time, the one saved before stays.
    update: { ...data, ...(where ? { buyerLocation: where } : {}), editedAt: new Date(), items: { deleteMany: {}, create: rows } },
    select: { id: true },
  });
  await db.auditLog.create({
    data: { shop, actor: "buyer", action: before ? "review.changed" : "review.added", target: `vendor:${vendor.id}`, detail: { reviewId: saved.id, rating, order: order.orderName } },
  });
  await mailReview(db, shop, vendor.id, { rating, comment: data.comment, author: data.authorName }, before?.rating ?? null);
  return { ok: true, id: saved.id, replaced: !!before };
}

/** Rating from published reviews only. */
export async function reviewSummary(db: PrismaClient, shop: string, vendorId: string): Promise<ReviewSummary> {
  const groups = await db.vendorReview.groupBy({ by: ["rating"], where: { shop, vendorId, status: "published" }, _count: { _all: true } });
  const breakdown: ReviewSummary["breakdown"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const g of groups) {
    if (g.rating < 1 || g.rating > 5) continue;
    breakdown[g.rating as 1 | 2 | 3 | 4 | 5] = g._count._all;
    count += g._count._all;
    sum += g.rating * g._count._all;
  }
  return { count, average: count ? (Math.round((sum / count) * 10) / 10).toFixed(1) : null, breakdown };
}

const ITEMS = { orderBy: { position: "asc" as const }, select: { productId: true, title: true } };

export type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  authorName: string;
  orderId: string;
  orderName: string;
  createdAt: string;
  edited: boolean;
  /** The products the buyer said the review is about (titles), if they chose any. */
  items: string[];
  /** The buyer's city and country, as shown on the store. */
  location: string | null;
  hidden: boolean;
  hiddenReason: string | null;
  hiddenBy: string | null;
};

/**
 * A vendor's reviews, newest first: for the vendor's own Reviews page and for
 * the team. Includes hidden ones (marked). Never includes who the buyer is.
 */
export async function vendorReviews(db: PrismaClient, shop: string, vendorId: string, page = 1) {
  const where = { shop, vendorId };
  const [total, hidden, rows, summary] = await Promise.all([
    db.vendorReview.count({ where }),
    db.vendorReview.count({ where: { ...where, status: "hidden" } }),
    db.vendorReview.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (Math.max(1, page) - 1) * REVIEWS_PER_PAGE, take: REVIEWS_PER_PAGE,
      select: { id: true, rating: true, comment: true, authorName: true, orderId: true, orderName: true, createdAt: true, editedAt: true, status: true, hiddenReason: true, hiddenBy: true, buyerLocation: true, items: ITEMS },
    }),
    reviewSummary(db, shop, vendorId),
  ]);
  const pages = Math.max(1, Math.ceil(total / REVIEWS_PER_PAGE));
  return {
    summary, total, hidden, page: Math.min(Math.max(1, page), pages), pages,
    reviews: rows.map((r): ReviewRow => ({
      id: r.id, rating: r.rating, comment: r.comment, authorName: r.authorName,
      orderId: r.orderId.toString(), orderName: r.orderName,
      createdAt: r.createdAt.toISOString(),
      edited: r.editedAt !== null, items: r.items.map((i) => i.title), location: r.buyerLocation,
      hidden: r.status === "hidden", hiddenReason: r.hiddenReason, hiddenBy: r.hiddenBy,
    })),
  };
}

export type TeamReviewFilter = { vendorId?: string; status?: "published" | "hidden"; rating?: number; page?: number };

/**
 * Every seller's reviews in one list, newest first, for the team's Reviews
 * page. Can be narrowed to one seller, to published or hidden, or to a number
 * of stars. Each row says which seller it is about.
 */
export async function teamReviews(db: PrismaClient, shop: string, filter: TeamReviewFilter = {}) {
  const where = {
    shop,
    ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.rating ? { rating: filter.rating } : {}),
  };
  const total = await db.vendorReview.count({ where });
  const pages = Math.max(1, Math.ceil(total / REVIEWS_PER_PAGE));
  const page = Math.min(Math.max(1, Math.floor(filter.page ?? 1) || 1), pages);
  const rows = await db.vendorReview.findMany({
    where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * REVIEWS_PER_PAGE, take: REVIEWS_PER_PAGE,
    select: {
      id: true, rating: true, comment: true, authorName: true, orderId: true, orderName: true, createdAt: true, editedAt: true, status: true,
      hiddenReason: true, hiddenBy: true, buyerLocation: true, items: ITEMS, vendor: { select: { id: true, vendorName: true, displayName: true } },
    },
  });
  return {
    total, page, pages,
    reviews: rows.map((r) => ({
      id: r.id, rating: r.rating, comment: r.comment, authorName: r.authorName,
      orderId: r.orderId.toString(), orderName: r.orderName, createdAt: r.createdAt.toISOString(),
      edited: r.editedAt !== null, items: r.items.map((i) => i.title), location: r.buyerLocation,
      hidden: r.status === "hidden", hiddenReason: r.hiddenReason, hiddenBy: r.hiddenBy,
      vendor: { id: r.vendor.id, vendorName: r.vendor.vendorName, name: r.vendor.displayName },
    })),
  };
}

/** The store's reviews in numbers, and each seller's rating: for the team's Reviews page and Dashboard. */
export async function reviewNumbers(db: PrismaClient, shop: string, now = new Date()) {
  const month = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [groups, recent, vendors] = await Promise.all([
    db.vendorReview.groupBy({ by: ["vendorId", "status"], where: { shop }, _count: { _all: true }, _sum: { rating: true } }),
    db.vendorReview.count({ where: { shop, createdAt: { gte: month } } }),
    db.vendor.findMany({ where: { shop }, select: { id: true, vendorName: true, displayName: true }, orderBy: { displayName: "asc" } }),
  ]);
  const by = new Map<string, { published: number; hidden: number; stars: number }>();
  for (const g of groups) {
    const v = by.get(g.vendorId) ?? { published: 0, hidden: 0, stars: 0 };
    if (g.status === "published") { v.published += g._count._all; v.stars += g._sum.rating ?? 0; } else v.hidden += g._count._all;
    by.set(g.vendorId, v);
  }
  const all = [...by.values()];
  const published = all.reduce((n, v) => n + v.published, 0);
  const stars = all.reduce((n, v) => n + v.stars, 0);
  const average = (count: number, sum: number) => (count ? (Math.round((sum / count) * 10) / 10).toFixed(1) : null);
  return {
    published, hidden: all.reduce((n, v) => n + v.hidden, 0), average: average(published, stars), last30Days: recent,
    /** Sellers that have any review, by name. */
    vendors: vendors.filter((v) => by.has(v.id)).map((v) => {
      const n = by.get(v.id)!;
      return { id: v.id, vendorName: v.vendorName, name: v.displayName, published: n.published, hidden: n.hidden, average: average(n.published, n.stars) };
    }),
  };
}

/** The team hides a review (with a reason the vendor sees) or shows it again. */
export async function setReviewHidden(
  db: PrismaClient, shop: string, vendorId: string, reviewId: string, hide: boolean, actor: string, reason?: string | null,
): Promise<Result> {
  const review = await db.vendorReview.findFirst({ where: { id: reviewId, shop, vendorId }, select: { id: true, status: true, rating: true } });
  if (!review) return { ok: false, error: "Review not found" };
  const why = text(reason).slice(0, HIDE_REASON_MAX) || null;
  if (hide && !why) return { ok: false, error: "Say why you're hiding this review. The vendor sees the reason." };
  if ((review.status === "hidden") === hide) return { ok: true };
  await db.$transaction([
    db.vendorReview.update({
      where: { id: review.id },
      data: hide
        ? { status: "hidden", hiddenBy: actor, hiddenAt: new Date(), hiddenReason: why }
        : { status: "published", hiddenBy: null, hiddenAt: null, hiddenReason: null },
    }),
    db.auditLog.create({ data: { shop, actor, action: hide ? "review.hidden" : "review.shown", target: `vendor:${vendorId}`, detail: { reviewId: review.id, reason: why } } }),
  ]);
  await mailReviewVisibility(db, shop, vendorId, { rating: review.rating, hidden: hide, reason: why });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

/** `items` are the products the review is about: id and the title on the buyer's order. The route adds picture and link. */
export type PublicReview = { rating: number; comment: string | null; author: string; location: string | null; date: string; edited: boolean; items: { id: string; title: string }[] };

/** Published reviews for the store's seller page, newest first. Nothing that identifies the buyer or the order. */
export async function publicReviews(db: PrismaClient, shop: string, vendorId: string, page = 1, sort: ReviewSort = "newest") {
  const where = { shop, vendorId, status: "published" as const };
  const p = Math.max(1, Math.floor(page) || 1);
  // Within the same number of stars, newest first; id settles ties so pages never repeat a review.
  const newest = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const orderBy = sort === "highest" ? [{ rating: "desc" as const }, ...newest] : sort === "lowest" ? [{ rating: "asc" as const }, ...newest] : newest;
  const [rows, summary] = await Promise.all([
    db.vendorReview.findMany({
      where, orderBy, skip: (p - 1) * PUBLIC_PAGE, take: PUBLIC_PAGE + 1,
      select: { rating: true, comment: true, authorName: true, buyerLocation: true, createdAt: true, editedAt: true, items: ITEMS },
    }),
    reviewSummary(db, shop, vendorId),
  ]);
  return {
    summary, page: p, sort, more: rows.length > PUBLIC_PAGE,
    reviews: rows.slice(0, PUBLIC_PAGE).map((r): PublicReview => ({
      rating: r.rating, comment: r.comment, author: r.authorName, location: r.buyerLocation, date: r.createdAt.toISOString(), edited: r.editedAt !== null,
      items: r.items.map((i) => ({ id: i.productId.toString(), title: i.title })),
    })),
  };
}

/** What a signed-in buyer can do on a seller's page: whether they can review, about which items, and their own review. */
export async function buyerState(db: PrismaClient, shop: string, vendor: { id: string; vendorName: string; status: string }, customerId: bigint, orderIds: bigint[]) {
  const [order, items, mine] = await Promise.all([
    vendor.status === "active" ? eligibleOrder(db, shop, vendor.vendorName, orderIds) : Promise.resolve(null),
    eligibleItems(db, shop, vendor.vendorName, orderIds),
    db.vendorReview.findUnique({
      where: { shop_vendorId_customerId: { shop, vendorId: vendor.id, customerId } },
      select: { rating: true, comment: true, authorName: true, status: true, items: ITEMS },
    }),
  ]);
  return {
    canReview: !!order,
    items: order ? items : [],
    review: mine && {
      rating: mine.rating, comment: mine.comment ?? "", name: mine.authorName === ANONYMOUS_AUTHOR ? "" : mine.authorName,
      items: mine.items.map((i) => i.productId.toString()), hidden: mine.status === "hidden",
    },
  };
}
