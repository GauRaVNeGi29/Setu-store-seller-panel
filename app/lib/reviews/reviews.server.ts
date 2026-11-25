import type { PrismaClient } from "@prisma/client";
import { ANONYMOUS_AUTHOR, AUTHOR_MAX, COMMENT_MAX, HIDE_REASON_MAX, REVIEWS_PER_PAGE, type ReviewSummary } from "./rules";

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
};

const text = (v: unknown) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").trim();

/** Tidies the name a buyer wants shown: one line, no links, capped. */
export function displayAuthor(v: unknown): string {
  const name = text(v).replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, AUTHOR_MAX).trim();
  return name || ANONYMOUS_AUTHOR;
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

  const data = { rating, comment: comment || null, authorName: displayAuthor(input.authorName), orderId: order.orderId, orderName: order.orderName };
  const key = { shop_vendorId_customerId: { shop, vendorId: vendor.id, customerId: input.customerId } };
  const before = await db.vendorReview.findUnique({ where: key, select: { id: true } });
  // A review the team has hidden stays hidden when the buyer changes it.
  const saved = await db.vendorReview.upsert({
    where: key,
    create: { shop, vendorId: vendor.id, customerId: input.customerId, ...data },
    update: { ...data, editedAt: new Date() },
    select: { id: true },
  });
  await db.auditLog.create({
    data: { shop, actor: "buyer", action: before ? "review.changed" : "review.added", target: `vendor:${vendor.id}`, detail: { reviewId: saved.id, rating, order: order.orderName } },
  });
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

export type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  authorName: string;
  orderId: string;
  orderName: string;
  createdAt: string;
  edited: boolean;
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
      select: { id: true, rating: true, comment: true, authorName: true, orderId: true, orderName: true, createdAt: true, editedAt: true, status: true, hiddenReason: true, hiddenBy: true },
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
      edited: r.editedAt !== null,
      hidden: r.status === "hidden", hiddenReason: r.hiddenReason, hiddenBy: r.hiddenBy,
    })),
  };
}

/** The team hides a review (with a reason the vendor sees) or shows it again. */
export async function setReviewHidden(
  db: PrismaClient, shop: string, vendorId: string, reviewId: string, hide: boolean, actor: string, reason?: string | null,
): Promise<Result> {
  const review = await db.vendorReview.findFirst({ where: { id: reviewId, shop, vendorId }, select: { id: true, status: true } });
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
  return { ok: true };
}
