import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CODE_TTL_MS, CODES_PER_EMAIL_PER_HOUR, MAX_ATTEMPTS, SESSION_IDLE_MS, SESSION_MAX_MS,
  endSession, getIdentity, hashToken, requestCode, verifyCode,
} from "../app/lib/portal/auth.server";
import { addVendorUser, enableVendor, removeVendorUser, setVendorStatus } from "../app/lib/vendors/vendors.server";

const db = new PrismaClient();
const shop = "seller-panel-auth-test.myshopify.com";
const ctx = { shop, ip: "10.0.0.1" };
afterAll(() => db.$disconnect());

async function reset() {
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginCode.deleteMany({ where: { shop } });
  await db.loginCode.deleteMany({ where: { ip: { in: ["10.0.0.1", "10.0.0.9"] } } });
  await db.auditLog.deleteMany({ where: { shop } });
}

let vendorId: string;
beforeEach(async () => {
  await reset();
  vendorId = (await enableVendor(db, shop, "Urban Store", "test")).id;
  expect(await addVendorUser(db, shop, vendorId, "Owner@Urban.example ", "Owner", "test")).toEqual({ ok: true });
});

async function signIn(email = "owner@urban.example", now?: Date) {
  const r = await requestCode(db, email, { ...ctx, now });
  if (r.status !== "sent") throw new Error(`expected sent, got ${r.status}`);
  const v = await verifyCode(db, email, r.code, { ...ctx, now });
  if (!v.ok) throw new Error("verify failed");
  return v.token;
}

describe("one-time codes", () => {
  it("emails are matched case-insensitively and a correct code signs in once", async () => {
    const r = await requestCode(db, "OWNER@urban.example", ctx);
    expect(r.status).toBe("sent");
    if (r.status !== "sent") return;
    expect(r.code).toMatch(/^\d{6}$/);
    const v = await verifyCode(db, "owner@urban.example", r.code, ctx);
    expect(v.ok).toBe(true);
    expect((await verifyCode(db, "owner@urban.example", r.code, ctx)).ok).toBe(false); // single use
  });

  it("stores only a hash of the code and of the session token", async () => {
    const r = await requestCode(db, "owner@urban.example", ctx);
    if (r.status !== "sent") throw new Error();
    const row = await db.loginCode.findFirst({ where: { shop, email: "owner@urban.example", usedAt: null } });
    expect(row!.codeHash).not.toContain(r.code);
    const v = await verifyCode(db, "owner@urban.example", r.code, ctx);
    if (!v.ok) throw new Error();
    const s = await db.portalSession.findFirst({ where: { vendorUser: { email: "owner@urban.example" } } });
    expect(s!.tokenHash).toBe(hashToken(v.token));
    expect(s!.tokenHash).not.toBe(v.token);
  });

  it("an unknown email gets the same answer but no usable code", async () => {
    const r = await requestCode(db, "stranger@example.com", ctx);
    expect(r).toEqual({ status: "silent", email: "stranger@example.com" });
    for (const guess of ["000000", "123456", "999999"]) {
      expect((await verifyCode(db, "stranger@example.com", guess, ctx)).ok).toBe(false);
    }
  });

  it(`locks the code after ${MAX_ATTEMPTS} wrong tries, even if the right code follows`, async () => {
    const r = await requestCode(db, "owner@urban.example", ctx);
    if (r.status !== "sent") throw new Error();
    const wrong = r.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await verifyCode(db, "owner@urban.example", wrong, ctx)).ok).toBe(false);
    expect((await verifyCode(db, "owner@urban.example", r.code, ctx)).ok).toBe(false);
  });

  it("an expired code fails", async () => {
    const t0 = new Date();
    const r = await requestCode(db, "owner@urban.example", { ...ctx, now: t0 });
    if (r.status !== "sent") throw new Error();
    const later = new Date(t0.getTime() + CODE_TTL_MS + 1000);
    expect((await verifyCode(db, "owner@urban.example", r.code, { ...ctx, now: later })).ok).toBe(false);
  });

  it("asking again replaces the earlier code", async () => {
    const a = await requestCode(db, "owner@urban.example", ctx);
    const b = await requestCode(db, "owner@urban.example", ctx);
    if (a.status !== "sent" || b.status !== "sent") throw new Error();
    if (a.code !== b.code) expect((await verifyCode(db, "owner@urban.example", a.code, ctx)).ok).toBe(false);
    expect((await verifyCode(db, "owner@urban.example", b.code, ctx)).ok).toBe(true);
  });

  it(`rate-limits to ${CODES_PER_EMAIL_PER_HOUR} codes per email per hour`, async () => {
    for (let i = 0; i < CODES_PER_EMAIL_PER_HOUR; i++) expect((await requestCode(db, "owner@urban.example", ctx)).status).toBe("sent");
    expect((await requestCode(db, "owner@urban.example", ctx)).status).toBe("silent");
  });

  it("rejects malformed input without touching the database", async () => {
    expect((await requestCode(db, "not-an-email", ctx)).status).toBe("invalid");
    expect((await verifyCode(db, "owner@urban.example", "12ab56", ctx)).ok).toBe(false);
    expect((await verifyCode(db, "owner@urban.example", "' OR 1=1 --", ctx)).ok).toBe(false);
  });
});

describe("sessions", () => {
  it("resolve to the vendor from the database, not from the request", async () => {
    const token = await signIn();
    const me = await getIdentity(db, shop, token);
    expect(me?.vendor.vendorName).toBe("Urban Store");
    expect(me?.user.email).toBe("owner@urban.example");
  });

  it("reject forged, empty and other-shop tokens", async () => {
    const token = await signIn();
    expect(await getIdentity(db, shop, null)).toBeNull();
    expect(await getIdentity(db, shop, "x".repeat(43))).toBeNull();
    expect(await getIdentity(db, shop, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await getIdentity(db, "other-shop.myshopify.com", token)).toBeNull();
  });

  it("end after 12 hours idle and after 7 days in any case", async () => {
    const t0 = new Date();
    const token = await signIn(undefined, t0);
    // Activity just inside the idle window keeps the session alive (and resets the idle clock)…
    const active = new Date(t0.getTime() + SESSION_IDLE_MS - 60_000);
    expect(await getIdentity(db, shop, token, active)).not.toBeNull();
    // …12 hours of silence after that last activity ends it.
    const t1 = new Date(active.getTime() + SESSION_IDLE_MS + 60_000);
    expect(await getIdentity(db, shop, token, t1)).toBeNull();

    const token2 = await signIn();
    const s = await db.portalSession.findFirst({ where: { tokenHash: hashToken(token2) } });
    const far = new Date(s!.createdAt.getTime() + SESSION_MAX_MS + 1000);
    await db.portalSession.update({ where: { id: s!.id }, data: { lastSeenAt: far } }); // even if "active"
    expect(await getIdentity(db, shop, token2, far)).toBeNull();
  });

  it("end on sign-out", async () => {
    const token = await signIn();
    await endSession(db, token);
    expect(await getIdentity(db, shop, token)).toBeNull();
  });

  it("end when the team pauses the vendor, and no new code is sent while paused", async () => {
    const token = await signIn();
    await setVendorStatus(db, shop, vendorId, "paused", "test");
    expect(await getIdentity(db, shop, token)).toBeNull();
    expect((await requestCode(db, "owner@urban.example", ctx)).status).toBe("silent");
    await setVendorStatus(db, shop, vendorId, "active", "test");
    expect(await getIdentity(db, shop, token)).toBeNull(); // old session stays ended
  });

  it("end when the team removes the person", async () => {
    const token = await signIn();
    const user = await db.vendorUser.findFirst({ where: { shop, email: "owner@urban.example" } });
    await removeVendorUser(db, shop, user!.id, "test");
    expect(await getIdentity(db, shop, token)).toBeNull();
  });
});

describe("vendor records", () => {
  it("an email can belong to one vendor only", async () => {
    const other = await enableVendor(db, shop, "Ashnur", "test");
    const r = await addVendorUser(db, shop, other.id, "owner@urban.example", null, "test");
    expect(r.ok).toBe(false);
  });

  it("rejects invalid emails", async () => {
    expect((await addVendorUser(db, shop, vendorId, "nope", null, "test")).ok).toBe(false);
  });
});
