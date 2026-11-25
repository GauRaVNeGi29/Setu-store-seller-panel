import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";

/**
 * Buyers' reviews of vendors, on the dev store's five test orders:
 *   #1004  Urban Store shipped, Ashnur not shipped
 *   #1003  both vendors, nothing shipped       #1005  cancelled
 * So a buyer of #1004 can review Urban Store and nobody can review Ashnur yet.
 */
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: async () => { throw new Error("not used"); } },
  authenticate: {
    admin: async () => ({ session: { shop: "seller-panel-dev.myshopify.com", onlineAccessInfo: { associated_user: { email: "team@setustore.test" } } }, admin: {} }),
  },
}));

const { saveOrder } = await import("../app/lib/orders/sync.server");
const { submitReview, reviewSummary, vendorReviews, setReviewHidden, eligibleOrder, displayAuthor } = await import("../app/lib/reviews/reviews.server");
const { COMMENT_MAX, REVIEWS_PER_PAGE } = await import("../app/lib/reviews/rules");
const { enableVendor, addVendorUser, setVendorStatus } = await import("../app/lib/vendors/vendors.server");
const { signUp, createTeamHandoff, redeemTeamHandoff, COOKIE_NAME } = await import("../app/lib/portal/auth.server");
const { listAllVendors } = await import("../app/lib/vendors/team.server");
const { syncListing, resetDefinitionCache } = await import("../app/lib/storefront/listing.server");
const reviewsPage = await import("../app/routes/portal.reviews");
const dashboard = await import("../app/routes/portal._index");
const vendorPage = await import("../app/routes/app.vendor");

const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
const O = { n1001: 19043720134765n, n1003: 19043720298605n, n1004: 19043720364141n, n1005: 19043720462445n };
const PW = "Strong-test-password-1";

async function cleanup() {
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.portalHandoff.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } }); // reviews go with their vendor
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
}
let urban: string;
let ashnur: string;
beforeEach(async () => {
  await cleanup();
  for (const o of structuredClone(fixture.orders) as ShopifyOrder[]) await saveOrder(db, shop, o, "test");
  urban = (await enableVendor(db, shop, "Urban Store", "test")).id;
  ashnur = (await enableVendor(db, shop, "Ashnur", "test")).id;
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

const review = (over: Record<string, unknown> = {}) =>
  submitReview(db, shop, { vendorId: urban, customerId: 501n, orderIds: [O.n1004], rating: 5, comment: "Lovely finish, well packed.", authorName: "Meera", ...over });

describe("who can review", () => {
  it("a buyer whose order from the vendor has shipped", async () => {
    expect(await review()).toMatchObject({ ok: true, replaced: false });
    const saved = await db.vendorReview.findFirstOrThrow({ where: { shop, vendorId: urban } });
    expect([saved.rating, saved.comment, saved.authorName, saved.orderName, saved.status]).toEqual([5, "Lovely finish, well packed.", "Meera", "#1004", "published"]);
  });

  it("not before anything has shipped, not for a cancelled order, not with someone else's seller", async () => {
    const no = /once an order from them has shipped/;
    for (const orderIds of [[O.n1001], [O.n1003], [O.n1005], []]) {
      const r = await review({ orderIds });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(no);
    }
    // #1004 shipped for Urban Store only: the same buyer can't review Ashnur with it.
    expect(await review({ vendorId: ashnur })).toMatchObject({ ok: false });
    expect(await db.vendorReview.count({ where: { shop } })).toBe(0);
  });

  it("uses the most recent shipped order when the buyer has several", async () => {
    expect(await eligibleOrder(db, shop, "Urban Store", [O.n1001, O.n1004, O.n1005])).toMatchObject({ orderName: "#1004" });
    expect(await eligibleOrder(db, shop, "Ashnur", [O.n1001, O.n1004, O.n1005])).toBeNull();
  });

  it("not a paused vendor, an unknown vendor or another store's vendor", async () => {
    await setVendorStatus(db, shop, urban, "paused", "test");
    expect(await review()).toMatchObject({ ok: false });
    expect(await review({ vendorId: "nope" })).toMatchObject({ ok: false });
    expect(await submitReview(db, "someone-else.myshopify.com", { vendorId: ashnur, customerId: 1n, orderIds: [O.n1004], rating: 5 })).toMatchObject({ ok: false });
  });
});

describe("what a review holds", () => {
  it("needs 1 to 5 whole stars", async () => {
    for (const rating of [0, 6, 4.5, "", "five", null, undefined, "50"]) expect((await review({ rating })).ok).toBe(false);
    expect((await review({ rating: "4" })).ok).toBe(true);
    expect((await db.vendorReview.findFirstOrThrow({ where: { shop } })).rating).toBe(4);
  });

  it("comment is optional, trimmed and capped", async () => {
    expect((await review({ comment: "x".repeat(COMMENT_MAX + 1) })).ok).toBe(false);
    expect((await review({ comment: "   " })).ok).toBe(true);
    expect((await db.vendorReview.findFirstOrThrow({ where: { shop } })).comment).toBeNull();
  });

  it("shows the name the buyer chose, or 'Verified buyer'", () => {
    expect(displayAuthor("  Meera   K. ")).toBe("Meera K.");
    expect(displayAuthor("")).toBe("Verified buyer");
    expect(displayAuthor(undefined)).toBe("Verified buyer");
    expect(displayAuthor("visit https://spam.example now")).toBe("visit now");
    expect(displayAuthor("x".repeat(80))).toHaveLength(40);
  });

  it("one per buyer per vendor: a second one replaces the first and is marked edited", async () => {
    await review();
    expect(await review({ rating: 2, comment: "Changed my mind." })).toMatchObject({ ok: true, replaced: true });
    const list = await vendorReviews(db, shop, urban);
    expect(list.total).toBe(1);
    expect(list.reviews[0]).toMatchObject({ rating: 2, comment: "Changed my mind.", edited: true });
    // A different buyer adds a second review.
    await review({ customerId: 502n, rating: 4 });
    expect((await vendorReviews(db, shop, urban)).total).toBe(2);
  });
});

describe("rating", () => {
  it("averages published reviews to one decimal, with a breakdown", async () => {
    expect(await reviewSummary(db, shop, urban)).toEqual({ count: 0, average: null, breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    for (const [customerId, rating] of [[1n, 5], [2n, 5], [3n, 4], [4n, 3]] as const) await review({ customerId, rating });
    expect(await reviewSummary(db, shop, urban)).toEqual({ count: 4, average: "4.3", breakdown: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 } }); // 17 / 4 = 4.25
    expect(await reviewSummary(db, shop, ashnur)).toMatchObject({ count: 0, average: null });
    expect((await listAllVendors(db, shop)).map((v) => [v.vendorName, v.rating])).toEqual([["Ashnur", null], ["Urban Store", { average: "4.3", count: 4 }]]);
  });

  it("a hidden review isn't counted, needs a reason, and comes back when shown again", async () => {
    await review({ customerId: 1n, rating: 5 });
    await review({ customerId: 2n, rating: 1, comment: "Rude words here" });
    const bad = (await db.vendorReview.findFirstOrThrow({ where: { shop, customerId: 2n } })).id;
    expect(await setReviewHidden(db, shop, urban, bad, true, "admin:team@setustore.test", "  ")).toMatchObject({ ok: false });
    expect(await setReviewHidden(db, shop, ashnur, bad, true, "admin:x", "wrong vendor")).toMatchObject({ ok: false });
    expect(await setReviewHidden(db, shop, urban, bad, true, "admin:team@setustore.test", "Abusive language")).toEqual({ ok: true });
    expect(await reviewSummary(db, shop, urban)).toMatchObject({ count: 1, average: "5.0" });
    const list = await vendorReviews(db, shop, urban);
    expect([list.total, list.hidden]).toEqual([2, 1]);
    expect(list.reviews.find((r) => r.id === bad)).toMatchObject({ hidden: true, hiddenReason: "Abusive language", edited: false });

    // The buyer changing a hidden review doesn't publish it again.
    await review({ customerId: 2n, rating: 1, comment: "Still rude" });
    expect((await db.vendorReview.findUniqueOrThrow({ where: { id: bad } })).status).toBe("hidden");

    expect(await setReviewHidden(db, shop, urban, bad, false, "admin:team@setustore.test")).toEqual({ ok: true });
    expect(await reviewSummary(db, shop, urban)).toMatchObject({ count: 2, average: "3.0" });
    expect((await db.auditLog.findMany({ where: { shop, action: { startsWith: "review." } }, orderBy: { at: "asc" } })).map((a) => a.action))
      .toEqual(["review.added", "review.added", "review.hidden", "review.changed", "review.shown"]);
  });

  it("is copied to the store listing, and cleared when the last review is hidden", async () => {
    resetDefinitionCache();
    const entries = new Map<string, Record<string, string>>();
    const keys = ["vendor_name", "minimum_order_value", "collection"]; // the app adds the rest
    const graphql = async (query: string, o?: { variables?: Record<string, any> }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const v = o?.variables ?? {};
      const op = /(?:query|mutation) (\w+)/.exec(query)?.[1];
      const ok = (data: unknown) => ({ json: async () => ({ data }) });
      if (op === "SetuSellerDefinition") return ok({ metaobjectDefinitionByType: { id: "d", capabilities: { publishable: { enabled: false } }, fieldDefinitions: keys.map((key) => ({ key })) } });
      if (op === "SetuSellerDefinitionUpdate") return ok({ metaobjectDefinitionUpdate: { metaobjectDefinition: { id: "d" }, userErrors: [] } });
      if (op === "SetuOnlineStorePublication") return ok({ publications: { nodes: [{ id: "p", catalog: { apps: { nodes: [{ handle: "online_store" }] } } }] } });
      if (op === "SetuSellerCollectionFind") return ok({ collectionByIdentifier: null, productsCount: { count: 0 } });
      if (op === "SetuSellerCollectionCreate") return ok({ collectionCreate: { collection: { id: "gid://shopify/Collection/9", handle: "urban-store" }, userErrors: [] } });
      if (op === "SetuSellerCollectionPublish") return ok({ publishablePublish: { userErrors: [] } });
      if (op === "SetuSellerCollectionCheck") return ok({ collection: { id: "gid://shopify/Collection/9", publishedOnPublication: true } });
      if (op === "SetuSellerEntries") return ok({ metaobjects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
      if (op === "SetuSellerEntry") {
        const e = entries.get(v.handle.handle);
        return ok({ metaobjectByHandle: e ? { id: "e", handle: v.handle.handle, fields: Object.entries(e).map(([key, value]) => ({ key, value })) } : null });
      }
      if (op === "SetuSellerUpsert") {
        const e = entries.get(v.handle.handle) ?? {};
        for (const f of v.metaobject.fields as { key: string; value: string }[]) {
          if (f.value === "") delete e[f.key];
          else e[f.key] = f.value;
        }
        entries.set(v.handle.handle, e);
        return ok({ metaobjectUpsert: { metaobject: { id: "e", handle: v.handle.handle }, userErrors: [] } });
      }
      throw new Error(`unexpected ${op}`);
    };
    await review({ customerId: 1n, rating: 4 });
    await review({ customerId: 2n, rating: 5 });
    expect(await syncListing(db, graphql, shop, urban)).toMatchObject({ ok: true });
    expect(entries.get("urban-store")).toMatchObject({ rating: "4.5", review_count: "2" });
    expect(await syncListing(db, graphql, shop, urban)).toMatchObject({ changed: [] });

    for (const r of await db.vendorReview.findMany({ where: { shop } })) await setReviewHidden(db, shop, urban, r.id, true, "admin:x", "test");
    expect(await syncListing(db, graphql, shop, urban)).toMatchObject({ changed: ["rating", "review_count"] });
    expect(entries.get("urban-store")).not.toHaveProperty("rating");
    expect(entries.get("urban-store")).not.toHaveProperty("review_count");
    resetDefinitionCache();
  });
});

// ---------------------------------------------------------------------------
// Through the pages
// ---------------------------------------------------------------------------

type Fn = (a: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
async function run(fn: unknown, request: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loader/action data, checked field by field
    return { data: (await (fn as Fn)({ request, params: {}, context: {} })) as Record<string, any> };
  } catch (e) {
    if (e instanceof Response) return { status: e.status, location: e.headers.get("Location") };
    throw e;
  }
}
async function signedIn(vendorId: string, email: string) {
  await addVendorUser(db, shop, vendorId, email, "Owner", "test");
  const su = await signUp(db, { name: "Owner", email, password: PW, phone: "+91 98765 43210" }, { shop });
  if (!su.ok) throw new Error("sign-up failed");
  return `${COOKIE_NAME}=${encodeURIComponent(su.token)}`;
}
const portal = (path: string, cookie?: string, init: RequestInit = {}) =>
  new Request(`https://portal.test${path}`, { ...init, headers: cookie ? { Cookie: cookie } : {} });
const admin = (path: string, fields?: Record<string, string>) =>
  new Request(`https://app.test${path}`, fields ? { method: "POST", body: new URLSearchParams(fields) } : undefined);

describe("seller's Reviews page", () => {
  it("shows the seller their own reviews only, without who the buyer is", async () => {
    await review({ customerId: 777123n });
    const urbanCookie = await signedIn(urban, "owner@urban.example");
    const ashnurCookie = await signedIn(ashnur, "owner@ashnur.example");

    const mine = await run(reviewsPage.loader, portal("/portal/reviews", urbanCookie));
    expect(mine.data).toMatchObject({ total: 1, hidden: 0, page: 1, pages: 1, summary: { count: 1, average: "5.0" } });
    expect(mine.data?.reviews[0]).toMatchObject({ rating: 5, authorName: "Meera", orderName: "#1004", orderId: String(O.n1004), hidden: false });
    expect(JSON.stringify(mine.data)).not.toContain("777123");
    expect(JSON.stringify(mine.data)).not.toContain("customerId");

    const theirs = await run(reviewsPage.loader, portal("/portal/reviews", ashnurCookie));
    expect(theirs.data).toMatchObject({ total: 0, reviews: [], summary: { count: 0, average: null } });

    expect((await run(dashboard.loader, portal("/portal", urbanCookie))).data?.reviews).toEqual({ count: 1, average: "5.0" });
    expect((await run(dashboard.loader, portal("/portal", ashnurCookie))).data?.reviews).toEqual({ count: 0, average: null });
  });

  it("needs sign-in, and has nothing a seller can change", async () => {
    expect(await run(reviewsPage.loader, portal("/portal/reviews"))).toMatchObject({ status: 302, location: expect.stringContaining("/portal/login") });
    expect("action" in reviewsPage).toBe(false);
  });

  it("pages through many reviews, newest first", async () => {
    for (let i = 1; i <= REVIEWS_PER_PAGE + 3; i++) await review({ customerId: BigInt(i), rating: (i % 5) + 1, comment: `Review ${i}` });
    const cookie = await signedIn(urban, "owner@urban.example");
    const p1 = (await run(reviewsPage.loader, portal("/portal/reviews", cookie))).data!;
    const p2 = (await run(reviewsPage.loader, portal("/portal/reviews?page=2", cookie))).data!;
    expect([p1.pages, p1.reviews.length, p2.reviews.length]).toEqual([2, REVIEWS_PER_PAGE, 3]);
    expect(p1.reviews[0].comment).toBe(`Review ${REVIEWS_PER_PAGE + 3}`);
    expect((await run(reviewsPage.loader, portal("/portal/reviews?page=99", cookie))).data?.page).toBe(2);
  });

  it("the team's read-only view can open it too", async () => {
    await review();
    await signedIn(urban, "owner@urban.example");
    const handoff = await createTeamHandoff(db, shop, urban, "admin:team@setustore.test");
    if (!handoff.ok) throw new Error("no handoff");
    const view = await redeemTeamHandoff(db, handoff.token, { shop });
    if (!view) throw new Error("handoff not redeemed");
    const page = await run(reviewsPage.loader, portal("/portal/reviews", `${COOKIE_NAME}=${encodeURIComponent(view.token)}`));
    expect(page.data).toMatchObject({ total: 1 });
  });
});

describe("team's review controls", () => {
  it("lists a vendor's reviews; hiding needs a reason and takes the review out of the rating", async () => {
    await review({ customerId: 1n, rating: 5 });
    await review({ customerId: 2n, rating: 2, comment: "Not about this seller" });
    const id = (await db.vendorReview.findFirstOrThrow({ where: { shop, customerId: 2n } })).id;

    const page = await run(vendorPage.loader, admin("/app/vendor?name=Urban%20Store"));
    expect(page.data?.reviews).toMatchObject({ total: 2, hidden: 0, summary: { average: "3.5", count: 2 } });
    expect(JSON.stringify(page.data?.reviews)).not.toContain("customerId");

    const post = (fields: Record<string, string>) => run(vendorPage.action, admin("/app/vendor", { name: "Urban Store", ...fields }));
    expect((await post({ intent: "hide_review", reviewId: id, reason: "" })).data).toMatchObject({ ok: false });
    expect((await post({ intent: "hide_review", reviewId: id, reason: "About a different seller" })).data).toMatchObject({ ok: true, message: expect.stringContaining("Review hidden") });
    expect((await run(vendorPage.loader, admin("/app/vendor?name=Urban%20Store"))).data?.reviews).toMatchObject({ hidden: 1, summary: { average: "5.0", count: 1 } });
    expect((await db.vendorReview.findUniqueOrThrow({ where: { id } })).hiddenBy).toBe("admin:team@setustore.test");

    // Another vendor's page can't touch it.
    expect((await run(vendorPage.action, admin("/app/vendor", { name: "Ashnur", intent: "show_review", reviewId: id }))).data).toMatchObject({ ok: false });
    expect((await post({ intent: "show_review", reviewId: id })).data).toMatchObject({ ok: true, message: "Review shown again" });
    expect(await reviewSummary(db, shop, urban)).toMatchObject({ count: 2 });
  });
});
