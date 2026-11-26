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
// What Shopify's app proxy tells the app: which shop, and (inside the request's query) which signed-in customer.
const proxy = vi.hoisted(() => ({
  shop: "seller-panel-dev.myshopify.com" as string | null, orders: {} as Record<string, string[]>, down: false, asked: [] as string[],
  /** What Shopify knows about products, by id: missing means deleted. */
  products: {} as Record<string, { handle: string; title: string; status: string; image: string | null }>,
  productsDown: false,
}));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: async () => { throw new Error("not used"); } },
  authenticate: {
    public: {
      appProxy: async () => ({
        session: proxy.shop ? { shop: proxy.shop } : undefined,
        admin: {
          graphql: async (q: string, o: { variables: { query: string; ids?: string[] } }) => {
            if (q.includes("SetuReviewProducts")) {
              proxy.asked.push(`products:${o.variables.ids!.length}`);
              if (proxy.productsDown) throw new Error("Shopify is unreachable");
              return { json: async () => ({ data: { nodes: o.variables.ids!.map((gid) => {
                const p = proxy.products[gid.split("/").pop()!];
                return p ? { id: gid, handle: p.handle, title: p.title, status: p.status, featuredMedia: p.image ? { preview: { image: { url: p.image } } } : null } : null;
              }) } }) };
            }
            if (proxy.down) throw new Error("Shopify is unreachable");
            proxy.asked.push(o.variables.query);
            const id = o.variables.query.replace("customer_id:", "");
            return { json: async () => ({ data: { orders: { nodes: (proxy.orders[id] ?? []).map((n) => ({ id: `gid://shopify/Order/${n}` })) } } }) };
          },
        },
      }),
    },
    admin: async () => ({ session: { shop: "seller-panel-dev.myshopify.com", onlineAccessInfo: { associated_user: { email: "team@setustore.test" } } }, admin: {} }),
  },
}));

const { saveOrder } = await import("../app/lib/orders/sync.server");
const { submitReview, reviewSummary, vendorReviews, setReviewHidden, eligibleOrder, displayAuthor } = await import("../app/lib/reviews/reviews.server");
const { COMMENT_MAX, REVIEWS_PER_PAGE } = await import("../app/lib/reviews/rules");
const { forgetProductCards } = await import("../app/lib/reviews/products.server");
const { enableVendor, addVendorUser, setVendorStatus } = await import("../app/lib/vendors/vendors.server");
const { signUp, createTeamHandoff, redeemTeamHandoff, COOKIE_NAME } = await import("../app/lib/portal/auth.server");
const { listAllVendors } = await import("../app/lib/vendors/team.server");
const { syncListing, resetDefinitionCache } = await import("../app/lib/storefront/listing.server");
const reviewsPage = await import("../app/routes/portal.reviews");
const dashboard = await import("../app/routes/portal._index");
const vendorPage = await import("../app/routes/app.vendor");
const storefront = await import("../app/routes/proxy.reviews");

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

// ---------------------------------------------------------------------------
// Storefront (through Shopify's app proxy)
// ---------------------------------------------------------------------------

describe("storefront reviews", () => {
  // Buyer 501 bought #1004 (Urban Store shipped) and #1001; buyer 777 only #1001 (not shipped).
  const get = async (query: string) => {
    const r = (await storefront.loader({ request: new Request(`https://app.test/proxy/reviews?shop=${shop}&${query}`), params: {}, context: {} } as never)) as Response;
    return { status: r.status, body: await r.json() };
  };
  const post = async (query: string, fields: Record<string, string | string[]>, method = "POST") => {
    try {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
      const r = (await storefront.action({ request: new Request(`https://app.test/proxy/reviews?shop=${shop}&${query}`, { method, body }), params: {}, context: {} } as never)) as Response;
      return { status: r.status, body: await r.json() };
    } catch (e) {
      if (e instanceof Response) return { status: e.status, body: await e.json() };
      throw e;
    }
  };
  beforeEach(async () => {
    Object.assign(proxy, { shop, orders: { "501": [String(O.n1004), String(O.n1001)], "777": [String(O.n1001)] }, down: false, asked: [], products: {}, productsDown: false });
    forgetProductCards();
    await db.vendor.update({ where: { id: urban }, data: { storeEntryHandle: "urban-store" } });
    await db.vendor.update({ where: { id: ashnur }, data: { storeEntryHandle: "ashnur" } });
  });

  it("anyone can read a seller's published reviews; nothing identifies the buyer or the order", async () => {
    await review({ customerId: 9001n, rating: 5, comment: "Lovely." });
    await review({ customerId: 9002n, rating: 1, comment: "Hidden one" });
    const bad = await db.vendorReview.findFirstOrThrow({ where: { shop, customerId: 9002n } });
    await setReviewHidden(db, shop, urban, bad.id, true, "admin:x", "spam");

    const r = await get("seller=urban-store");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, more: false, summary: { count: 1, average: "5.0" }, me: { signedIn: false } });
    expect(r.body.reviews).toEqual([{ rating: 5, comment: "Lovely.", author: "Meera", date: expect.any(String), edited: false, items: [] }]);
    const raw = JSON.stringify(r.body);
    for (const secret of ["9001", "customerId", "#1004", "orderId", "Hidden one"]) expect(raw).not.toContain(secret);
    expect(proxy.asked).toEqual([]); // a signed-out visitor costs no call to Shopify

    expect((await get("seller=ashnur")).body).toMatchObject({ ok: true, reviews: [], summary: { count: 0, average: null } });
    expect((await get("seller=nobody")).status).toBe(404);
    expect((await get("")).status).toBe(404);
  });

  it("sorts by newest, highest or lowest rating, counts each star, and skips the buyer part when only the list is asked for", async () => {
    const stars = [4, 5, 2, 5, 1];
    for (let i = 0; i < stars.length; i++) {
      await review({ customerId: BigInt(9100 + i), rating: stars[i], comment: `r${i}` });
      await db.vendorReview.updateMany({ where: { shop, customerId: BigInt(9100 + i) }, data: { createdAt: new Date(Date.UTC(2026, 10, 1 + i)) } });
    }
    const order = async (q: string) => (await get(`seller=urban-store${q}`)).body.reviews.map((r: { comment: string }) => r.comment);
    expect(await order("")).toEqual(["r4", "r3", "r2", "r1", "r0"]);
    expect(await order("&sort=newest")).toEqual(["r4", "r3", "r2", "r1", "r0"]);
    expect(await order("&sort=highest")).toEqual(["r3", "r1", "r0", "r2", "r4"]); // same stars: newest first
    expect(await order("&sort=lowest")).toEqual(["r4", "r2", "r0", "r3", "r1"]);
    expect(await order("&sort=%27%3B%20drop")).toEqual(["r4", "r3", "r2", "r1", "r0"]); // anything else means newest

    const first = (await get("seller=urban-store&sort=highest&logged_in_customer_id=501")).body;
    expect(first).toMatchObject({ sort: "highest", summary: { count: 5, average: "3.4", breakdown: { 1: 1, 2: 1, 3: 0, 4: 1, 5: 2 } }, me: { signedIn: true } });
    proxy.asked.length = 0;
    const again = (await get("seller=urban-store&sort=lowest&only=list&logged_in_customer_id=501")).body;
    expect(again.me).toBeUndefined();
    expect(again.summary.count).toBe(5);
    expect(proxy.asked).toEqual([]); // re-sorting doesn't ask Shopify for the buyer's orders again
  });

  it("tells a signed-in buyer whether they can review, and about which items", async () => {
    const yes = (await get("seller=urban-store&logged_in_customer_id=501")).body.me;
    expect(yes).toMatchObject({ signedIn: true, canReview: true, review: null });
    expect(yes.items.length).toBe(2);
    expect(yes.items[0]).toEqual({ id: expect.stringMatching(/^\d+$/), title: expect.any(String), url: null, image: null });
    expect(proxy.asked).toEqual(["customer_id:501", "products:2"]); // their orders, then the two products' pictures

    // Same buyer, other seller: #1004's Ashnur items haven't shipped.
    expect((await get("seller=ashnur&logged_in_customer_id=501")).body.me).toMatchObject({ signedIn: true, canReview: false, items: [] });
    expect((await get("seller=urban-store&logged_in_customer_id=777")).body.me).toMatchObject({ signedIn: true, canReview: false, items: [] });
    // A made-up customer number in the browser's own request can't be forged past Shopify's signature; a malformed one is ignored.
    expect((await get("seller=urban-store&logged_in_customer_id=abc")).body.me).toEqual({ signedIn: false });
  });

  it("says so when Shopify can't be asked, instead of guessing", async () => {
    proxy.down = true;
    expect((await get("seller=urban-store&logged_in_customer_id=501")).body.me).toEqual({ signedIn: true, canReview: false, unknown: true });
    expect(await post("logged_in_customer_id=501", { seller: "urban-store", rating: "5" })).toMatchObject({ status: 503 });
    expect(await db.vendorReview.count({ where: { shop } })).toBe(0);
  });

  it("a buyer leaves a review about products they bought, then changes it", async () => {
    const items = (await get("seller=urban-store&logged_in_customer_id=501")).body.me.items as { id: string; title: string }[];
    const sent = await post("logged_in_customer_id=501", { seller: "urban-store", rating: "4", comment: "  Sturdy and well finished. ", name: " Asha ", item: [items[1].id, items[0].id, items[1].id] });
    expect(sent).toEqual({ status: 200, body: { ok: true, replaced: false } });
    const saved = await db.vendorReview.findFirstOrThrow({ where: { shop, customerId: 501n }, include: { items: { orderBy: { position: "asc" } } } });
    expect([saved.rating, saved.comment, saved.authorName, saved.orderName]).toEqual([4, "Sturdy and well finished.", "Asha", "#1004"]);
    expect(saved.items.map((i) => [i.productId.toString(), i.title])).toEqual([[items[1].id, items[1].title], [items[0].id, items[0].title]]); // each once, in the order chosen

    const after = (await get("seller=urban-store&logged_in_customer_id=501")).body;
    expect(after.reviews[0]).toMatchObject({ rating: 4, author: "Asha", items: [{ title: items[1].title }, { title: items[0].title }] });
    expect(after.me.review).toEqual({ rating: 4, comment: "Sturdy and well finished.", name: "Asha", items: [items[1].id, items[0].id], hidden: false });
    expect((await vendorReviews(db, shop, urban)).reviews[0]).toMatchObject({ items: [items[1].title, items[0].title], orderName: "#1004" });

    // Changing it to one product, then to none.
    expect(await post("logged_in_customer_id=501", { seller: "urban-store", rating: "4", item: items[0].id })).toEqual({ status: 200, body: { ok: true, replaced: true } });
    expect((await get("seller=urban-store")).body.reviews[0].items.map((i: { title: string }) => i.title)).toEqual([items[0].title]);
    expect(await post("logged_in_customer_id=501", { seller: "urban-store", rating: "5", comment: "", name: "", item: "" })).toEqual({ status: 200, body: { ok: true, replaced: true } });
    const again = (await get("seller=urban-store")).body;
    expect(again.summary).toMatchObject({ count: 1, average: "5.0" });
    expect(again.reviews[0]).toMatchObject({ rating: 5, author: "Verified buyer", items: [], edited: true, comment: null });
    expect(await db.vendorReviewItem.count()).toBe(0);
  });

  it("shows each product with its current title, picture and page; plain words when Shopify can't say", async () => {
    const items = (await get("seller=urban-store&logged_in_customer_id=501")).body.me.items as { id: string; title: string }[];
    await post("logged_in_customer_id=501", { seller: "urban-store", rating: "5", item: [items[0].id, items[1].id] });
    forgetProductCards(); proxy.asked.length = 0;
    proxy.products = {
      [items[0].id]: { handle: "sunburst-ring", title: "Sunburst Ring (new name)", status: "ACTIVE", image: "https://cdn.shopify.com/ring_240x240.jpg" },
      [items[1].id]: { handle: "old-studs", title: "Old Studs", status: "ARCHIVED", image: null },
    };
    const shown = (await get("seller=urban-store")).body.reviews[0].items;
    expect(shown).toEqual([
      { title: "Sunburst Ring (new name)", url: "/products/sunburst-ring", image: "https://cdn.shopify.com/ring_240x240.jpg" },
      { title: "Old Studs", url: null, image: null }, // archived: no page to send the buyer to
    ]);
    expect(JSON.stringify(shown)).not.toContain(items[0].id); // product numbers aren't needed on the page
    await get("seller=urban-store"); await get("seller=urban-store&sort=highest&only=list");
    expect(proxy.asked).toEqual(["products:2"]); // asked once, then remembered for a while

    // A product deleted from Shopify, and Shopify not answering: the review still shows, with the titles from the order.
    forgetProductCards(); proxy.products = { [items[0].id]: proxy.products[items[0].id] };
    expect((await get("seller=urban-store")).body.reviews[0].items[1]).toEqual({ title: items[1].title, url: null, image: null });
    forgetProductCards(); proxy.productsDown = true;
    const r = await get("seller=urban-store");
    expect(r.status).toBe(200);
    expect(r.body.reviews[0].items).toEqual([{ title: items[0].title, url: null, image: null }, { title: items[1].title, url: null, image: null }]);
  });

  it("refuses: signed out, no shipped order, someone else's item, a bad rating, an unknown seller, not POST", async () => {
    const ok = { seller: "urban-store", rating: "5" };
    expect(await post("", ok)).toMatchObject({ status: 401 });
    expect(await post("logged_in_customer_id=777", ok)).toMatchObject({ status: 422, body: { ok: false, error: expect.stringContaining("shipped") } });
    expect(await post("logged_in_customer_id=501", { seller: "ashnur", rating: "5" })).toMatchObject({ status: 422 });
    const ashnurItem = (await db.vendorOrderLine.findFirstOrThrow({ where: { shop, vendorName: "Ashnur", productId: { not: null } } })).productId!.toString();
    expect(await post("logged_in_customer_id=501", { ...ok, item: ashnurItem })).toMatchObject({ status: 422, body: { error: expect.stringContaining("items you bought") } });
    const mine = ((await get("seller=urban-store&logged_in_customer_id=501")).body.me.items as { id: string }[])[0].id;
    expect(await post("logged_in_customer_id=501", { ...ok, item: [mine, ashnurItem] })).toMatchObject({ status: 422 }); // one wrong product refuses the lot
    expect(await post("logged_in_customer_id=501", { ...ok, item: Array.from({ length: 21 }, (_, i) => String(9000 + i)) })).toMatchObject({ status: 422, body: { error: "Choose up to 20 products." } });
    expect(await post("logged_in_customer_id=501", { ...ok, item: "not-a-number" })).toMatchObject({ status: 422 });
    for (const rating of ["0", "6", "", "4.5"]) expect(await post("logged_in_customer_id=501", { seller: "urban-store", rating })).toMatchObject({ status: 422 });
    expect(await post("logged_in_customer_id=501", { seller: "nobody", rating: "5" })).toMatchObject({ status: 404 });
    expect(await post("logged_in_customer_id=501", ok, "PUT")).toMatchObject({ status: 405 });
    expect(await db.vendorReview.count({ where: { shop } })).toBe(0);
  });

  it("only works for the store the app is enabled for", async () => {
    proxy.shop = "q0zr1f-0m.myshopify.com";
    await expect(storefront.loader({ request: new Request("https://app.test/proxy/reviews?seller=urban-store"), params: {}, context: {} } as never)).rejects.toMatchObject({ status: 404 });
    proxy.shop = null; // app not installed
    expect(await post("logged_in_customer_id=501", { seller: "urban-store", rating: "5" })).toMatchObject({ status: 404 });
  });

  it("loads more reviews ten at a time, without asking Shopify again", async () => {
    for (let i = 1; i <= 13; i++) await review({ customerId: BigInt(8000 + i), rating: 5, comment: `R${i}` });
    const p1 = (await get("seller=urban-store&logged_in_customer_id=501")).body;
    expect([p1.reviews.length, p1.more, p1.reviews[0].comment]).toEqual([10, true, "R13"]);
    proxy.asked.length = 0;
    const p2 = (await get("seller=urban-store&logged_in_customer_id=501&page=2")).body;
    expect([p2.reviews.length, p2.more, "me" in p2]).toEqual([3, false, false]);
    expect(proxy.asked).toEqual([]);
  });
});
