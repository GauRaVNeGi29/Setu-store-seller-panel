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
const allVendors = await import("../app/routes/app.vendors");
const vendorPage = await import("../app/routes/app.vendor");
const signups = await import("../app/routes/app.signups");
const webhook = await import("../app/routes/webhooks.orders");
const fileRoute = await import("../app/routes/app.files.$fileId");

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

describe("Vendors and orders", () => {
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
    expect((await call(home.loader, "/app/orders")).portalUrl).toBe("https://app.test");
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

describe("Dashboard (the app's home)", () => {
  const save = (min: string, max: string) => call(dashboard.action, "/app", { intent: "delivery_time", deliveryDaysMin: min, deliveryDaysMax: max });

  it("lists what is waiting for the team, with the vendors concerned", async () => {
    const page = await call(dashboard.loader, "/app");
    const all = await db.vendor.findMany({ where: { shop } });
    expect(page.numbers.vendors).toBe(all.length);
    expect(page.attention.noProcessingTime.map((v: { vendorName: string }) => v.vendorName).sort())
      .toEqual(all.filter((v) => v.processingDaysMin === null).map((v) => v.vendorName).sort());
    expect(page.attention.signups).toBe(await db.vendorUser.count({ where: { shop, status: "pending" } }));
    expect(page.vendors.find((v: { vendorName: string }) => v.vendorName === "Urban Store").processing).toEqual({ min: 10, max: 15 });
    expect(page.delivery).toMatchObject({ range: null, error: null });
    expect(page.portalUrl).toBe("https://app.test");
  });

  it("saves the delivery time, says who set it, and keeps a record", async () => {
    expect(await save("5", "7")).toEqual({ ok: true, range: { min: 5, max: 7 }, onStore: true });
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "5", "setu_seller.delivery_days_max": "7" });
    const page = await call(dashboard.loader, "/app");
    expect(page.delivery).toMatchObject({ range: { min: 5, max: 7 }, updatedBy: "team@setustore.test" });
    const log = await db.auditLog.findFirstOrThrow({ where: { shop, action: "settings.delivery_time_updated" }, orderBy: { at: "desc" } });
    expect(log.detail).toEqual({ from: null, to: { min: 5, max: 7 } });
  });

  it("refuses a range that makes no sense and keeps the saved one", async () => {
    for (const [a, b] of [["7", "5"], ["5", ""], ["", "7"], ["2.5", "4"], ["-1", "3"], ["0", "0"], ["5", "400"], ["soon", "later"]]) {
      expect(await save(a, b), `${a}–${b}`).toMatchObject({ ok: false });
    }
    expect((await call(dashboard.loader, "/app")).delivery.range).toEqual({ min: 5, max: 7 });
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "5", "setu_seller.delivery_days_max": "7" });
  });

  it("the same number twice is a single figure; both boxes empty removes it", async () => {
    expect(await save("6", "6")).toMatchObject({ ok: true, range: { min: 6, max: 6 } });
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "6", "setu_seller.delivery_days_max": "6" });
    expect(await save("", "")).toMatchObject({ ok: true, range: null, onStore: true });
    expect((await call(dashboard.loader, "/app")).delivery.range).toBeNull();
    expect(who.app.metafields.size).toBe(0);
  });

  it("when Shopify refuses, the setting is kept, the reason is shown, and sending again fixes it", async () => {
    who.app.deny = true;
    const r = await save("4", "9");
    expect(r).toMatchObject({ ok: true, range: { min: 4, max: 9 }, onStore: false });
    expect(r.error).toMatch(/isn't allowed|Shopify said/);
    let page = await call(dashboard.loader, "/app");
    expect(page.delivery.range).toEqual({ min: 4, max: 9 });
    expect(page.delivery.error).toBe(r.error);
    expect(who.app.metafields.size).toBe(0);
    who.app.deny = false;
    expect(await call(dashboard.action, "/app", { intent: "delivery_resend" })).toEqual({ ok: true, range: { min: 4, max: 9 }, onStore: true });
    page = await call(dashboard.loader, "/app");
    expect(page.delivery.error).toBeNull();
    expect(Object.fromEntries(who.app.metafields)).toEqual({ "setu_seller.delivery_days_min": "4", "setu_seller.delivery_days_max": "9" });
  });

  it("each shop has its own setting", async () => {
    await save("3", "4");
    expect(await db.shopSetting.count({ where: { shop: { not: shop } } })).toBe(0);
    expect(await call(dashboard.action, "/app", { intent: "something_else" })).toMatchObject({ ok: false });
  });
});
