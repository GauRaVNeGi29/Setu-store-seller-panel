import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { PrismaClient, Prisma } from "@prisma/client";
import { fillVendorProfile, normaliseEmail, isValidEmail } from "../vendors/vendors.server";

/**
 * Vendor sign-in (email + password), sign-up, password reset and sessions.
 *
 * Passwords: scrypt (N=2^15, r=8, p=1) with a random 16-byte salt per password;
 *   only "scrypt$N$r$p$salt$hash" is stored. At least 10 characters.
 * Lockout: 5 wrong passwords for an email in 15 minutes locks that email for
 *   15 minutes; 30 failed tries from one IP per hour blocks that IP.
 * Sign-up: an email the team invited becomes active straight away; any other
 *   email becomes "pending" and sees no order data until the team approves it
 *   and links it to a Shopify vendor.
 * Reset: link with a random token (only its hash stored), single use, 30 minutes.
 *   Setting a new password ends every session of that person.
 * Sessions: random 256-bit token in an HttpOnly cookie; only its SHA-256 is
 *   stored. End after 12 h idle, 7 days, sign-out, password change, or when
 *   the team pauses the vendor or removes the person.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

import { MAX_PASSWORD, MIN_PASSWORD } from "./rules";
export { MAX_PASSWORD, MIN_PASSWORD };
export const LOCK_FAILS = 5;
export const LOCK_WINDOW_MS = 15 * 60 * 1000;
export const IP_FAILS_PER_HOUR = 30;
export const SIGNUPS_PER_IP_PER_HOUR = 5;
export const RESETS_PER_EMAIL_PER_HOUR = 3;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const COOKIE_NAME = "__Host-vp_session";

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return "That password is too long.";
  if (/^\d+$/.test(pw)) return "Use letters as well as numbers.";
  if (new Set(pw).size < 4) return "That password is too easy to guess.";
  if (email && pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    return "Don't use your email name in the password.";
  }
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function checkPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  // Always do the work, so a missing account takes as long as a wrong password.
  const parts = (stored ?? "").split("$");
  const ok = parts.length === 6 && parts[0] === "scrypt";
  const salt = ok ? Buffer.from(parts[4], "base64") : randomBytes(16);
  const opts = ok ? { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: SCRYPT.maxmem } : SCRYPT;
  const expected = ok ? Buffer.from(parts[5], "base64") : randomBytes(KEYLEN);
  const actual = await scrypt(pw.normalize("NFKC").slice(0, MAX_PASSWORD), salt, expected.length, opts);
  return ok && timingSafeEqual(actual, expected);
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type Ctx = { shop: string; ip?: string | null; userAgent?: string | null; now?: Date };

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

export type SignupInput = {
  name: string;
  email: string;
  password: string;
  phone: string;
  brandName: string;
  gstNumber?: string;
  city: string;
  state: string;
  productNote?: string;
  description?: string;
  policy?: string;
  minimumOrderValue?: string;
};

export type SignupResult =
  | { ok: true; status: "active" | "pending"; token: string; expiresAt: Date }
  | { ok: false; errors: Record<string, string> };

const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);
export const GST = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PHONE = /^\+?[0-9 ()-]{8,20}$/;

export function validateSignup(raw: SignupInput) {
  const v = {
    name: clip(raw.name, 120),
    email: normaliseEmail(clip(raw.email, 254)),
    phone: clip(raw.phone, 20),
    brandName: clip(raw.brandName, 120),
    gstNumber: clip(raw.gstNumber, 15).toUpperCase(),
    city: clip(raw.city, 80),
    state: clip(raw.state, 80),
    productNote: clip(raw.productNote, 1000),
    description: clip(raw.description, 3000),
    policy: clip(raw.policy, 3000),
    minimumOrderValue: clip(raw.minimumOrderValue, 12).replace(/[,₹\s]/g, ""),
  };
  const errors: Record<string, string> = {};
  if (!v.name) errors.name = "Enter your name.";
  if (!isValidEmail(v.email)) errors.email = "Enter a valid email address.";
  const pw = passwordProblem(raw.password ?? "", v.email);
  if (pw) errors.password = pw;
  if (!PHONE.test(v.phone)) errors.phone = "Enter a phone number with at least 8 digits.";
  if (!v.brandName) errors.brandName = "Enter your business or brand name.";
  if (v.gstNumber && !GST.test(v.gstNumber)) errors.gstNumber = "That doesn't look like a 15-character GSTIN.";
  if (!v.city) errors.city = "Enter your city.";
  if (!v.state) errors.state = "Enter your state.";
  if (v.minimumOrderValue && !(/^\d{1,9}(\.\d{1,2})?$/.test(v.minimumOrderValue))) errors.minimumOrderValue = "Enter an amount in rupees, e.g. 5000.";
  return { v, errors };
}

/**
 * Creates the account. Invited email → active at once (the team already linked
 * it to a vendor). Unknown email → pending application, no vendor, no order data.
 * Returns a session either way, so a pending applicant lands on "under review".
 */
export async function signUp(db: PrismaClient, raw: SignupInput, ctx: Ctx): Promise<SignupResult> {
  const { v, errors } = validateSignup(raw);
  if (Object.keys(errors).length) return { ok: false, errors };
  const now = ctx.now ?? new Date();

  if (ctx.ip) {
    const recent = await db.auditLog.count({ where: { action: "signup.created", at: { gte: new Date(now.getTime() - HOUR) }, detail: { path: ["ip"], equals: ctx.ip } } });
    if (recent >= SIGNUPS_PER_IP_PER_HOUR) return { ok: false, errors: { form: "Too many sign-ups from this network. Please try again later." } };
  }

  const existing = await db.vendorUser.findUnique({ where: { shop_email: { shop: ctx.shop, email: v.email } }, include: { vendor: true } });
  if (existing && existing.status !== "invited") {
    return { ok: false, errors: { email: "An account with this email already exists. Sign in, or use “Forgot password”." } };
  }

  const application: Prisma.InputJsonValue = {
    brandName: v.brandName, gstNumber: v.gstNumber || null, city: v.city, state: v.state,
    productNote: v.productNote || null, description: v.description || null, policy: v.policy || null,
    minimumOrderValue: v.minimumOrderValue || null, submittedAt: now.toISOString(),
  };
  const passwordHash = await hashPassword(raw.password);

  let user;
  if (existing) {
    // Invited by the team: becomes active immediately, keeps the team's vendor link.
    user = await db.vendorUser.update({
      where: { id: existing.id },
      data: { name: v.name, phone: v.phone, passwordHash, application, status: existing.vendorId ? "active" : "pending" },
    });
    if (existing.vendor) await fillVendorProfile(db, existing.vendor.id, application as Record<string, string | null>, v.phone);
  } else {
    user = await db.vendorUser.create({
      data: { shop: ctx.shop, email: v.email, name: v.name, phone: v.phone, passwordHash, application, status: "pending" },
    });
  }
  await db.auditLog.create({ data: { shop: ctx.shop, actor: `portal:${v.email}`, action: "signup.created", target: `user:${user.id}`, detail: { status: user.status, invited: Boolean(existing), ip: ctx.ip ?? null } } });

  const s = await createSession(db, user.id, ctx);
  return { ok: true, status: user.status === "active" ? "active" : "pending", ...s };
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export type SignInResult =
  | { ok: true; status: "active" | "pending"; token: string; expiresAt: Date }
  | { ok: false; reason: "wrong" | "locked" };

export async function signIn(db: PrismaClient, rawEmail: string, password: string, ctx: Ctx): Promise<SignInResult> {
  const email = normaliseEmail(rawEmail).slice(0, 254);
  const now = ctx.now ?? new Date();
  const lockSince = new Date(now.getTime() - LOCK_WINDOW_MS);

  const [emailFails, ipFails] = await Promise.all([
    db.loginAttempt.count({ where: { shop: ctx.shop, email, success: false, createdAt: { gte: lockSince } } }),
    ctx.ip ? db.loginAttempt.count({ where: { ip: ctx.ip, success: false, createdAt: { gte: new Date(now.getTime() - HOUR) } } }) : Promise.resolve(0),
  ]);
  if (emailFails >= LOCK_FAILS || ipFails >= IP_FAILS_PER_HOUR) {
    await db.auditLog.create({ data: { shop: ctx.shop, actor: `portal:${email}`, action: "login.locked", detail: { ip: ctx.ip ?? null } } });
    return { ok: false, reason: "locked" };
  }

  const user = isValidEmail(email) ? await db.vendorUser.findUnique({ where: { shop_email: { shop: ctx.shop, email } }, include: { vendor: true } }) : null;
  const passwordOk = await checkPassword(password ?? "", user?.passwordHash);
  const allowed = Boolean(
    user && passwordOk &&
    (user.status === "pending" || (user.status === "active" && user.vendor?.status === "active")),
  );

  await db.loginAttempt.create({ data: { shop: ctx.shop, email, ip: ctx.ip ?? null, success: allowed, createdAt: now } });
  if (!allowed || !user) {
    await db.auditLog.create({ data: { shop: ctx.shop, actor: `portal:${email}`, action: "login.failed", detail: { ip: ctx.ip ?? null } } });
    return { ok: false, reason: "wrong" };
  }

  await db.vendorUser.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  await db.auditLog.create({ data: { shop: ctx.shop, actor: `portal:${email}`, action: "login.success", detail: { vendor: user.vendor?.vendorName ?? null, status: user.status, ip: ctx.ip ?? null } } });
  return { ok: true, status: user.status === "active" ? "active" : "pending", ...(await createSession(db, user.id, ctx)) };
}

async function createSession(db: PrismaClient, vendorUserId: string, ctx: Ctx) {
  const now = ctx.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
  await db.portalSession.create({
    data: { tokenHash: hashToken(token), vendorUserId, expiresAt, createdAt: now, lastSeenAt: now, ip: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null },
  });
  return { token, expiresAt };
}

// ---------------------------------------------------------------------------
// Forgot / reset password
// ---------------------------------------------------------------------------

export type ResetRequest = { status: "sent"; email: string; token: string; name: string | null } | { status: "silent" };

/** Same outward result whether or not the email has an account. */
export async function requestPasswordReset(db: PrismaClient, rawEmail: string, ctx: Ctx): Promise<ResetRequest> {
  const email = normaliseEmail(rawEmail).slice(0, 254);
  const now = ctx.now ?? new Date();
  if (!isValidEmail(email)) return { status: "silent" };
  const user = await db.vendorUser.findUnique({ where: { shop_email: { shop: ctx.shop, email } } });
  if (!user || !["active", "pending", "invited"].includes(user.status)) return { status: "silent" };
  const recent = await db.passwordReset.count({ where: { vendorUserId: user.id, createdAt: { gte: new Date(now.getTime() - HOUR) } } });
  if (recent >= RESETS_PER_EMAIL_PER_HOUR) return { status: "silent" };

  const token = randomBytes(32).toString("base64url");
  await db.$transaction([
    db.passwordReset.updateMany({ where: { vendorUserId: user.id, usedAt: null }, data: { usedAt: now } }),
    db.passwordReset.create({ data: { tokenHash: hashToken(token), vendorUserId: user.id, ip: ctx.ip ?? null, expiresAt: new Date(now.getTime() + RESET_TTL_MS), createdAt: now } }),
  ]);
  await db.auditLog.create({ data: { shop: ctx.shop, actor: `portal:${email}`, action: "password.reset_requested", detail: { ip: ctx.ip ?? null } } });
  return { status: "sent", email, token, name: user.name };
}

export async function resetTokenValid(db: PrismaClient, shop: string, token: string, now = new Date()) {
  if (!token || token.length > 100) return false;
  const r = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { vendorUser: true } });
  return Boolean(r && !r.usedAt && r.expiresAt > now && r.vendorUser.shop === shop);
}

/** What a reset/invite link is for: "invite" when the person hasn't set a password yet. */
export async function resetLinkInfo(db: PrismaClient, shop: string, token: string, now = new Date()) {
  if (!token || token.length > 100) return { valid: false as const };
  const r = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { vendorUser: true } });
  if (!r || r.usedAt || r.expiresAt <= now || r.vendorUser.shop !== shop) return { valid: false as const };
  return { valid: true as const, invite: r.vendorUser.status === "invited", email: r.vendorUser.email };
}

/**
 * A set-password link for someone added by their vendor's owner. Works once
 * and lasts 7 days; after that they can use "Forgot password" with the same email.
 */
export async function createInviteLink(db: PrismaClient, vendorUserId: string, ctx: Ctx): Promise<string> {
  const now = ctx.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  await db.$transaction([
    db.passwordReset.updateMany({ where: { vendorUserId, usedAt: null }, data: { usedAt: now } }),
    db.passwordReset.create({ data: { tokenHash: hashToken(token), vendorUserId, ip: ctx.ip ?? null, expiresAt: new Date(now.getTime() + INVITE_TTL_MS), createdAt: now } }),
  ]);
  return token;
}

export type ResetResult = { ok: true } | { ok: false; error: string };

export async function resetPassword(db: PrismaClient, token: string, password: string, ctx: Ctx): Promise<ResetResult> {
  const now = ctx.now ?? new Date();
  const r = token && token.length <= 100 ? await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { vendorUser: true } }) : null;
  if (!r || r.usedAt || r.expiresAt <= now || r.vendorUser.shop !== ctx.shop) return { ok: false, error: "This link has expired or was already used. Ask for a new one." };
  const problem = passwordProblem(password ?? "", r.vendorUser.email);
  if (problem) return { ok: false, error: problem };

  const claimed = await db.passwordReset.updateMany({ where: { id: r.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) return { ok: false, error: "This link has expired or was already used. Ask for a new one." };
  await db.$transaction([
    db.vendorUser.update({
      where: { id: r.vendorUserId },
      data: {
        passwordHash: await hashPassword(password),
        // Staff invited by their owner become active once they set a password.
        ...(r.vendorUser.status === "invited" && r.vendorUser.vendorId ? { status: "active" as const } : {}),
      },
    }),
    db.portalSession.updateMany({ where: { vendorUserId: r.vendorUserId, revokedAt: null }, data: { revokedAt: now } }),
    db.loginAttempt.deleteMany({ where: { shop: ctx.shop, email: r.vendorUser.email, success: false } }),
  ]);
  await db.auditLog.create({ data: { shop: ctx.shop, actor: `portal:${r.vendorUser.email}`, action: "password.reset", detail: { ip: ctx.ip ?? null } } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type PortalIdentity = {
  sessionId: string;
  user: { id: string; email: string; name: string | null; status: "active" | "pending"; role: "owner" | "staff"; access: "view" | "edit" };
  vendor: { id: string; vendorName: string; displayName: string } | null; // null while pending
};

/** Resolves a session token to the signed-in person, or null. The only source of "who is this". */
export async function getIdentity(db: PrismaClient, shop: string, token: string | null, now = new Date()): Promise<PortalIdentity | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const s = await db.portalSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { vendorUser: { include: { vendor: true } } } });
  if (!s || s.revokedAt || s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > SESSION_IDLE_MS) return null;
  const u = s.vendorUser;
  if (u.shop !== shop) return null;

  let vendor: PortalIdentity["vendor"] = null;
  if (u.status === "active") {
    if (!u.vendor || u.vendor.status !== "active" || u.vendor.shop !== shop) return null;
    vendor = { id: u.vendor.id, vendorName: u.vendor.vendorName, displayName: u.vendor.displayName };
  } else if (u.status !== "pending") {
    return null; // invited (no password yet), rejected, disabled
  }

  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.portalSession.update({ where: { id: s.id }, data: { lastSeenAt: now } });
  }
  return { sessionId: s.id, user: { id: u.id, email: u.email, name: u.name, status: u.status, role: u.role, access: u.access }, vendor };
}

export async function endSession(db: PrismaClient, token: string | null) {
  if (!token) return;
  await db.portalSession.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const sessionCookie = (token: string, expiresAt: Date) =>
  `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
export const clearSessionCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Best-effort client IP behind the Shopify CLI tunnel / Render proxy. */
export function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0].trim() || request.headers.get("x-real-ip") || null)?.slice(0, 64) ?? null;
}
