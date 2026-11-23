import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COOKIE_NAME, createInviteLink, getIdentity, resetPassword, signIn, signUp } from "../app/lib/portal/auth.server";
import { addVendorUser, enableVendor } from "../app/lib/vendors/vendors.server";
import {
  addStaff, adminUpdateUser, changeRequestState, listAllVendors, ownerRemoveStaff, ownerUpdateStaff,
  requestBusinessChange, reviewBusinessChange, updateBrand, withdrawBusinessChange, type Me,
} from "../app/lib/vendors/team.server";
import * as profile from "../app/routes/portal.profile";
import * as team from "../app/routes/portal.team";
import * as layout from "../app/routes/portal";

/**
 * Roles, staff access and business-change approval.
 * Shop = PORTAL_SHOP from vitest.config.ts, so page loaders/actions work too.
 */

const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
const PW = "Strong-test-password-1";
const ctx = { shop };
afterAll(() => db.$disconnect());

async function cleanup() {
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.passwordReset.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorChangeRequest.deleteMany({ where: { shop } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
}

/** An owner (invited by the team, signed up), returned as a Me + cookie. */
async function owner(vendorName: string, email: string) {
  const v = await enableVendor(db, shop, vendorName, "test");
  await addVendorUser(db, shop, v.id, email, "Owner", "test");
  const r = await signUp(db, { name: "Owner", email, password: PW, phone: "+91 98765 43210", brandName: vendorName, city: "Jaipur", state: "Rajasthan", gstNumber: "08ABCDE1234F1Z5" }, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const me = await meFor(r.token);
  return { vendor: v, me, cookie: cookieOf(r.token) };
}
const cookieOf = (token: string) => `${COOKIE_NAME}=${encodeURIComponent(token)}`;
async function meFor(token: string): Promise<Me> {
  const id = await getIdentity(db, shop, token);
  if (!id?.vendor) throw new Error("not active");
  return { shop, user: id.user, vendor: id.vendor };
}

/** Owner adds staff; staff sets password from the invite link and signs in. */
async function staff(o: Me, email: string, access: "view" | "edit") {
  const added = await addStaff(db, o, { email, name: "Staff", access });
  if (!added.ok) throw new Error(added.error);
  const token = await createInviteLink(db, added.userId, ctx);
  expect(await resetPassword(db, token, PW, ctx)).toEqual({ ok: true });
  const s = await signIn(db, email, PW, ctx);
  if (!s.ok) throw new Error("staff can't sign in");
  return { me: await meFor(s.token), cookie: cookieOf(s.token), id: added.userId };
}

const post = (path: string, cookie: string, fields: Record<string, string>) =>
  new Request("https://portal.test" + path, { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(fields) });
type Fn = (a: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
async function run(fn: unknown, request: Request) {
  try {
    return { data: await (fn as Fn)({ request, params: {}, context: {} }) as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Response) return { location: e.headers.get("Location"), status: e.status };
    throw e;
  }
}
const get = (path: string, cookie: string) => new Request("https://portal.test" + path, { headers: { Cookie: cookie } });

beforeEach(cleanup);

describe("brand details", () => {
  it("owners and view-and-edit staff save them at once; view-only staff can't", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const editor = await staff(o, "edit@ashnur.example", "edit");
    const viewer = await staff(o, "view@ashnur.example", "view");

    expect(await updateBrand(db, o, { description: "By owner", minimumOrderValue: "2,500" })).toEqual({ ok: true });
    expect(await updateBrand(db, editor.me, { description: "By editor" })).toEqual({ ok: true });
    expect((await updateBrand(db, viewer.me, { description: "By viewer" })).ok).toBe(false);
    expect((await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Ashnur" } })).description).toBe("By editor");

    // Through the real page action, with the viewer's cookie.
    const r = await run(profile.action, post("/portal/profile", viewer.cookie, { intent: "brand", description: "Sneaky" }));
    expect(r.data?.ok).toBe(false);
    expect((await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Ashnur" } })).description).toBe("By editor");
  });

  it("checks the minimum order value", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const r = await updateBrand(db, o, { minimumOrderValue: "lots" });
    expect(r.ok).toBe(false);
  });
});

describe("business details", () => {
  it("nothing changes until the team approves; approving applies exactly the requested values", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    expect(await requestBusinessChange(db, o, { displayName: "Ashnur Studio", gstNumber: "08ABCDE1234F1Z5", phone: "+91 90000 00000", city: "Udaipur", state: "Rajasthan" })).toEqual({ ok: true });

    let v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(v.displayName).toBe("Ashnur");
    expect(v.city).toBe("Jaipur");

    const state = await changeRequestState(db, shop, vendor.id);
    expect(Object.keys(state.pending!.changes).sort()).toEqual(["city", "displayName", "phone"]); // GST and state unchanged
    expect(await reviewBusinessChange(db, shop, state.pending!.id, "approve", null, "admin:test")).toEqual({ ok: true });

    v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect([v.displayName, v.city, v.phone, v.gstNumber]).toEqual(["Ashnur Studio", "Udaipur", "+91 90000 00000", "08ABCDE1234F1Z5"]);
    expect(v.vendorName).toBe("Ashnur"); // the Shopify vendor link never changes
    expect((await changeRequestState(db, shop, vendor.id)).pending).toBeNull();
  });

  it("a new request replaces the waiting one; declining keeps the details and tells the vendor why", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    const base = { displayName: "Ashnur", gstNumber: "08ABCDE1234F1Z5", phone: "+91 98765 43210", state: "Rajasthan" };
    await requestBusinessChange(db, o, { ...base, city: "Udaipur" });
    await requestBusinessChange(db, o, { ...base, city: "Jodhpur" });
    expect(await db.vendorChangeRequest.count({ where: { vendorId: vendor.id, status: "pending" } })).toBe(1);
    const { pending } = await changeRequestState(db, shop, vendor.id);
    expect(pending!.changes.city!.to).toBe("Jodhpur");

    await reviewBusinessChange(db, shop, pending!.id, "reject", "Please send a GST certificate for the new address.", "admin:test");
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).city).toBe("Jaipur");
    const after = await changeRequestState(db, shop, vendor.id);
    expect(after.last?.status).toBe("rejected");
    expect(after.last?.note).toMatch(/GST certificate/);
    expect((await reviewBusinessChange(db, shop, pending!.id, "approve", null, "admin:test")).ok).toBe(false); // already decided
  });

  it("refuses an unchanged request, can be withdrawn, and view-only staff can't send one", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    const same = { displayName: "Ashnur", gstNumber: "08ABCDE1234F1Z5", phone: "+91 98765 43210", city: "Jaipur", state: "Rajasthan" };
    expect((await requestBusinessChange(db, o, same)).ok).toBe(false);
    await requestBusinessChange(db, o, { ...same, city: "Ajmer" });
    expect(await withdrawBusinessChange(db, o)).toEqual({ ok: true });
    expect((await changeRequestState(db, shop, vendor.id)).pending).toBeNull();

    const viewer = await staff(o, "view@ashnur.example", "view");
    expect((await requestBusinessChange(db, viewer.me, { ...same, city: "Ajmer" })).ok).toBe(false);
    expect((await requestBusinessChange(db, o, { ...same, gstNumber: "NOTAGST" })).ok).toBe(false);
  });
});

describe("people", () => {
  it("an owner's staff become active once they set a password from the invite", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const s = await staff(o, "Staff@Ashnur.example", "view");
    expect(s.me.user).toMatchObject({ email: "staff@ashnur.example", role: "staff", access: "view" });
    expect(s.me.vendor.id).toBe(o.vendor.id);
  });

  it("only owners see the Team page and manage staff", async () => {
    const { me: o, cookie } = await owner("Ashnur", "o@ashnur.example");
    const editor = await staff(o, "edit@ashnur.example", "edit");

    expect((await run(team.loader, get("/portal/team", editor.cookie))).location).toBe("/portal");
    expect((await run(team.action, post("/portal/team", editor.cookie, { intent: "add", email: "x@ashnur.example", access: "edit" }))).location).toBe("/portal");
    expect((await addStaff(db, editor.me, { email: "x@ashnur.example", name: "", access: "edit" })).ok).toBe(false);
    expect((await ownerUpdateStaff(db, editor.me, editor.id, { access: "edit" })).ok).toBe(false);
    expect(await db.vendorUser.count({ where: { shop, email: "x@ashnur.example" } })).toBe(0);

    const nav = (await run(layout.loader, get("/portal", editor.cookie))).data!;
    expect(nav.owner).toBe(false);
    expect((await run(layout.loader, get("/portal", cookie))).data!.owner).toBe(true);
    expect((await run(team.loader, get("/portal/team", cookie))).data!.people).toHaveLength(2);
  });

  it("deactivating staff signs them out; owners can't touch owners or another vendor's people", async () => {
    const { me: a } = await owner("Ashnur", "o@ashnur.example");
    const { me: u } = await owner("Urban Store", "o@urban.example");
    const s = await staff(a, "s@ashnur.example", "edit");

    expect(await ownerUpdateStaff(db, a, s.id, { status: "disabled" })).toEqual({ ok: true });
    expect(await getIdentity(db, shop, decodeURIComponent(s.cookie.split("=")[1]))).toBeNull();
    expect((await signIn(db, "s@ashnur.example", PW, ctx)).ok).toBe(false);
    expect(await ownerUpdateStaff(db, a, s.id, { status: "active" })).toEqual({ ok: true });
    expect((await signIn(db, "s@ashnur.example", PW, ctx)).ok).toBe(true);

    expect((await ownerUpdateStaff(db, u, s.id, { status: "disabled" })).ok).toBe(false); // other vendor
    expect((await ownerRemoveStaff(db, u, s.id)).ok).toBe(false);
    expect((await ownerUpdateStaff(db, a, a.user.id, { status: "disabled" })).ok).toBe(false); // an owner
    expect((await addStaff(db, a, { email: "o@urban.example", name: "", access: "edit" })).ok).toBe(false); // taken email

    expect(await ownerRemoveStaff(db, a, s.id)).toEqual({ ok: true });
    expect(await db.vendorUser.count({ where: { shop, email: "s@ashnur.example" } })).toBe(0);
  });

  it("staff can't reactivate themselves after the team sets 'Requires approval'", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const s = await staff(o, "s@ashnur.example", "edit");
    expect(await adminUpdateUser(db, shop, s.id, { status: "pending" }, "admin:test")).toEqual({ ok: true });
    expect((await ownerUpdateStaff(db, o, s.id, { status: "active" })).ok).toBe(false);
    const again = await signIn(db, "s@ashnur.example", PW, ctx);
    expect(again.ok && again.status).toBe("pending"); // sees only "under review", no orders
    const id = await getIdentity(db, shop, again.ok ? again.token : null);
    expect(id?.vendor).toBeNull();
  });
});

describe("team controls in Shopify admin", () => {
  it("change status, role and access; leaving Active ends sessions", async () => {
    const { me: o, cookie } = await owner("Ashnur", "o@ashnur.example");
    const s = await staff(o, "s@ashnur.example", "view");

    expect(await adminUpdateUser(db, shop, s.id, { role: "owner" }, "admin:test")).toEqual({ ok: true });
    expect((await getIdentity(db, shop, decodeURIComponent(s.cookie.split("=")[1])))?.user.role).toBe("owner");

    expect(await adminUpdateUser(db, shop, o.user.id, { status: "disabled" }, "admin:test")).toEqual({ ok: true });
    expect(await getIdentity(db, shop, decodeURIComponent(cookie.split("=")[1]))).toBeNull();
    expect((await adminUpdateUser(db, shop, o.user.id, { status: "nonsense" }, "admin:test")).ok).toBe(false);
  });

  it("activating someone who never set a password keeps them 'Invited'", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const added = await addStaff(db, o, { email: "new@ashnur.example", name: "", access: "view" });
    if (!added.ok) throw new Error();
    await adminUpdateUser(db, shop, added.userId, { status: "disabled" }, "admin:test");
    await adminUpdateUser(db, shop, added.userId, { status: "active" }, "admin:test");
    expect((await db.vendorUser.findUniqueOrThrow({ where: { id: added.userId } })).status).toBe("invited");
  });

  it("the All vendors list counts people and flags waiting changes", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    await staff(o, "s@ashnur.example", "view");
    await requestBusinessChange(db, o, { displayName: "Ashnur", city: "Ajmer", state: "Rajasthan", gstNumber: "08ABCDE1234F1Z5", phone: "+91 98765 43210" });
    const [row] = await listAllVendors(db, shop);
    expect(row).toMatchObject({ vendorName: "Ashnur", people: 2, staff: 1, active: 2, pendingChange: true, owners: ["Owner"] });
  });
});
