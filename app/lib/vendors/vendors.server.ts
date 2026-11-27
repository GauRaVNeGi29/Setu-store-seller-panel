import type { PrismaClient } from "@prisma/client";
import { mailAccessChanged, mailPersonAdded, mailSignupApproved, mailSignupDeclined, mailVendorStatus } from "../mail/notify.server";

/**
 * Stage 2 – vendor records, managed by the team in Shopify admin.
 *
 * A Vendor is linked to one Shopify product Vendor value (vendorName). Every
 * portal query filters order lines by that exact vendorName, so the link is
 * what decides what a vendor can see. It is set once, by the team, and never
 * from anything a vendor sends.
 */

export const normaliseEmail = (raw: string) => raw.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (email: string) => email.length <= 254 && EMAIL.test(email);

export type VendorResult = { ok: true } | { ok: false; error: string };

export async function getVendorByName(db: PrismaClient, shop: string, vendorName: string) {
  return db.vendor.findUnique({
    where: { shop_vendorName: { shop, vendorName } },
    include: { users: { orderBy: { createdAt: "asc" } } },
  });
}

/** Creates the vendor record if missing (portal access starts active). */
export async function enableVendor(db: PrismaClient, shop: string, vendorName: string, actor: string) {
  const name = vendorName.trim();
  if (!name) throw new Error("A vendor needs a name");
  const vendor = await db.vendor.upsert({
    where: { shop_vendorName: { shop, vendorName: name } },
    create: { shop, vendorName: name, displayName: name },
    update: {},
  });
  await db.auditLog.create({ data: { shop, actor, action: "vendor.enabled", target: `vendor:${vendor.id}`, detail: { vendorName: name } } });
  return vendor;
}

/** Pausing a vendor ends every session of its users immediately. */
export async function setVendorStatus(db: PrismaClient, shop: string, vendorId: string, status: "active" | "paused", actor: string) {
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" } as VendorResult;
  await db.$transaction([
    db.vendor.update({ where: { id: vendor.id }, data: { status } }),
    ...(status === "paused"
      ? [db.portalSession.updateMany({ where: { vendorUser: { vendorId: vendor.id }, revokedAt: null }, data: { revokedAt: new Date() } })]
      : []),
    db.auditLog.create({ data: { shop, actor, action: `vendor.${status}`, target: `vendor:${vendor.id}` } }),
  ]);
  if (vendor.status !== status) await mailVendorStatus(db, shop, vendor.id, status);
  return { ok: true } as VendorResult;
}

export async function addVendorUser(
  db: PrismaClient, shop: string, vendorId: string, rawEmail: string, name: string | null, actor: string,
  opts: { role?: "owner" | "staff"; access?: "view" | "edit" } = {},
): Promise<VendorResult> {
  const email = normaliseEmail(rawEmail);
  if (!isValidEmail(email)) return { ok: false, error: `"${rawEmail}" is not a valid email address.` };
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" };
  const existing = await db.vendorUser.findUnique({ where: { shop_email: { shop, email } }, include: { vendor: true } });
  if (existing) {
    if (existing.status === "pending") return { ok: false, error: `${email} has a sign-up waiting for review. Approve it on the Sign-ups page.` };
    return existing.vendorId === vendor.id
      ? { ok: false, error: `${email} already has access.` }
      : { ok: false, error: `${email} already belongs to ${existing.vendor?.displayName ?? "another account"}. An email can belong to one vendor only.` };
  }
  // Invited: they create their password on the sign-up page and are active straight away.
  await db.vendorUser.create({ data: { shop, vendorId: vendor.id, email, name: name?.trim() || null, status: "invited", role: opts.role ?? "owner", access: opts.access ?? "edit" } });
  await db.auditLog.create({ data: { shop, actor, action: "vendor_user.added", target: `vendor:${vendor.id}`, detail: { email } } });
  await mailPersonAdded(db, shop, vendor.id, vendor.displayName || vendor.vendorName, { email, name: name?.trim() || null }, opts.role ?? "owner");
  return { ok: true };
}

/** Removes a person's access and ends their sessions. */
export async function removeVendorUser(db: PrismaClient, shop: string, userId: string, actor: string): Promise<VendorResult> {
  const user = await db.vendorUser.findFirst({ where: { id: userId, shop } });
  if (!user) return { ok: false, error: "User not found" };
  await db.$transaction([
    db.portalSession.deleteMany({ where: { vendorUserId: user.id } }),
    db.vendorUser.delete({ where: { id: user.id } }),
    db.auditLog.create({ data: { shop, actor, action: "vendor_user.removed", target: `vendor:${user.vendorId}`, detail: { email: user.email } } }),
  ]);
  if (user.vendorId && (user.status === "active" || user.status === "invited")) {
    const vendor = await db.vendor.findUnique({ where: { id: user.vendorId }, select: { displayName: true, vendorName: true } });
    const brand = vendor?.displayName || vendor?.vendorName || "your brand";
    await mailAccessChanged(db, shop, user.vendorId, brand, user, `Your access to ${brand} on the vendor portal was removed. You can no longer sign in.`);
  }
  return { ok: true };
}

/** Portal status per vendor name, for the overview table. */
export async function portalStatusByVendor(db: PrismaClient, shop: string) {
  const vendors = await db.vendor.findMany({ where: { shop }, include: { _count: { select: { users: true } } } });
  return new Map(vendors.map((v) => [v.vendorName, { status: v.status, users: v._count.users }]));
}

// ---------------------------------------------------------------------------
// Self sign-ups waiting for review
// ---------------------------------------------------------------------------

export type Application = {
  brandName?: string; gstNumber?: string | null; city?: string; state?: string; productNote?: string | null;
  description?: string | null; policy?: string | null; minimumOrderValue?: string | null; submittedAt?: string;
};

export async function listSignups(db: PrismaClient, shop: string, status: "pending" | "rejected" = "pending") {
  const rows = await db.vendorUser.findMany({ where: { shop, status }, orderBy: { createdAt: "asc" } });
  return rows.map((u) => ({
    id: u.id, email: u.email, name: u.name, phone: u.phone,
    createdAt: u.createdAt.toISOString(), reviewedAt: u.reviewedAt?.toISOString() ?? null,
    application: (u.application ?? {}) as Application,
  }));
}

/**
 * Approves a pending sign-up: links the person to the vendor with this exact
 * Shopify vendor name (creating the portal vendor record if needed) and makes
 * them active. Their brand details fill any empty fields on the vendor.
 */
export async function approveSignup(db: PrismaClient, shop: string, userId: string, vendorName: string, actor: string): Promise<VendorResult> {
  const name = vendorName.trim();
  if (!name) return { ok: false, error: "Choose the Shopify vendor this person sells as." };
  const user = await db.vendorUser.findFirst({ where: { id: userId, shop, status: "pending" } });
  if (!user) return { ok: false, error: "That sign-up is no longer waiting for review." };
  const app = (user.application ?? {}) as Application;
  const vendor = await db.vendor.upsert({
    where: { shop_vendorName: { shop, vendorName: name } },
    create: { shop, vendorName: name, displayName: name },
    update: {},
  });
  await db.vendorUser.update({ where: { id: user.id }, data: { vendorId: vendor.id, status: "active", reviewedAt: new Date(), reviewedBy: actor } });
  await fillVendorProfile(db, vendor.id, app as Record<string, string | null>, user.phone);
  await db.auditLog.create({ data: { shop, actor, action: "signup.approved", target: `vendor:${vendor.id}`, detail: { email: user.email, vendorName: name } } });
  await mailSignupApproved(db, shop, user, vendor.id, vendor.displayName || vendor.vendorName);
  return { ok: true };
}

/** Declines a pending sign-up and signs the person out. */
export async function rejectSignup(db: PrismaClient, shop: string, userId: string, actor: string): Promise<VendorResult> {
  const user = await db.vendorUser.findFirst({ where: { id: userId, shop, status: "pending" } });
  if (!user) return { ok: false, error: "That sign-up is no longer waiting for review." };
  await db.$transaction([
    db.vendorUser.update({ where: { id: user.id }, data: { status: "rejected", reviewedAt: new Date(), reviewedBy: actor } }),
    db.portalSession.updateMany({ where: { vendorUserId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    db.auditLog.create({ data: { shop, actor, action: "signup.rejected", detail: { email: user.email } } }),
  ]);
  await mailSignupDeclined(db, shop, user);
  return { ok: true };
}

/** Copies brand details from an older-style sign-up (before sign-up became seller details only) onto empty vendor fields. */
export async function fillVendorProfile(db: PrismaClient, vendorId: string, a: Record<string, string | null>, phone?: string | null) {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return;
  const keep = <T,>(cur: T | null, next: T | null | undefined) => (cur ?? next ?? null);
  await db.vendor.update({
    where: { id: vendorId },
    data: {
      phone: keep(vendor.phone, phone),
      gstNumber: keep(vendor.gstNumber, a.gstNumber),
      city: keep(vendor.city, a.city),
      state: keep(vendor.state, a.state),
      description: keep(vendor.description, a.description),
      policy: keep(vendor.policy, a.policy),
      productNote: keep(vendor.productNote, a.productNote),
      minimumOrderValue: vendor.minimumOrderValue ?? (a.minimumOrderValue ? a.minimumOrderValue : null),
    },
  });
}

