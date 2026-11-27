import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";
import { fakeShopify } from "./helpers/fake-shopify";

/**
 * The team's pages inside Shopify admin, run through their real loaders and
 * actions. Only Shopify's sign-in is replaced: `who.shop` is the shop the
 * signed-in staff member is on.
 */
const who = vi.hoisted(() => ({
  shop: "seller-panel-dev.myshopify.com", orders: [] as unknown[], webhook: null as null | Record<string, unknown>,
  app: { metafields: new Map<string, string>(), ops: [] as string[], deny: false },
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: who.shop, onlineAccessInfo: { associated_user: { email: "team@setustore.test" } } },
      admin: { graphql: fakeShopify(who.orders as ShopifyOrder[], who.app) },
    }),
    webhook: async () => ({ ...who.webhook, admin: { graphql: fakeShopify(who.orders as ShopifyOrder[]) } }),
  },
}));

const { signIn, signUp, getIdentity, createInviteLink, resetPassword } = await import("../app/lib/portal/auth.server");
const { addStaff, requestBusinessChange } = await import("../app/lib/vendors/team.server");
const { configureOrderQueue, drainOrderQueue } = await import("../app/lib/orders/queue.server");
const appShell = await import("../app/routes/app");
const home = await import("../app/routes/app.orders");
const dashboard = await import("../app/routes/app._index");
const reviewsPage = await import("../app/routes/app.reviews");
const allVendors = await import("../app/routes/app.vendors");
const vendorPage = await import("../app/routes/app.vendor");
const signups = await import("../app/routes/app.signups");
const webhook = await import("../app/routes/webhooks.orders");
const fileRoute = await import("../app/routes/app.files.$fileId");
const mailPage = await import("../app/routes/app.mail");

const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
const PW = "Strong-test-password-1";
const orders = () => structuredClone(fixture.orders) as ShopifyOrder[];
afterAll(() => db.$disconnect());

type Fn = (a: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
async function call(fn: unknown, path: string, fields?: Record<string, string>) {
  const request = new Request("https://app.test" + path, fields ? { method: "POST", body: new URLSearchParams(fields) } : {});
  const fileId = path.match(/^\/app\/files\/([^/?]+)/)?.[1];
  try {
    return (await (fn as Fn)({ request, params: fileId ? { fileId } : {}, context: {} })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch (e) {
    if (e instanceof Response) return { thrown: e.status };
    throw e;
  }
}
const vendorPost = (fields: Record<string, string>) => call(vendorPage.action, "/app/vendor", { name: "Urban Store", ...fields });
const userId = async (email: string) => (await db.vendorUser.findFirstOrThrow({ where: { shop, email } })).id;

async function cleanup() {
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.passwordReset.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorChangeRequest.deleteMany({ where: { shop } });
  await db.vendorFile.deleteMany({ where: { shop } });
  await db.portalHandoff.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorCommission.deleteMany({ where: { shop } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.syncState.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
  await db.shopSetting.deleteMany({ where: { shop } });
  await db.mailMessage.deleteMany({ where: { shop } });
  await db.mailTemplateSetting.deleteMany({ where: { shop } });
  await db.mailSetting.deleteMany({ where: { shop } });
}
beforeAll(async () => {
  await cleanup();
  who.orders = orders();
  configureOrderQueue({ debounceMs: 10, retryDelayMs: 10 });
});

describe("store guard", () => {
  it("the app refuses to open on the live store", async () => {
    who.shop = "q0zr1f-0m.myshopify.com";
    const r = await call(appShell.loader, "/app");
    expect(r.thrown).toBe(403);
    who.shop = shop;
    expect((await call(appShell.loader, "/app")).thrown).toBeUndefined();
  });
});

describe("Shipping and orders: orders", () => {
  it("Resync all orders copies the dev store's orders and the overview adds up", async () => {
    const r = await call(home.action, "/app/orders", { intent: "resync" });
    expect(r).toMatchObject({ ok: true, orders: 5 });
    const page = await call(home.loader, "/app/orders");
    expect(page.orderCount).toBe(5);
    const urban = page.vendors.find((v: { vendorName: string }) => v.vendorName === "Urban Store");
    const ashnur = page.vendors.find((v: { vendorName: string }) => v.vendorName === "Ashnur");
    expect(urban).toMatchObject({ gross: "3550.00", net: "3475.00", unitsToShip: 33, portal: "Not set up" });
    expect(ashnur).toMatchObject({ gross: "1875.00", unitsToShip: 10 });
  });
});

describe("Order webhooks", () => {
  it("an orders/updated webhook re-reads the order; orders/delete removes it; other stores are ignored", async () => {
    const o = orders()[0];
    await db.vendorOrderLine.deleteMany({ where: { shop, orderId: BigInt(o.id.split("/").pop()!) } });
    who.webhook = { shop, topic: "ORDERS_UPDATED", payload: { id: o.id.split("/").pop(), admin_graphql_api_id: o.id } };
    await call(webhook.action, "/webhooks/orders", {});
    await drainOrderQueue(shop);
    expect(await db.vendorOrderLine.count({ where: { shop, orderName: o.name } })).toBeGreaterThan(0);

    who.webhook = { shop, topic: "ORDERS_DELETE", payload: { id: o.id.split("/").pop() } };
    await call(webhook.action, "/webhooks/orders", {});
    expect(await db.vendorOrderLine.count({ where: { shop, orderName: o.name } })).toBe(0);

    who.webhook = { shop: "q0zr1f-0m.myshopify.com", topic: "ORDERS_UPDATED", payload: { id: o.id.split("/").pop() } };
    await call(webhook.action, "/webhooks/orders", {});
    await drainOrderQueue("q0zr1f-0m.myshopify.com");
    expect(await db.vendorOrderLine.count({ where: { shop: "q0zr1f-0m.myshopify.com" } })).toBe(0);

    await call(home.action, "/app/orders", { intent: "resync" }); // put it back
  });
});

describe("Sign-ups page", () => {
  it("lists waiting sign-ups with the store's vendor names, approves one and declines another", async () => {
    await signUp(db, { name: "Harpreet", email: "owner@urban.example", password: PW, phone: "+91 98140 12345" }, { shop });
    await signUp(db, { name: "Spam", email: "spam@nowhere.example", password: PW, phone: "+91 90000 00000" }, { shop });
    const page = await call(signups.loader, "/app/signups");
    expect(page.pending.map((s: { email: string }) => s.email).sort()).toEqual(["owner@urban.example", "spam@nowhere.example"]);
    expect(page.shopifyVendors).toEqual(["Ashnur", "Urban Store"]);

    expect(await call(signups.action, "/app/signups", { intent: "approve", userId: await userId("owner@urban.example"), vendorName: "" })).toMatchObject({ ok: false });
    expect(await call(signups.action, "/app/signups", { intent: "approve", userId: await userId("owner@urban.example"), vendorName: "Urban Store" })).toMatchObject({ ok: true });
    expect(await call(signups.action, "/app/signups", { intent: "reject", userId: await userId("spam@nowhere.example") })).toMatchObject({ ok: true });

    const u = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "owner@urban.example" }, include: { vendor: true } });
    expect([u.status, u.role, u.vendor?.vendorName]).toEqual(["active", "owner", "Urban Store"]);
    expect((await signIn(db, "spam@nowhere.example", PW, { shop })).ok).toBe(false);
    const after = await call(signups.loader, "/app/signups");
    expect(after.pending).toHaveLength(0);
    expect(after.rejected.map((s: { email: string }) => s.email)).toEqual(["spam@nowhere.example"]);
  });
});

describe("All vendors and the vendor page", () => {
  it("All vendors lists Urban Store with its owner", async () => {
    const page = await call(allVendors.loader, "/app/vendors");
    expect(page.vendors).toHaveLength(1);
    expect(page.vendors[0]).toMatchObject({ vendorName: "Urban Store", owners: ["Harpreet"], people: 1, active: 1, pendingChange: false });
  });

  it("vendor page shows people, details and order lines", async () => {
    const page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.vendor.status).toBe("active");
    expect(page.people.map((p: { email: string }) => p.email)).toEqual(["owner@urban.example"]);
    expect(page.profile.missing).toEqual(["company name", "business address", "minimum order value", "processing time"]);
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines).toHaveLength(await db.vendorOrderLine.count({ where: { shop, vendorName: "Urban Store" } }));
    const ashnurIds = (await db.vendorOrderLine.findMany({ where: { shop, vendorName: "Ashnur" } })).map((l) => l.lineItemId.toString());
    expect(page.lines.some((l: { lineItemId: string }) => ashnurIds.includes(l.lineItemId))).toBe(false);
  });

  it("add people as owner or staff; refuse a bad or taken email", async () => {
    expect(await vendorPost({ intent: "add_user", email: "second@urban.example", person: "Second", role: "owner", access: "edit" })).toMatchObject({ ok: true });
    expect(await vendorPost({ intent: "add_user", email: "packer@urban.example", person: "Packer", role: "staff", access: "view" })).toMatchObject({ ok: true });
    expect(await vendorPost({ intent: "add_user", email: "not-an-email", role: "staff" })).toMatchObject({ ok: false });
    expect(await vendorPost({ intent: "add_user", email: "owner@urban.example", role: "staff" })).toMatchObject({ ok: false });
    const p = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "packer@urban.example" } });
    expect([p.status, p.role, p.access]).toEqual(["invited", "staff", "view"]);
  });

  it("change status, role and access; Deactivated and Requires approval sign the person out", async () => {
    const owner = await signIn(db, "owner@urban.example", PW, { shop });
    if (!owner.ok) throw new Error();
    const id = await userId("owner@urban.example");

    expect(await vendorPost({ intent: "update_user", userId: id, status: "disabled", role: "owner", access: "edit" })).toMatchObject({ ok: true });
    expect(await getIdentity(db, shop, owner.token)).toBeNull();
    expect((await signIn(db, "owner@urban.example", PW, { shop })).ok).toBe(false);

    expect(await vendorPost({ intent: "update_user", userId: id, status: "pending", role: "owner", access: "edit" })).toMatchObject({ ok: true });
    const pend = await signIn(db, "owner@urban.example", PW, { shop });
    expect(pend.ok && pend.status).toBe("pending");

    expect(await vendorPost({ intent: "update_user", userId: id, status: "active", role: "owner", access: "edit" })).toMatchObject({ ok: true });
    const back = await signIn(db, "owner@urban.example", PW, { shop });
    expect(back.ok && back.status).toBe("active");

    const packer = await userId("packer@urban.example");
    expect(await vendorPost({ intent: "update_user", userId: packer, status: "invited", role: "staff", access: "edit" })).toMatchObject({ ok: true });
    expect((await db.vendorUser.findUniqueOrThrow({ where: { id: packer } })).access).toBe("edit");
    expect(await vendorPost({ intent: "update_user", userId: id, status: "banana", role: "owner", access: "edit" })).toMatchObject({ ok: false });
  });

  it("business change with a document: the team sees it, opens the file, approves; a later change is declined with a reason", async () => {
    const t = await signIn(db, "owner@urban.example", PW, { shop });
    if (!t.ok) throw new Error();
    const me = (await getIdentity(db, shop, t.token))!;
    const meArg = { shop, user: me.user, vendor: me.vendor! };
    const form = new FormData();
    for (const [k, v] of Object.entries({ companyName: "Urban Store Pvt Ltd", addressLine: "5 Mall Road", city: "Ludhiana", state: "Punjab", postalCode: "141001" })) form.append(k, v);
    form.append("gstFile", new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n")], "gst.pdf", { type: "application/pdf" }));
    expect(await requestBusinessChange(db, meArg, form)).toEqual({ ok: true });

    let page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.change.pending.changes.companyName).toEqual({ from: null, to: "Urban Store Pvt Ltd" });
    const gstId = page.change.pending.changes.gstFileId.to;
    expect(page.change.files[gstId].fileName).toBe("gst.pdf");
    expect((await call(allVendors.loader, "/app/vendors")).vendors[0].pendingChange).toBe(true);

    // The team opens the document; a file from another shop is "not found".
    const res = (await call(fileRoute.loader, `/app/files/${gstId}`)) as unknown as Response;
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/pdf"]);
    who.shop = "someone-else.myshopify.com";
    process.env.ALLOWED_SHOPS = `${shop},someone-else.myshopify.com`;
    expect(((await call(fileRoute.loader, `/app/files/${gstId}`)) as unknown as Response).status).toBe(404);
    process.env.ALLOWED_SHOPS = shop;
    who.shop = shop;

    expect(await vendorPost({ intent: "approve_change", requestId: page.change.pending.id })).toMatchObject({ ok: true });
    page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect([page.profile.companyName, page.profile.postalCode, page.profile.gstFile.fileName]).toEqual(["Urban Store Pvt Ltd", "141001", "gst.pdf"]);
    expect(page.profile.missing).toEqual(["minimum order value", "processing time"]);

    await requestBusinessChange(db, meArg, { companyName: "Urban Store Pvt Ltd", addressLine: "5 Mall Road", city: "Chandigarh", state: "Punjab", postalCode: "160001" });
    page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(await vendorPost({ intent: "reject_change", requestId: page.change.pending.id, note: "Need proof of address" })).toMatchObject({ ok: true });
    page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.profile.city).toBe("Ludhiana");
    expect(page.change.last).toMatchObject({ status: "rejected", note: "Need proof of address" });
  });

  it("the team edits brand name and text details directly, with checks", async () => {
    const base = {
      intent: "details", displayName: "Urban Store", companyName: "Urban Store Pvt Ltd", addressLine: "5 Mall Road", city: "Ludhiana", state: "Punjab",
      postalCode: "141001", minimumOrderValue: "1500", shortDescription: "Sunglasses and watches", description: "New text",
      processingDaysMin: "10", processingDaysMax: "15", brandValues: "Women owned, Handmade",
    };
    expect(await vendorPost(base)).toMatchObject({ ok: true });
    expect(await vendorPost({ ...base, postalCode: "12" })).toMatchObject({ ok: false });
    expect(await vendorPost({ ...base, minimumOrderValue: "a lot" })).toMatchObject({ ok: false });
    expect(await vendorPost({ ...base, displayName: "" })).toMatchObject({ ok: false });
    expect(await vendorPost({ ...base, processingDaysMin: "15", processingDaysMax: "10" })).toMatchObject({ ok: false });
    expect(await vendorPost({ ...base, processingDaysMax: "" })).toMatchObject({ ok: false });
    const v = await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Urban Store" } });
    expect([v.processingDaysMin, v.processingDaysMax]).toEqual([10, 15]);
    expect(await vendorPost({ ...base, brandValues: "1, 2, 3, 4, 5, 6" })).toMatchObject({ ok: false });
    expect(v.brandValues).toEqual(["Women owned", "Handmade"]);
    expect([v.displayName, v.description, v.shortDescription, v.minimumOrderValue?.toFixed(2)]).toEqual(["Urban Store", "New text", "Sunglasses and watches", "1500.00"]);
    expect((await call(vendorPage.loader, "/app/vendor?name=Urban%20Store")).profile.missing).toEqual([]);
  });

  it("an owner's staff invite shows up for the team; pausing the vendor signs everyone out", async () => {
    const t = await signIn(db, "owner@urban.example", PW, { shop });
    if (!t.ok) throw new Error();
    const me = (await getIdentity(db, shop, t.token))!;
    const added = await addStaff(db, { shop, user: me.user, vendor: me.vendor! }, { email: "helper@urban.example", name: "Helper", access: "edit" });
    if (!added.ok) throw new Error();
    await resetPassword(db, await createInviteLink(db, added.userId, { shop }), PW, { shop });
    const page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.people.find((p: { email: string }) => p.email === "helper@urban.example")).toMatchObject({ role: "staff", access: "edit", status: "active" });

    expect(await vendorPost({ intent: "pause" })).toMatchObject({ ok: true });
    expect(await getIdentity(db, shop, t.token)).toBeNull();
    expect((await signIn(db, "helper@urban.example", PW, { shop })).ok).toBe(false);
    expect(await vendorPost({ intent: "activate" })).toMatchObject({ ok: true });
    expect((await signIn(db, "helper@urban.example", PW, { shop })).ok).toBe(true);
  });

  it("the vendor page shows the portal address and opens a one-time team view", async () => {
    const page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.portalUrl).toBe("https://app.test"); // PORTAL_URL / SHOPIFY_APP_URL in real use
    const r = await vendorPost({ intent: "team_view" });
    expect(r.ok).toBe(true);
    expect(r.viewUrl).toMatch(/^https:\/\/app\.test\/portal\/view\?token=[\w-]{40,}$/);
    expect(await db.auditLog.count({ where: { shop, action: "portal.team_view_opened", actor: "admin:team@setustore.test" } })).toBe(1);
    expect((await call(allVendors.loader, "/app/vendors")).portalUrl).toBe("https://app.test");
  });

  it("the team sets and changes commission on the vendor page; All vendors shows it", async () => {
    let list = (await call(allVendors.loader, "/app/vendors")).vendors;
    expect(list.find((v: { vendorName: string }) => v.vendorName === "Urban Store").commission).toBeNull();
    expect(await vendorPost({ intent: "commission", rate: "abc" })).toMatchObject({ ok: false });
    expect(await vendorPost({ intent: "commission", rate: "15" })).toMatchObject({ ok: true, message: "Commission set to 15%" });
    expect(await vendorPost({ intent: "commission", rate: "15" })).toMatchObject({ ok: false });
    expect(await vendorPost({ intent: "commission", rate: "17.5%" })).toMatchObject({ ok: true });
    const page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.commission.map((h: { rate: string; fromStart: boolean; setBy: string }) => [h.rate, h.fromStart, h.setBy])).toEqual([
      ["17.50", false, "team@setustore.test"], ["15.00", true, "team@setustore.test"],
    ]);
    list = (await call(allVendors.loader, "/app/vendors")).vendors;
    expect(list.find((v: { vendorName: string }) => v.vendorName === "Urban Store").commission).toBe("17.50");
  });

  it("removing a person ends their access", async () => {
    expect(await vendorPost({ intent: "remove_user", userId: await userId("second@urban.example") })).toMatchObject({ ok: true });
    expect(await db.vendorUser.count({ where: { shop, email: "second@urban.example" } })).toBe(0);
  });

  it("a vendor without portal access can be set up from its page", async () => {
    let page = await call(vendorPage.loader, "/app/vendor?name=Ashnur");
    expect(page.vendor).toBeNull();
    expect(await call(vendorPage.action, "/app/vendor", { name: "Ashnur", intent: "enable" })).toMatchObject({ ok: true });
    page = await call(vendorPage.loader, "/app/vendor?name=Ashnur");
    expect(page.vendor.status).toBe("active");
    expect(await call(vendorPage.action, "/app/vendor", { name: "Nobody", intent: "pause" })).toMatchObject({ ok: false });
  });
});

describe("Shipping and orders: delivery time and views", () => {
  const save = (min: string, max: string) => call(home.action, "/app/orders", { intent: "delivery_time", deliveryDaysMin: min, deliveryDaysMax: max });

  it("opens on Shipping: what is waiting to ship, the delivery time, and each seller's processing time", async () => {
    const page = await call(home.loader, "/app/orders");
    expect(page.view).toBe("shipping");
    expect(page.delivery).toMatchObject({ range: null, error: null });
    expect(page.totals).toMatchObject({ unitsToShip: page.vendors.reduce((n: number, v: { unitsToShip: number }) => n + v.unitsToShip, 0) });
    expect(page.totals.unitsToShip).toBeGreaterThan(0);
    expect(page.sellers.find((v: { vendorName: string }) => v.vendorName === "Urban Store").processing).toEqual({ min: 10, max: 15 });
    const urban = page.vendors.find((v: { vendorName: string }) => v.vendorName === "Urban Store");
    expect(urban).toMatchObject({ processing: { min: 10, max: 15 }, portal: expect.stringMatching(/^(Active|Paused) · \d+ (person|people)$/) });
    for (const [q, view] of [["?view=sales", "sales"], ["?view=sync", "sync"], ["?view=nonsense", "shipping"]]) {
      expect((await call(home.loader, `/app/orders${q}`)).view).toBe(view);
    }
  });

  it("saves the delivery time, says who set it, and keeps a record", async () => {
    expect(await save("5", "7")).toEqual({ ok: true, range: { min: 5, max: 7 }, onStore: true });
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "5", "setu_seller.delivery_days_max": "7" });
    const page = await call(home.loader, "/app/orders");
    expect(page.delivery).toMatchObject({ range: { min: 5, max: 7 }, updatedBy: "team@setustore.test" });
    const log = await db.auditLog.findFirstOrThrow({ where: { shop, action: "settings.delivery_time_updated" }, orderBy: { at: "desc" } });
    expect(log.detail).toEqual({ from: null, to: { min: 5, max: 7 } });
  });

  it("refuses a range that makes no sense and keeps the saved one", async () => {
    for (const [a, b] of [["7", "5"], ["5", ""], ["", "7"], ["2.5", "4"], ["-1", "3"], ["0", "0"], ["5", "400"], ["soon", "later"]]) {
      expect(await save(a, b), `${a}–${b}`).toMatchObject({ ok: false });
    }
    expect((await call(home.loader, "/app/orders")).delivery.range).toEqual({ min: 5, max: 7 });
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "5", "setu_seller.delivery_days_max": "7" });
  });

  it("the same number twice is a single figure; both boxes empty removes it", async () => {
    expect(await save("6", "6")).toMatchObject({ ok: true, range: { min: 6, max: 6 } });
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "6", "setu_seller.delivery_days_max": "6" });
    expect(await save("", "")).toMatchObject({ ok: true, range: null, onStore: true });
    expect((await call(home.loader, "/app/orders")).delivery.range).toBeNull();
    expect(who.app.metafields.size).toBe(0);
  });

  it("when Shopify refuses, the setting is kept, the reason is shown, and sending again fixes it", async () => {
    who.app.deny = true;
    const r = await save("4", "9");
    expect(r).toMatchObject({ ok: true, range: { min: 4, max: 9 }, onStore: false });
    expect(r.error).toMatch(/isn't allowed|Shopify said/);
    let page = await call(home.loader, "/app/orders");
    expect(page.delivery.range).toEqual({ min: 4, max: 9 });
    expect(page.delivery.error).toBe(r.error);
    expect(who.app.metafields.size).toBe(0);
    who.app.deny = false;
    expect(await call(home.action, "/app/orders", { intent: "delivery_resend" })).toEqual({ ok: true, range: { min: 4, max: 9 }, onStore: true });
    page = await call(home.loader, "/app/orders");
    expect(page.delivery.error).toBeNull();
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "4", "setu_seller.delivery_days_max": "9" });
  });

  it("each shop has its own setting", async () => {
    await save("3", "4");
    expect(await db.shopSetting.count({ where: { shop: { not: shop } } })).toBe(0);
    expect(await call(home.action, "/app/orders", { intent: "something_else" })).toMatchObject({ ok: false });
  });
});

describe("Dashboard (the app's home)", () => {
  it("shows the main numbers for vendors, shipping, orders and reviews", async () => {
    const page = await call(dashboard.loader, "/app");
    const all = await db.vendor.findMany({ where: { shop } });
    expect(page.numbers.vendors).toMatchObject({ total: all.length, active: all.filter((v) => v.status === "active").length, signups: await db.vendorUser.count({ where: { shop, status: "pending" } }) });
    const orders = await call(home.loader, "/app/orders");
    expect(page.numbers.shipping.unitsToShip).toBe(orders.totals.unitsToShip);
    expect(page.numbers.orders).toEqual({ total: 5, net: orders.totals.net });
    expect(page.numbers.reviews).toEqual({ published: 0, hidden: 0, average: null, last30Days: 0 });
    expect(page.delivery.range).toEqual({ min: 3, max: 4 });
    expect(page.activity.length).toBeGreaterThan(0);
    expect(page.activity.length).toBeLessThanOrEqual(8);
  });

  it("each alert says what is waiting and where to deal with it, with the vendors concerned", async () => {
    const all = await db.vendor.findMany({ where: { shop } });
    let page = await call(dashboard.loader, "/app");
    const alert = (key: string) => page.alerts.find((a: { key: string }) => a.key === key);
    expect(alert("no_processing_time")?.vendors.map((v: { vendorName: string }) => v.vendorName).sort())
      .toEqual(all.filter((v) => v.processingDaysMin === null).map((v) => v.vendorName).sort());
    expect(alert("no_processing_time")).toMatchObject({ tone: "warning", href: "/app/vendors?view=attention" });
    expect(alert("delivery_unset")).toBeUndefined(); // a delivery time is set
    expect(alert("sync")).toBeUndefined();

    // No delivery time; a sign-up waiting; orders failing to copy; the store not showing the delivery time.
    await call(home.action, "/app/orders", { intent: "delivery_time", deliveryDaysMin: "", deliveryDaysMax: "" });
    await signUp(db, { name: "New Seller", email: "new@seller.example", password: PW, phone: "+91 90000 11111" }, { shop });
    await db.syncState.update({ where: { shop }, data: { lastError: "Shopify timed out" } });
    page = await call(dashboard.loader, "/app");
    expect(alert("delivery_unset")).toMatchObject({ tone: "warning", href: "/app/orders" });
    expect(alert("signups")).toMatchObject({ text: "1 sign-up is waiting for approval", href: "/app/signups" });
    expect(alert("sync")).toMatchObject({ tone: "critical", href: "/app/orders", text: expect.stringContaining("Shopify timed out") });
    expect(page.alerts[0].tone).toBe("critical"); // what is broken comes first
    who.app.deny = true;
    await call(home.action, "/app/orders", { intent: "delivery_time", deliveryDaysMin: "5", deliveryDaysMax: "7" });
    who.app.deny = false;
    page = await call(dashboard.loader, "/app");
    expect(alert("delivery_copy")).toMatchObject({ tone: "critical", href: "/app/orders" });
    expect(alert("delivery_unset")).toBeUndefined();
    await call(home.action, "/app/orders", { intent: "delivery_resend" });
    await db.syncState.update({ where: { shop }, data: { lastError: null } });
  });

  it("the sales report covers the last 30 days and ranks vendors by net sales", async () => {
    const page = await call(dashboard.loader, "/app");
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const lines = await db.vendorOrderLine.findMany({ where: { shop, orderCreatedAt: { gte: since } } });
    expect(page.report.days).toBe(30);
    expect(page.report.orders).toBe(new Set(lines.map((l) => l.orderId)).size);
    expect(Number(page.report.net)).toBeCloseTo(lines.filter((l) => l.status !== "cancelled").reduce((n, l) => n + Number(l.netAmount), 0), 2);
    const nets = page.report.topVendors.map((v: { net: string }) => Number(v.net));
    expect(nets).toEqual([...nets].sort((a, b) => b - a));
    expect(page.report.topVendors.length).toBeLessThanOrEqual(5);
    // An order placed before the period is in the all-time numbers but not in the report.
    const one = await db.vendorOrderLine.findFirstOrThrow({ where: { shop, status: { not: "cancelled" } } });
    await db.vendorOrderLine.updateMany({ where: { shop, orderId: one.orderId }, data: { orderCreatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) } });
    const later = await call(dashboard.loader, "/app");
    expect(later.report.orders).toBe(page.report.orders === 0 ? 0 : Math.max(0, page.report.orders - (lines.some((l) => l.orderId === one.orderId) ? 1 : 0)));
    expect(later.numbers.orders.total).toBe(5);
  });
});

describe("Vendors page views", () => {
  it("All vendors carries everything about each vendor; Needs attention keeps only those with something to do", async () => {
    const all = await call(allVendors.loader, "/app/vendors");
    expect(all.view).toBe("all");
    const urban = all.vendors.find((v: { vendorName: string }) => v.vendorName === "Urban Store");
    expect(urban).toMatchObject({ commission: "17.50", minimumOrderValue: "1500.00", processing: { min: 10, max: 15 }, net: expect.stringMatching(/^\d+\.\d{2}$/), orders: expect.any(Number) });
    expect(all.counts).toMatchObject({ all: all.vendors.length, signups: 1 });
    const attention = await call(allVendors.loader, "/app/vendors?view=attention");
    expect(attention.view).toBe("attention");
    expect(attention.vendors.every((v: { flags: string[] }) => v.flags.length > 0)).toBe(true);
    expect(attention.vendors.length).toBe(all.vendors.filter((v: { flags: string[] }) => v.flags.length > 0).length);
    expect(attention.counts.attention).toBe(attention.vendors.length);
    const flagged = all.vendors.find((v: { processing: unknown }) => !v.processing);
    if (flagged) expect(flagged.flags).toContain("No processing time");
  });

  it("Without portal access lists Shopify vendors that have orders but no account; the Sign-ups page shares the tabs", async () => {
    const page = await call(allVendors.loader, "/app/vendors?view=no-access");
    const withAccount = new Set((await db.vendor.findMany({ where: { shop } })).map((v) => v.vendorName));
    const onOrders = new Set((await db.vendorOrderLine.findMany({ where: { shop } })).map((l) => l.vendorName).filter(Boolean));
    expect(page.noAccess.map((v: { vendorName: string }) => v.vendorName).sort()).toEqual([...onOrders].filter((v) => !withAccount.has(v)).sort());
    expect(page.counts.noAccess).toBe(page.noAccess.length);
    expect((await call(signups.loader, "/app/signups")).counts).toEqual(page.counts);
    expect((await call(allVendors.loader, "/app/vendors?view=whatever")).view).toBe("all");
  });
});

describe("Reviews page (all sellers)", () => {
  let urbanId = "";
  let otherId = "";
  beforeAll(async () => {
    urbanId = (await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Urban Store" } })).id;
    otherId = (await db.vendor.upsert({ where: { shop_vendorName: { shop, vendorName: "Ashnur" } }, create: { shop, vendorName: "Ashnur", displayName: "Ashnur" }, update: {} })).id;
    const make = (vendorId: string, customerId: number, rating: number, daysAgo: number, extra: object = {}) => db.vendorReview.create({
      data: { shop, vendorId, customerId: BigInt(customerId), orderId: 1n, orderName: "#1001", authorName: `Buyer ${customerId}`, rating, comment: `Review ${customerId}`, createdAt: new Date(Date.now() - daysAgo * 86400000), ...extra },
    });
    await make(urbanId, 1, 5, 1, { buyerLocation: "Pune, India" });
    await make(urbanId, 2, 2, 40);
    await make(urbanId, 3, 4, 3, { status: "hidden", hiddenBy: "admin:team@setustore.test", hiddenReason: "Spam", hiddenAt: new Date() });
    await make(otherId, 4, 3, 2);
  });

  it("lists every seller's reviews newest first, with the numbers on top", async () => {
    const page = await call(reviewsPage.loader, "/app/reviews");
    expect(page.view).toBe("all");
    expect(page.list.reviews.map((r: { comment: string }) => r.comment)).toEqual(["Review 1", "Review 4", "Review 3", "Review 2"]);
    expect(page.list.reviews[0]).toMatchObject({ vendor: { vendorName: "Urban Store" }, location: "Pune, India", hidden: false });
    expect(page.numbers).toMatchObject({ published: 3, hidden: 1, average: "3.3", last30Days: 3 }); // (5 + 2 + 3) / 3; the hidden one isn't counted
    expect(JSON.stringify(page)).not.toContain("customerId");
  });

  it("narrows by seller, by status and by stars; anything unknown is ignored", async () => {
    const comments = async (q: string) => (await call(reviewsPage.loader, `/app/reviews${q}`)).list.reviews.map((r: { comment: string }) => r.comment);
    expect(await comments(`?seller=${otherId}`)).toEqual(["Review 4"]);
    expect(await comments("?status=hidden")).toEqual(["Review 3"]);
    expect(await comments("?status=published&stars=5")).toEqual(["Review 1"]);
    expect(await comments(`?seller=${urbanId}&stars=2`)).toEqual(["Review 2"]);
    expect(await comments("?seller=nobody&status=deleted&stars=9")).toHaveLength(4);
    expect((await call(reviewsPage.loader, "/app/reviews?stars=1")).list).toMatchObject({ total: 0, reviews: [] });
  });

  it("By seller gives each seller's rating and counts", async () => {
    const page = await call(reviewsPage.loader, "/app/reviews?view=sellers");
    expect(page.view).toBe("sellers");
    expect(page.numbers.vendors.map((v: { vendorName: string; average: string; published: number; hidden: number }) => [v.vendorName, v.average, v.published, v.hidden]))
      .toEqual([["Ashnur", "3.0", 1, 0], ["Urban Store", "3.5", 2, 1]]);
  });

  it("the team hides a review with a reason and shows it again, from this page", async () => {
    const id = (await db.vendorReview.findFirstOrThrow({ where: { shop, customerId: 1n } })).id;
    const post = (fields: Record<string, string>) => call(reviewsPage.action, "/app/reviews", { vendorId: urbanId, reviewId: id, ...fields });
    expect(await post({ intent: "hide_review", reason: "" })).toMatchObject({ ok: false });
    expect(await post({ intent: "hide_review", reason: "Not about this seller" })).toMatchObject({ ok: true, message: expect.stringContaining("hidden") });
    expect((await call(reviewsPage.loader, "/app/reviews")).numbers).toMatchObject({ published: 2, hidden: 2 });
    expect((await db.vendorReview.findUniqueOrThrow({ where: { id } }))).toMatchObject({ status: "hidden", hiddenBy: "admin:team@setustore.test", hiddenReason: "Not about this seller" });
    // A review can't be changed through another seller, and unknown actions do nothing.
    expect(await call(reviewsPage.action, "/app/reviews", { vendorId: otherId, reviewId: id, intent: "show_review" })).toMatchObject({ ok: false });
    expect(await post({ intent: "delete_review" })).toMatchObject({ ok: false });
    expect(await post({ intent: "show_review" })).toMatchObject({ ok: true, message: "Review shown again" });
    expect((await call(dashboard.loader, "/app")).numbers.reviews).toMatchObject({ published: 3, hidden: 1, average: "3.3" });
  });
});

describe("Mail page", () => {
  const post = (fields: Record<string, string>) => call(mailPage.action, "/app/mail", fields);

  it("is in the app's menu, and opens on the mails with nothing really being sent here", async () => {
    const page = await call(mailPage.loader, "/app/mail");
    expect(page.view).toBe("mails");
    expect(page.mode).toMatchObject({ real: false });
    expect(page.templates.length).toBeGreaterThan(20);
    expect(page.me).toBe("team@setustore.test");
  });

  it("the team sets its addresses, switches a mail off and on, and can't switch off a required one", async () => {
    expect(await post({ intent: "team_addresses", addresses: "not an address" })).toMatchObject({ ok: false });
    expect(await post({ intent: "team_addresses", addresses: "alerts@setustore.test, ops@setustore.test" })).toMatchObject({ ok: true });
    expect((await call(mailPage.loader, "/app/mail?view=team")).numbers.team).toEqual(["alerts@setustore.test", "ops@setustore.test"]);
    const enabled = async (key: string) => (await call(mailPage.loader, "/app/mail")).templates.find((t: { key: string }) => t.key === key).enabled;
    expect(await post({ intent: "template_off", template: "order_new" })).toMatchObject({ ok: true, key: "order_new" });
    expect(await enabled("order_new")).toBe(false);
    expect(await post({ intent: "template_on", template: "order_new" })).toMatchObject({ ok: true });
    expect(await enabled("order_new")).toBe(true);
    expect(await post({ intent: "template_off", template: "password_reset" })).toMatchObject({ ok: false });
    expect(await enabled("password_reset")).toBe(true);
    expect(await post({ intent: "something_else" })).toMatchObject({ ok: false, error: "Unknown action" });
    const said = (await db.auditLog.findMany({ where: { shop, action: { startsWith: "mail." } }, orderBy: { at: "asc" } })).map((a) => [a.action, a.actor]);
    expect(said).toEqual([["mail.team_addresses_updated", "admin:team@setustore.test"], ["mail.template_off", "admin:team@setustore.test"], ["mail.template_on", "admin:team@setustore.test"]]);
  });

  it("a test from the page is written to the log and held back here; the log can send a held-back mail again", async () => {
    const r = await post({ intent: "test", template: "order_new", to: "me@setustore.test" });
    expect(r).toMatchObject({ ok: false, key: "order_new", error: expect.stringContaining("wasn't really sent") });
    const log = await call(mailPage.loader, "/app/mail?view=log&to=me@setustore.test");
    expect(log.log.rows).toHaveLength(1);
    expect(log.log.rows[0]).toMatchObject({ subject: "Test: New order #1042 for Ashnur", status: "logged", canSendAgain: true });
    expect(await post({ intent: "send_again", id: log.log.rows[0].id })).toMatchObject({ ok: true });
    expect(await post({ intent: "send_again", id: "nope" })).toMatchObject({ ok: false });
    expect((await call(mailPage.loader, "/app/mail?view=log&status=queued")).log.total).toBeGreaterThanOrEqual(1);
  });

  it("Settings: the team saves the sender, reply address and test list from the page; wrong values are refused; the check runs", async () => {
    const page = await call(mailPage.loader, "/app/mail?view=settings");
    expect(page.view).toBe("settings");
    expect(page.settings).toMatchObject({ key: { source: "none" }, fromAddress: "", onlyTo: [], production: false });
    expect(await post({ intent: "settings_save", fromName: "Setu Store", fromAddress: "nope", replyTo: "", onlyTo: "" })).toMatchObject({ ok: false, errors: { fromAddress: expect.any(String) } });
    expect(await post({ intent: "settings_save", fromName: "Setu Store", fromAddress: "support@setustore.test", replyTo: "help@setustore.test", onlyTo: "me@setustore.test" }))
      .toMatchObject({ ok: true, message: "Saved: sender, reply address, test list." });
    const after = await call(mailPage.loader, "/app/mail?view=settings");
    expect(after.settings).toMatchObject({ fromName: "Setu Store", fromAddress: "support@setustore.test", fromSource: "app", replyTo: "help@setustore.test", onlyTo: ["me@setustore.test"], updatedBy: "team@setustore.test" });
    expect(after.mode).toMatchObject({ real: false, replyTo: "help@setustore.test" });
    // No key is saved, so the check has nothing to ask Resend and says what is missing.
    const checked = await post({ intent: "settings_check" });
    expect(checked).toMatchObject({ ok: true });
    expect(checked.checks.find((c: { what: string }) => c.what === "Resend key")).toMatchObject({ tone: "bad" });
    expect(checked.checks.find((c: { what: string }) => c.what === "Reply address")).toMatchObject({ tone: "ok", text: "A reply to a mail goes to help@setustore.test." });
    expect((await db.auditLog.findFirstOrThrow({ where: { shop, action: "mail.settings_updated" } })).detail).toEqual({ changed: ["sender", "reply address", "test list"] });
    await db.mailSetting.deleteMany({ where: { shop } });
  });

  it("an order webhook mails the vendor's team once the order is copied", async () => {
    await db.mailMessage.deleteMany({ where: { shop } });
    const fresh = orders();
    for (const o of fresh) o.createdAt = new Date().toISOString();
    who.orders = fresh;
    const order = fresh[0]; // #1001, Urban Store only
    await db.vendorOrderLine.deleteMany({ where: { shop, orderId: BigInt(order.id.split("/").pop()!) } });
    const urban = await db.vendor.upsert({ where: { shop_vendorName: { shop, vendorName: "Urban Store" } }, create: { shop, vendorName: "Urban Store", displayName: "Urban Store" }, update: { status: "active" } });
    await db.vendorUser.upsert({
      where: { shop_email: { shop, email: "packer@urban.example" } },
      create: { shop, vendorId: urban.id, email: "packer@urban.example", name: "Packer", status: "active", role: "staff", access: "view" },
      update: { status: "active", vendorId: urban.id },
    });
    who.webhook = { shop, topic: "ORDERS_CREATE", payload: { id: Number(order.id.split("/").pop()), admin_graphql_api_id: order.id } };
    await call(webhook.action, "/webhooks/orders", {});
    await drainOrderQueue(shop);
    who.webhook = { shop, topic: "ORDERS_UPDATED", payload: { id: Number(order.id.split("/").pop()), admin_graphql_api_id: order.id } };
    await call(webhook.action, "/webhooks/orders", {});
    await drainOrderQueue(shop);
    const sent = await db.mailMessage.findMany({ where: { shop, template: "order_new", toEmail: "packer@urban.example" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: "New order #1001 for Urban Store", status: "queued", vendorId: urban.id });
    who.orders = orders();
  });
});
