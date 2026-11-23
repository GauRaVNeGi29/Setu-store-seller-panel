import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COOKIE_NAME, TEAM_VIEW_MS, createInviteLink, createTeamHandoff, getIdentity, redeemTeamHandoff, resetPassword, signIn, signUp } from "../app/lib/portal/auth.server";
import { addVendorUser, enableVendor, setVendorStatus } from "../app/lib/vendors/vendors.server";
import {
  addStaff, adminUpdateUser, changeRequestState, listAllVendors, ownerRemoveStaff, ownerUpdateStaff,
  requestBusinessChange, reviewBusinessChange, updateBrand, withdrawBusinessChange, type Me,
} from "../app/lib/vendors/team.server";
import * as profile from "../app/routes/portal.profile";
import * as team from "../app/routes/portal.team";
import * as layout from "../app/routes/portal";
import * as files from "../app/routes/portal.files.$fileId";
import * as teamView from "../app/routes/portal_.view";

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
  await db.vendorFile.deleteMany({ where: { shop } });
  await db.portalHandoff.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
}

/** An owner (invited by the team, signed up), returned as a Me + cookie. */
async function owner(vendorName: string, email: string) {
  const v = await enableVendor(db, shop, vendorName, "test");
  await addVendorUser(db, shop, v.id, email, "Owner", "test");
  const r = await signUp(db, { name: "Owner", email, password: PW, phone: "+91 98765 43210" }, ctx);
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
async function run(fn: unknown, request: Request, params: Record<string, string> = {}) {
  try {
    return { data: await (fn as Fn)({ request, params, context: {} }) as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Response) return { location: e.headers.get("Location"), status: e.status };
    throw e;
  }
}
const get = (path: string, cookie: string) => new Request("https://portal.test" + path, { headers: { Cookie: cookie } });

beforeEach(cleanup);

const PDF = () => Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PNG = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const file = (bytes: Buffer, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });
const fd = (o: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const ADDRESS = { companyName: "Ashnur Crafts Pvt Ltd", addressLine: "12 MI Road", city: "Jaipur", state: "Rajasthan", postalCode: "302001" };
const multipart = (path: string, cookie: string, body: FormData) =>
  new Request("https://portal.test" + path, { method: "POST", headers: { Cookie: cookie }, body });

describe("seller details", () => {
  it("everyone – even view-only staff – edits their own name and phone; email can't change", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const viewer = await staff(o, "view@ashnur.example", "view");
    const r = await run(profile.action, post("/portal/profile", viewer.cookie, { intent: "seller", name: "Asha", phone: "+91 90000 11111", email: "evil@x.example" }));
    expect(r.location).toBe("/portal/profile?saved=seller");
    const u = await db.vendorUser.findUniqueOrThrow({ where: { id: viewer.id } });
    expect([u.name, u.phone, u.email]).toEqual(["Asha", "+91 90000 11111", "view@ashnur.example"]);
    expect((await run(profile.action, post("/portal/profile", viewer.cookie, { intent: "seller", name: "", phone: "1" }))).data?.errors).toMatchObject({ name: expect.any(String), phone: expect.any(String) });
  });
});

describe("brand details", () => {
  it("owners and view-and-edit staff save them at once; view-only staff can't", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const editor = await staff(o, "edit@ashnur.example", "edit");
    const viewer = await staff(o, "view@ashnur.example", "view");

    expect(await updateBrand(db, o, { description: "By owner", shortDescription: "Candles", minimumOrderValue: "2,500" })).toEqual({ ok: true });
    expect(await updateBrand(db, editor.me, { description: "By editor", minimumOrderValue: "2500" })).toEqual({ ok: true });
    expect((await updateBrand(db, viewer.me, { description: "By viewer", minimumOrderValue: "1" })).ok).toBe(false);
    const v = await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Ashnur" } });
    expect([v.description, v.shortDescription, v.minimumOrderValue?.toFixed(2)]).toEqual(["By editor", null, "2500.00"]);

    // Through the real page action, with the viewer's cookie.
    const r = await run(profile.action, post("/portal/profile", viewer.cookie, { intent: "brand", description: "Sneaky", minimumOrderValue: "1" }));
    expect(r.data?.ok).toBe(false);
    expect((await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Ashnur" } })).description).toBe("By editor");
  });

  it("minimum order value is required and must be an amount; short description is one line", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    expect((await updateBrand(db, o, { description: "x" })).ok).toBe(false);
    expect((await updateBrand(db, o, { minimumOrderValue: "lots" })).ok).toBe(false);
    expect((await updateBrand(db, o, { minimumOrderValue: "100", shortDescription: "x".repeat(161) })).ok).toBe(false);
  });

  it("logo and banner upload, show up, can be replaced and removed", async () => {
    const { me: o, vendor, cookie } = await owner("Ashnur", "o@ashnur.example");
    const r = await run(profile.action, multipart("/portal/profile", cookie, fd({ intent: "brand", minimumOrderValue: "1000", logoFile: file(PNG(), "logo.png", "image/png"), bannerFile: file(PNG(), "banner.png", "image/png") })));
    expect(r.location).toBe("/portal/profile?saved=brand");
    let v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(v.logoFileId && v.bannerFileId).toBeTruthy();
    const firstLogo = v.logoFileId!;

    await updateBrand(db, o, fd({ minimumOrderValue: "1000", logoFile: file(PNG(), "logo-2.png", "image/png"), remove_bannerFile: "1" }));
    v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(v.logoFileId).not.toBe(firstLogo);
    expect(v.bannerFileId).toBeNull();
    expect(await db.vendorFile.count({ where: { vendorId: vendor.id } })).toBe(1); // replaced and removed files are deleted
  });
});

describe("files", () => {
  it("refuses wrong types, disguised files, SVG and files over the limit – and stores nothing", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const big = Buffer.concat([PDF(), Buffer.alloc(5 * 1024 * 1024)]);
    const tries: [string, File][] = [
      ["gstFile", file(html, "gst.pdf", "application/pdf")], // HTML pretending to be a PDF
      ["gstFile", file(PNG().subarray(0, 4), "gst.png", "image/png")], // broken image
      ["iecFile", file(big, "iec.pdf", "application/pdf")], // too large
    ];
    for (const [field, f] of tries) {
      const r = await requestBusinessChange(db, o, fd({ ...ADDRESS, [field]: f }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors?.[field]).toBeTruthy();
    }
    const logo = await updateBrand(db, o, fd({ minimumOrderValue: "1", logoFile: file(svg, "logo.svg", "image/svg+xml") }));
    expect(logo.ok).toBe(false);
    const pdfLogo = await updateBrand(db, o, fd({ minimumOrderValue: "1", logoFile: file(PDF(), "logo.pdf", "application/pdf") }));
    expect(pdfLogo.ok).toBe(false);
    expect(await db.vendorFile.count({ where: { vendorId: vendor.id } })).toBe(0);
    expect(await db.vendorChangeRequest.count({ where: { vendorId: vendor.id } })).toBe(0);
  });

  it("a vendor's files open only for its own people; another vendor or a signed-out visitor gets nothing", async () => {
    const { me: a, cookie: aCookie, vendor } = await owner("Ashnur", "o@ashnur.example");
    const { cookie: uCookie } = await owner("Urban Store", "o@urban.example");
    await requestBusinessChange(db, a, fd({ ...ADDRESS, gstFile: file(PDF(), "GST cert (2025).pdf", "application/pdf") }));
    const id = (await db.vendorFile.findFirstOrThrow({ where: { vendorId: vendor.id } })).id;

    const own = await run(files.loader, get(`/portal/files/${id}`, aCookie), { fileId: id }) as { data?: unknown };
    const res = own.data as unknown as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    const other = (await run(files.loader, get(`/portal/files/${id}`, uCookie), { fileId: id })).data as unknown as Response;
    expect(other.status).toBe(404);
    expect((await run(files.loader, get(`/portal/files/${id}`, ""), { fileId: id })).location).toBe("/portal/login");
  });
});

describe("business details", () => {
  it("nothing changes until the team approves; approving applies text and documents", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    const r = await requestBusinessChange(db, o, fd({ ...ADDRESS, gstFile: file(PDF(), "gst.pdf", "application/pdf"), iecFile: file(PNG(), "iec.png", "image/png") }));
    expect(r).toEqual({ ok: true });

    let v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect([v.companyName, v.gstFileId]).toEqual([null, null]);

    const state = await changeRequestState(db, shop, vendor.id);
    expect(Object.keys(state.pending!.changes).sort()).toEqual(["addressLine", "city", "companyName", "gstFileId", "iecFileId", "postalCode", "state"]);
    expect(state.files[state.pending!.changes.gstFileId!.to!].fileName).toBe("gst.pdf");
    expect(await reviewBusinessChange(db, shop, state.pending!.id, "approve", null, "admin:test")).toEqual({ ok: true });

    v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect([v.companyName, v.addressLine, v.city, v.state, v.postalCode]).toEqual(["Ashnur Crafts Pvt Ltd", "12 MI Road", "Jaipur", "Rajasthan", "302001"]);
    expect(v.gstFileId && v.iecFileId).toBeTruthy();
    expect(v.vendorName).toBe("Ashnur"); // the Shopify vendor link never changes
    expect((await changeRequestState(db, shop, vendor.id)).pending).toBeNull();

    // Replacing a document: the old one is deleted once the new one is approved.
    const oldGst = v.gstFileId!;
    await requestBusinessChange(db, o, fd({ ...ADDRESS, gstFile: file(PDF(), "gst-new.pdf", "application/pdf") }));
    const p2 = (await changeRequestState(db, shop, vendor.id)).pending!;
    expect(Object.keys(p2.changes)).toEqual(["gstFileId"]);
    await reviewBusinessChange(db, shop, p2.id, "approve", null, "admin:test");
    expect(await db.vendorFile.count({ where: { id: oldGst } })).toBe(0);
  });

  it("company name and full address are required; PIN code is 6 digits", async () => {
    const { me: o } = await owner("Ashnur", "o@ashnur.example");
    const r = await requestBusinessChange(db, o, { companyName: "", addressLine: "", city: "", state: "", postalCode: "12" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors ?? {}).sort()).toEqual(["addressLine", "city", "companyName", "postalCode", "state"]);
  });

  it("a new request replaces the waiting one and keeps its files; declining keeps the details and deletes the files", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    await requestBusinessChange(db, o, fd({ ...ADDRESS, gstFile: file(PDF(), "gst.pdf", "application/pdf") }));
    await requestBusinessChange(db, o, { ...ADDRESS, city: "Jodhpur" });
    expect(await db.vendorChangeRequest.count({ where: { vendorId: vendor.id, status: "pending" } })).toBe(1);
    const { pending } = await changeRequestState(db, shop, vendor.id);
    expect(pending!.changes.city!.to).toBe("Jodhpur");
    expect(pending!.changes.gstFileId!.to).toBeTruthy(); // kept from the first request

    await reviewBusinessChange(db, shop, pending!.id, "reject", "Please send a GST certificate for the new address.", "admin:test");
    const v = await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect([v.city, v.gstFileId]).toEqual([null, null]);
    expect(await db.vendorFile.count({ where: { vendorId: vendor.id } })).toBe(0);
    const after = await changeRequestState(db, shop, vendor.id);
    expect(after.last?.status).toBe("rejected");
    expect(after.last?.note).toMatch(/GST certificate/);
    expect((await reviewBusinessChange(db, shop, pending!.id, "approve", null, "admin:test")).ok).toBe(false); // already decided
  });

  it("refuses an unchanged request, can be withdrawn (deleting its files), and view-only staff can't send one", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    await requestBusinessChange(db, o, ADDRESS);
    await reviewBusinessChange(db, shop, (await changeRequestState(db, shop, vendor.id)).pending!.id, "approve", null, "admin:test");
    expect((await requestBusinessChange(db, o, ADDRESS)).ok).toBe(false);
    await requestBusinessChange(db, o, fd({ ...ADDRESS, city: "Ajmer", adCodeFile: file(PDF(), "ad.pdf", "application/pdf") }));
    expect(await withdrawBusinessChange(db, o)).toEqual({ ok: true });
    expect((await changeRequestState(db, shop, vendor.id)).pending).toBeNull();
    expect(await db.vendorFile.count({ where: { vendorId: vendor.id } })).toBe(0);

    const viewer = await staff(o, "view@ashnur.example", "view");
    expect((await requestBusinessChange(db, viewer.me, { ...ADDRESS, city: "Ajmer" })).ok).toBe(false);
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
    await requestBusinessChange(db, o, ADDRESS);
    const [row] = await listAllVendors(db, shop);
    expect(row).toMatchObject({ vendorName: "Ashnur", people: 2, staff: 1, active: 2, pendingChange: true, owners: ["Owner"], missing: ["company name", "business address", "minimum order value"] });
  });
});

describe("team view from Shopify admin", () => {
  it("a one-time link opens a read-only, one-hour view of the vendor's portal as its owner", async () => {
    const { me: o, vendor } = await owner("Ashnur", "o@ashnur.example");
    await staff(o, "s@ashnur.example", "edit");
    const h = await createTeamHandoff(db, shop, vendor.id, "admin:team@setustore.test");
    if (!h.ok) throw new Error(h.error);

    const r = await run(teamView.loader, get(`/portal/view?token=${h.token}`, ""));
    expect(r.location).toBe("/portal");
    const again = await run(teamView.loader, get(`/portal/view?token=${h.token}`, ""));
    expect(again.location).toBeUndefined(); // used once – shows "expired"

    const s = await db.portalSession.findFirstOrThrow({ where: { teamViewer: "admin:team@setustore.test" }, include: { vendorUser: true } });
    expect(s.vendorUser.email).toBe("o@ashnur.example"); // views as the owner
    expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBe(TEAM_VIEW_MS);
    expect(await db.auditLog.count({ where: { shop, action: "portal.team_view_opened" } })).toBe(1);
  });

  it("can read every page but change nothing", async () => {
    const { vendor } = await owner("Ashnur", "o@ashnur.example");
    const h = await createTeamHandoff(db, shop, vendor.id, "admin:team@setustore.test");
    if (!h.ok) throw new Error(h.error);
    const s = await redeemTeamHandoff(db, h.token, { shop });
    const cookie = cookieOf(s!.token);

    const nav = (await run(layout.loader, get("/portal", cookie))).data!;
    expect(nav.teamView).toMatchObject({ by: "team@setustore.test" });
    expect(nav.owner).toBe(false); // no Team tab
    const prof = (await run(profile.loader, get("/portal/profile?edit=seller", cookie))).data!;
    expect([prof.editable, prof.edit, prof.teamView]).toEqual([false, null, true]);

    const tries: [unknown, Request][] = [
      [profile.action, post("/portal/profile", cookie, { intent: "seller", name: "Hacked", phone: "+91 90000 00000" })],
      [profile.action, post("/portal/profile", cookie, { intent: "brand", description: "Hacked", minimumOrderValue: "1" })],
      [profile.action, post("/portal/profile", cookie, { intent: "business", ...ADDRESS })],
      [team.action, post("/portal/team", cookie, { intent: "add", email: "x@ashnur.example", access: "edit" })],
    ];
    for (const [fn, req] of tries) expect((await run(fn, req)).status).toBe(403);
    expect(await db.vendorUser.count({ where: { shop, name: "Hacked" } })).toBe(0);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).description).toBeNull();
    expect(await db.vendorChangeRequest.count({ where: { vendorId: vendor.id } })).toBe(0);
    expect(await db.vendorUser.count({ where: { shop, email: "x@ashnur.example" } })).toBe(0);
  });

  it("links expire after 60 seconds, belong to one store, and need an active vendor with an active person", async () => {
    const { vendor } = await owner("Ashnur", "o@ashnur.example");
    const t0 = new Date();
    const h = await createTeamHandoff(db, shop, vendor.id, "admin:team@setustore.test", { now: t0 });
    if (!h.ok) throw new Error();
    expect(await redeemTeamHandoff(db, h.token, { shop, now: new Date(t0.getTime() + 61_000) })).toBeNull();
    const h2 = await createTeamHandoff(db, shop, vendor.id, "admin:team@setustore.test");
    if (!h2.ok) throw new Error();
    expect(await redeemTeamHandoff(db, h2.token, { shop: "someone-else.myshopify.com" })).toBeNull();
    expect(await redeemTeamHandoff(db, "forged-token-forged-token-forged", { shop })).toBeNull();

    expect((await createTeamHandoff(db, "someone-else.myshopify.com", vendor.id, "admin:x")).ok).toBe(false);
    await setVendorStatus(db, shop, vendor.id, "paused", "test");
    expect((await createTeamHandoff(db, shop, vendor.id, "admin:x")).ok).toBe(false);
    const empty = await enableVendor(db, shop, "Nobody Yet", "test");
    expect((await createTeamHandoff(db, shop, empty.id, "admin:x")).ok).toBe(false);
  });

  it("doesn't touch the vendor's own sign-in or sessions", async () => {
    const { vendor, cookie } = await owner("Ashnur", "o@ashnur.example");
    const before = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "o@ashnur.example" } });
    const h = await createTeamHandoff(db, shop, vendor.id, "admin:team@setustore.test");
    if (!h.ok) throw new Error();
    await redeemTeamHandoff(db, h.token, { shop });
    const after = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "o@ashnur.example" } });
    expect(after.lastLoginAt?.getTime()).toBe(before.lastLoginAt?.getTime());
    expect((await run(layout.loader, get("/portal", cookie))).data!.teamView).toBeNull(); // the owner's own session is normal
  });
});
