import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_FAILS, LOCK_WINDOW_MS, RESET_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS,
  checkPassword, endSession, getIdentity, hashPassword, hashToken, passwordProblem,
  requestPasswordReset, resetPassword, resetTokenValid, signIn, signUp, type SignupInput,
} from "../app/lib/portal/auth.server";
import { addVendorUser, approveSignup, enableVendor, rejectSignup, removeVendorUser, setVendorStatus } from "../app/lib/vendors/vendors.server";

const db = new PrismaClient();
const shop = "seller-panel-auth-test.myshopify.com";
const ctx = { shop, ip: "10.0.0.1" };
const PW = "Candles-and-wax-2026";
afterAll(() => db.$disconnect());

const form = (o: Partial<SignupInput> = {}): SignupInput => ({
  name: "Nusrat Mirza", email: "nusrat@ashnur.example", password: PW, phone: "+91 98765 43210",
  ...o,
});

beforeEach(async () => {
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.passwordReset.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { ip: "10.0.0.1" } });
  await db.auditLog.deleteMany({ where: { shop } });
});

async function invitedActive(email = "owner@urban.example") {
  const v = await enableVendor(db, shop, "Urban Store", "test");
  expect(await addVendorUser(db, shop, v.id, email, "Owner", "test")).toEqual({ ok: true });
  const r = await signUp(db, form({ email }), ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { vendor: v, ...r };
}

describe("passwords", () => {
  it("are hashed with a random salt and checked correctly", async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).not.toBe(b);
    expect(a).not.toContain(PW);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await checkPassword(PW, a)).toBe(true);
    expect(await checkPassword(PW + "x", a)).toBe(false);
    expect(await checkPassword(PW, null)).toBe(false);
    expect(await checkPassword(PW, "garbage")).toBe(false);
  });

  it("must be strong enough", () => {
    expect(passwordProblem("short")).toMatch(/at least/);
    expect(passwordProblem("1234567890123")).toMatch(/letters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/easy/);
    expect(passwordProblem("nusratmirza2026!", "nusratmirza@x.com")).toMatch(/email/);
    expect(passwordProblem(PW)).toBeNull();
  });
});

describe("sign-up", () => {
  it("an invited email becomes active at once, keeping the team's vendor link", async () => {
    const r = await invitedActive();
    expect(r.ok && r.status).toBe("active");
    const me = await getIdentity(db, shop, r.ok ? r.token : null);
    expect(me?.user.status).toBe("active");
    expect(me?.vendor?.vendorName).toBe("Urban Store");
    const u = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "owner@urban.example" } });
    expect([u.name, u.phone]).toEqual(["Nusrat Mirza", "+91 98765 43210"]);
  });

  it("an unknown email becomes pending, with no vendor and no order access", async () => {
    const r = await signUp(db, form(), ctx);
    expect(r.ok && r.status).toBe("pending");
    const me = await getIdentity(db, shop, r.ok ? r.token : null);
    expect(me?.user.status).toBe("pending");
    expect(me?.vendor).toBeNull();
    const u = await db.vendorUser.findFirst({ where: { shop, email: "nusrat@ashnur.example" } });
    expect(u?.vendorId).toBeNull();
    expect(Object.keys((u?.application ?? {}) as object)).toEqual(["submittedAt"]); // seller details only
  });

  it("asks only for name, email, phone and password, and checks each", async () => {
    const r = await signUp(db, form({ name: "", email: "x", password: "short", phone: "12" }), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["email", "name", "password", "phone"]);
  });

  it("an email that already has an account can't sign up again", async () => {
    await signUp(db, form(), ctx);
    const again = await signUp(db, form({ name: "Someone else" }), ctx);
    expect(again.ok).toBe(false);
  });

  it("emails are matched without regard to case", async () => {
    await invitedActive("owner@urban.example");
    const r = await signIn(db, "OWNER@Urban.Example", PW, ctx);
    expect(r.ok).toBe(true);
  });
});

describe("sign-in", () => {
  it("works with the right password, fails with a wrong one or unknown email", async () => {
    await invitedActive();
    expect((await signIn(db, "owner@urban.example", PW, ctx)).ok).toBe(true);
    expect(await signIn(db, "owner@urban.example", "Wrong-password-1", ctx)).toEqual({ ok: false, reason: "wrong" });
    expect(await signIn(db, "nobody@urban.example", PW, ctx)).toEqual({ ok: false, reason: "wrong" });
  });

  it("an invited person who hasn't set a password can't sign in", async () => {
    const v = await enableVendor(db, shop, "Urban Store", "test");
    await addVendorUser(db, shop, v.id, "new@urban.example", null, "test");
    expect((await signIn(db, "new@urban.example", "", ctx)).ok).toBe(false);
    expect((await signIn(db, "new@urban.example", PW, ctx)).ok).toBe(false);
  });

  it(`locks the email after ${LOCK_FAILS} wrong passwords, even for the right one, for 15 minutes`, async () => {
    await invitedActive();
    const t0 = new Date();
    for (let i = 0; i < LOCK_FAILS; i++) await signIn(db, "owner@urban.example", `Wrong-pass-${i}x`, { ...ctx, now: t0 });
    expect(await signIn(db, "owner@urban.example", PW, { ...ctx, now: t0 })).toEqual({ ok: false, reason: "locked" });
    const later = new Date(t0.getTime() + LOCK_WINDOW_MS + 1000);
    expect((await signIn(db, "owner@urban.example", PW, { ...ctx, now: later })).ok).toBe(true);
  });

  it("a pending applicant can sign in but only to the 'under review' state", async () => {
    await signUp(db, form(), ctx);
    const r = await signIn(db, "nusrat@ashnur.example", PW, ctx);
    expect(r.ok && r.status).toBe("pending");
  });

  it("a declined applicant can't sign in", async () => {
    await signUp(db, form(), ctx);
    const u = await db.vendorUser.findFirst({ where: { shop, email: "nusrat@ashnur.example" } });
    await rejectSignup(db, shop, u!.id, "test");
    expect((await signIn(db, "nusrat@ashnur.example", PW, ctx)).ok).toBe(false);
  });
});

describe("team approval", () => {
  it("links the applicant to the chosen Shopify vendor and makes them active", async () => {
    const r = await signUp(db, form(), ctx);
    const u = await db.vendorUser.findFirst({ where: { shop, email: "nusrat@ashnur.example" } });
    expect(await approveSignup(db, shop, u!.id, "Ashnur", "test")).toEqual({ ok: true });
    const me = await getIdentity(db, shop, r.ok ? r.token : null); // same session, now active
    expect(me?.user.status).toBe("active");
    expect(me?.vendor?.vendorName).toBe("Ashnur");
    const v = await db.vendor.findFirst({ where: { shop, vendorName: "Ashnur" } });
    expect(v?.displayName).toBe("Ashnur"); // business and brand details are added later, on My brand
  });

  it("declining ends the applicant's session", async () => {
    const r = await signUp(db, form(), ctx);
    const u = await db.vendorUser.findFirst({ where: { shop, email: "nusrat@ashnur.example" } });
    await rejectSignup(db, shop, u!.id, "test");
    expect(await getIdentity(db, shop, r.ok ? r.token : null)).toBeNull();
  });

  it("requires a vendor name and only works on pending sign-ups", async () => {
    await signUp(db, form(), ctx);
    const u = await db.vendorUser.findFirst({ where: { shop, email: "nusrat@ashnur.example" } });
    expect((await approveSignup(db, shop, u!.id, "  ", "test")).ok).toBe(false);
    await approveSignup(db, shop, u!.id, "Ashnur", "test");
    expect((await approveSignup(db, shop, u!.id, "Urban Store", "test")).ok).toBe(false); // can't be moved to another vendor this way
  });
});

describe("password reset", () => {
  it("a reset link works once, sets the new password, and signs out everywhere", async () => {
    const s = await invitedActive();
    const req = await requestPasswordReset(db, "owner@urban.example", ctx);
    expect(req.status).toBe("sent");
    if (req.status !== "sent") return;
    expect(await resetTokenValid(db, shop, req.token)).toBe(true);
    const stored = await db.passwordReset.findFirst({ where: { vendorUser: { email: "owner@urban.example" } } });
    expect(stored!.tokenHash).toBe(hashToken(req.token));

    expect(await resetPassword(db, req.token, "Brand-new-password-9", ctx)).toEqual({ ok: true });
    expect(await getIdentity(db, shop, s.ok ? s.token : null)).toBeNull(); // old session ended
    expect((await signIn(db, "owner@urban.example", PW, ctx)).ok).toBe(false);
    expect((await signIn(db, "owner@urban.example", "Brand-new-password-9", ctx)).ok).toBe(true);
    expect((await resetPassword(db, req.token, "Another-password-77", ctx)).ok).toBe(false); // single use
  });

  it("expires after 30 minutes", async () => {
    await invitedActive();
    const t0 = new Date();
    const req = await requestPasswordReset(db, "owner@urban.example", { ...ctx, now: t0 });
    if (req.status !== "sent") throw new Error();
    const late = new Date(t0.getTime() + RESET_TTL_MS + 1000);
    expect((await resetPassword(db, req.token, "Brand-new-password-9", { ...ctx, now: late })).ok).toBe(false);
  });

  it("answers the same for an unknown email and sends nothing", async () => {
    expect(await requestPasswordReset(db, "nobody@example.com", ctx)).toEqual({ status: "silent" });
  });

  it("a newer link replaces the older one; weak new passwords are refused", async () => {
    await invitedActive();
    const a = await requestPasswordReset(db, "owner@urban.example", ctx);
    const b = await requestPasswordReset(db, "owner@urban.example", ctx);
    if (a.status !== "sent" || b.status !== "sent") throw new Error();
    expect((await resetPassword(db, a.token, "Brand-new-password-9", ctx)).ok).toBe(false);
    expect((await resetPassword(db, b.token, "short", ctx)).ok).toBe(false);
    expect((await resetPassword(db, b.token, "Brand-new-password-9", ctx)).ok).toBe(true);
  });

  it("forged or other-shop tokens are refused", async () => {
    expect(await resetTokenValid(db, shop, "x".repeat(43))).toBe(false);
    expect((await resetPassword(db, "x".repeat(43), "Brand-new-password-9", ctx)).ok).toBe(false);
  });
});

describe("sessions", () => {
  it("reject forged, empty and other-shop tokens", async () => {
    const r = await invitedActive();
    const token = r.ok ? r.token : "";
    expect(await getIdentity(db, shop, null)).toBeNull();
    expect(await getIdentity(db, shop, "x".repeat(43))).toBeNull();
    expect(await getIdentity(db, shop, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await getIdentity(db, "other-shop.myshopify.com", token)).toBeNull();
  });

  it("end after 12 hours idle and after 7 days in any case", async () => {
    await invitedActive();
    const t0 = new Date();
    const s = await signIn(db, "owner@urban.example", PW, { ...ctx, now: t0 });
    if (!s.ok) throw new Error();
    const active = new Date(t0.getTime() + SESSION_IDLE_MS - 60_000);
    expect(await getIdentity(db, shop, s.token, active)).not.toBeNull();
    expect(await getIdentity(db, shop, s.token, new Date(active.getTime() + SESSION_IDLE_MS + 60_000))).toBeNull();

    const s2 = await signIn(db, "owner@urban.example", PW, ctx);
    if (!s2.ok) throw new Error();
    const row = await db.portalSession.findFirst({ where: { tokenHash: hashToken(s2.token) } });
    const far = new Date(row!.createdAt.getTime() + SESSION_MAX_MS + 1000);
    await db.portalSession.update({ where: { id: row!.id }, data: { lastSeenAt: far } });
    expect(await getIdentity(db, shop, s2.token, far)).toBeNull();
  });

  it("end on sign-out, on pausing the vendor, and on removing the person", async () => {
    const r = await invitedActive();
    const a = await signIn(db, "owner@urban.example", PW, ctx);
    const b = await signIn(db, "owner@urban.example", PW, ctx);
    if (!a.ok || !b.ok) throw new Error();
    await endSession(db, a.token);
    expect(await getIdentity(db, shop, a.token)).toBeNull();

    await setVendorStatus(db, shop, r.vendor.id, "paused", "test");
    expect(await getIdentity(db, shop, b.token)).toBeNull();
    expect((await signIn(db, "owner@urban.example", PW, ctx)).ok).toBe(false);
    await setVendorStatus(db, shop, r.vendor.id, "active", "test");
    expect(await getIdentity(db, shop, b.token)).toBeNull(); // stays ended

    const c = await signIn(db, "owner@urban.example", PW, ctx);
    const u = await db.vendorUser.findFirst({ where: { shop, email: "owner@urban.example" } });
    await removeVendorUser(db, shop, u!.id, "test");
    expect(await getIdentity(db, shop, c.ok ? c.token : null)).toBeNull();
  });
});

describe("vendor records", () => {
  it("an email can belong to one vendor only, and a pending sign-up can't be invited over", async () => {
    await invitedActive();
    const other = await enableVendor(db, shop, "Ashnur", "test");
    expect((await addVendorUser(db, shop, other.id, "owner@urban.example", null, "test")).ok).toBe(false);
    await signUp(db, form({ email: "applicant@example.com" }), ctx);
    const r = await addVendorUser(db, shop, other.id, "applicant@example.com", null, "test");
    expect(r.ok === false && r.error).toMatch(/Sign-ups/);
  });
});
