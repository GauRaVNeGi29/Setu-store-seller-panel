import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { normaliseEmail, isValidEmail } from "../vendors/vendors.server";

/**
 * Stage 3 – vendor sign-in with a one-time email code, and server-side sessions.
 *
 * - Invite-only: a code is sent only to an email the team added, for an active
 *   vendor. The page looks the same either way, so it never reveals whether an
 *   email has access.
 * - Codes: 6 digits, valid 10 minutes, single use, 5 wrong tries max, only a
 *   keyed hash stored. Asking again replaces the previous code.
 * - Rate limits: 5 codes per email per hour, 20 per IP per hour.
 * - Sessions: random 256-bit token in an HttpOnly cookie; only its SHA-256 is
 *   stored. Ends after 12 h idle or 7 days, on logout, or when the team pauses
 *   the vendor or removes the person.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const CODES_PER_EMAIL_PER_HOUR = 5;
export const CODES_PER_IP_PER_HOUR = 20;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const COOKIE_NAME = "__Host-vp_session";

function secret(env: Record<string, string | undefined> = process.env): string {
  const s = env.PORTAL_SECRET;
  if (!s || s.length < 32) throw new Error("PORTAL_SECRET must be set to a random string of at least 32 characters");
  return s;
}

export const hashCode = (shop: string, email: string, code: string) =>
  createHmac("sha256", secret()).update(`${shop}\n${email}\n${code}`).digest("hex");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function sameHash(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

type Ctx = { shop: string; ip?: string | null; userAgent?: string | null; now?: Date };

export type RequestCodeResult =
  | { status: "sent"; email: string; code: string; vendorName: string } // caller emails the code
  | { status: "silent"; email: string } // unknown / paused / rate-limited: show the same page, send nothing
  | { status: "invalid" }; // not an email address

export async function requestCode(db: PrismaClient, rawEmail: string, ctx: Ctx): Promise<RequestCodeResult> {
  const email = normaliseEmail(rawEmail);
  if (!isValidEmail(email)) return { status: "invalid" };
  const now = ctx.now ?? new Date();
  const since = new Date(now.getTime() - HOUR);

  const [byEmail, byIp] = await Promise.all([
    db.loginCode.count({ where: { shop: ctx.shop, email, createdAt: { gte: since } } }),
    ctx.ip ? db.loginCode.count({ where: { ip: ctx.ip, createdAt: { gte: since } } }) : Promise.resolve(0),
  ]);
  if (byEmail >= CODES_PER_EMAIL_PER_HOUR || byIp >= CODES_PER_IP_PER_HOUR) {
    await audit(db, ctx.shop, "login.rate_limited", email, { ip: ctx.ip });
    return { status: "silent", email };
  }

  const user = await db.vendorUser.findUnique({ where: { shop_email: { shop: ctx.shop, email } }, include: { vendor: true } });
  const allowed = Boolean(user?.active && user.vendor.status === "active");

  // Replace any earlier unused code, then record this request (for unknown emails too, so limits apply equally).
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.$transaction([
    db.loginCode.updateMany({ where: { shop: ctx.shop, email, usedAt: null }, data: { usedAt: now } }),
    db.loginCode.create({
      data: {
        shop: ctx.shop, email, ip: ctx.ip ?? null,
        codeHash: allowed ? hashCode(ctx.shop, email, code) : "0".repeat(64),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        usedAt: allowed ? null : now, // unknown emails get a code that can never be used
      },
    }),
  ]);
  await audit(db, ctx.shop, allowed ? "login.code_sent" : "login.code_refused", email, { ip: ctx.ip });
  return allowed ? { status: "sent", email, code, vendorName: user!.vendor.displayName } : { status: "silent", email };
}

export type VerifyResult = { ok: true; token: string; expiresAt: Date } | { ok: false };

export async function verifyCode(db: PrismaClient, rawEmail: string, rawCode: string, ctx: Ctx): Promise<VerifyResult> {
  const email = normaliseEmail(rawEmail);
  const code = rawCode.replace(/\s+/g, "");
  const now = ctx.now ?? new Date();
  if (!/^\d{6}$/.test(code) || !isValidEmail(email)) return { ok: false };

  const row = await db.loginCode.findFirst({
    where: { shop: ctx.shop, email, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.attempts >= MAX_ATTEMPTS) {
    await audit(db, ctx.shop, "login.failed", email, { reason: row ? "too_many_attempts" : "no_valid_code", ip: ctx.ip });
    return { ok: false };
  }
  if (!sameHash(row.codeHash, hashCode(ctx.shop, email, code))) {
    const attempts = row.attempts + 1;
    await db.loginCode.update({ where: { id: row.id }, data: { attempts, ...(attempts >= MAX_ATTEMPTS ? { usedAt: now } : {}) } });
    await audit(db, ctx.shop, "login.failed", email, { reason: "wrong_code", attempts, ip: ctx.ip });
    return { ok: false };
  }

  // Single use, even if the session can't be created below.
  const claimed = await db.loginCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) return { ok: false };

  const user = await db.vendorUser.findUnique({ where: { shop_email: { shop: ctx.shop, email } }, include: { vendor: true } });
  if (!user?.active || user.vendor.status !== "active") {
    await audit(db, ctx.shop, "login.failed", email, { reason: "no_access", ip: ctx.ip });
    return { ok: false };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
  await db.$transaction([
    db.portalSession.create({
      data: { tokenHash: hashToken(token), vendorUserId: user.id, expiresAt, createdAt: now, lastSeenAt: now, ip: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null },
    }),
    db.vendorUser.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
  ]);
  await audit(db, ctx.shop, "login.success", email, { vendor: user.vendor.vendorName, ip: ctx.ip });
  return { ok: true, token, expiresAt };
}

export type PortalIdentity = {
  sessionId: string;
  user: { id: string; email: string; name: string | null };
  vendor: { id: string; vendorName: string; displayName: string };
};

/** Resolves a session token to the signed-in vendor user, or null. The only source of "who is this vendor". */
export async function getIdentity(db: PrismaClient, shop: string, token: string | null, now = new Date()): Promise<PortalIdentity | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const s = await db.portalSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { vendorUser: { include: { vendor: true } } } });
  if (!s || s.revokedAt || s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > SESSION_IDLE_MS) return null;
  const u = s.vendorUser;
  if (u.shop !== shop || !u.active || u.vendor.status !== "active" || u.vendor.shop !== shop) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.portalSession.update({ where: { id: s.id }, data: { lastSeenAt: now } });
  }
  return {
    sessionId: s.id,
    user: { id: u.id, email: u.email, name: u.name },
    vendor: { id: u.vendor.id, vendorName: u.vendor.vendorName, displayName: u.vendor.displayName },
  };
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

async function audit(db: PrismaClient, shop: string, action: string, email: string, detail: Record<string, unknown>) {
  await db.auditLog.create({ data: { shop, actor: `portal:${email}`, action, detail: detail as object } });
}
