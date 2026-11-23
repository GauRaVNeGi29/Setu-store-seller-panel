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
const who = vi.hoisted(() => ({ shop: "seller-panel-dev.myshopify.com", orders: [] as unknown[], webhook: null as null | Record<string, unknown> }));
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: who.shop, onlineAccessInfo: { associated_user: { email: "team@setustore.test" } } },
      admin: { graphql: fakeShopify(who.orders as ShopifyOrder[]) },
    }),
    webhook: async () => ({ ...who.webhook, admin: { graphql: fakeShopify(who.orders as ShopifyOrder[]) } }),
  },
}));

const { signIn, signUp, getIdentity, createInviteLink, resetPassword } = await import("../app/lib/portal/auth.server");
const { addStaff, requestBusinessChange } = await import("../app/lib/vendors/team.server");
const { configureOrderQueue, drainOrderQueue } = await import("../app/lib/orders/queue.server");
const appShell = await import("../app/routes/app");
const home = await import("../app/routes/app._index");
const allVendors = await import("../app/routes/app.vendors");
const vendorPage = await import("../app/routes/app.vendor");
const signups = await import("../app/routes/app.signups");
const webhook = await import("../app/routes/webhooks.orders");

const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
const PW = "Strong-test-password-1";
const orders = () => structuredClone(fixture.orders) as ShopifyOrder[];
afterAll(() => db.$disconnect());

type Fn = (a: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
async function call(fn: unknown, path: string, fields?: Record<string, string>) {
  const request = new Request("https://app.test" + path, fields ? { method: "POST", body: new URLSearchParams(fields) } : {});
  try {
    return (await (fn as Fn)({ request, params: {}, context: {} })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.syncState.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
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

describe("Vendors and orders (home)", () => {
  it("Resync all orders copies the dev store's orders and the overview adds up", async () => {
    const r = await call(home.action, "/app", { intent: "resync" });
    expect(r).toMatchObject({ ok: true, orders: 5 });
    const page = await call(home.loader, "/app");
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

    await call(home.action, "/app", { intent: "resync" }); // put it back
  });
});

describe("Sign-ups page", () => {
  it("lists waiting sign-ups with the store's vendor names, approves one and declines another", async () => {
    await signUp(db, { name: "Harpreet", email: "owner@urban.example", password: PW, phone: "+91 98140 12345", brandName: "Urban Store", city: "Ludhiana", state: "Punjab", description: "Sunglasses and watches" }, { shop });
    await signUp(db, { name: "Spam", email: "spam@nowhere.example", password: PW, phone: "+91 90000 00000", brandName: "Nope", city: "X", state: "Y" }, { shop });
    const page = await call(signups.loader, "/app/signups");
    expect(page.pending.map((s: { email: string }) => s.email).sort()).toEqual(["owner@urban.example", "spam@nowhere.example"]);
    expect(page.shopifyVendors).toEqual(["Ashnur", "Urban Store"]);

    expect(await call(signups.action, "/app/signups", { intent: "approve", userId: await userId("owner@urban.example"), vendorName: "" })).toMatchObject({ ok: false });
    expect(await call(signups.action, "/app/signups", { intent: "approve", userId: await userId("owner@urban.example"), vendorName: "Urban Store" })).toMatchObject({ ok: true });
    expect(await call(signups.action, "/app/signups", { intent: "reject", userId: await userId("spam@nowhere.example") })).toMatchObject({ ok: true });

    const u = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "owner@urban.example" }, include: { vendor: true } });
    expect([u.status, u.role, u.vendor?.vendorName, u.vendor?.description]).toEqual(["active", "owner", "Urban Store", "Sunglasses and watches"]);
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
    expect(page.profile.description).toBe("Sunglasses and watches");
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

  it("business change: approve updates the details, decline keeps them and stores the reason", async () => {
    const t = await signIn(db, "owner@urban.example", PW, { shop });
    if (!t.ok) throw new Error();
    const me = (await getIdentity(db, shop, t.token))!;
    const meArg = { shop, user: me.user, vendor: me.vendor! };
    await requestBusinessChange(db, meArg, { displayName: "Urban Store Pvt Ltd", city: "Chandigarh", state: "Punjab", phone: "+91 98140 12345" });

    let page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.change.pending.changes.city).toEqual({ from: "Ludhiana", to: "Chandigarh" });
    expect((await call(allVendors.loader, "/app/vendors")).vendors[0].pendingChange).toBe(true);
    expect(await vendorPost({ intent: "approve_change", requestId: page.change.pending.id })).toMatchObject({ ok: true });
    page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect([page.profile.displayName, page.profile.city]).toEqual(["Urban Store Pvt Ltd", "Chandigarh"]);

    await requestBusinessChange(db, meArg, { displayName: "Urban Store Pvt Ltd", city: "Mohali", state: "Punjab", phone: "+91 98140 12345" });
    page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(await vendorPost({ intent: "reject_change", requestId: page.change.pending.id, note: "Need proof of address" })).toMatchObject({ ok: true });
    page = await call(vendorPage.loader, "/app/vendor?name=Urban%20Store");
    expect(page.profile.city).toBe("Chandigarh");
    expect(page.change.last).toMatchObject({ status: "rejected", note: "Need proof of address" });
  });

  it("the team edits details directly, with checks", async () => {
    const base = { intent: "details", displayName: "Urban Store", gstNumber: "03ABCDE1234F1Z5", phone: "+91 98140 12345", city: "Ludhiana", state: "Punjab", minimumOrderValue: "1500", productNote: "Sunglasses", description: "New text", policy: "3 days" };
    expect(await vendorPost(base)).toMatchObject({ ok: true });
    expect(await vendorPost({ ...base, gstNumber: "BAD" })).toMatchObject({ ok: false });
    expect(await vendorPost({ ...base, minimumOrderValue: "a lot" })).toMatchObject({ ok: false });
    const v = await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Urban Store" } });
    expect([v.displayName, v.description, v.minimumOrderValue?.toFixed(2), v.gstNumber]).toEqual(["Urban Store", "New text", "1500.00", "03ABCDE1234F1Z5"]);
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
