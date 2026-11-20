import type { PrismaClient } from "@prisma/client";

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
  return { ok: true } as VendorResult;
}

export async function addVendorUser(db: PrismaClient, shop: string, vendorId: string, rawEmail: string, name: string | null, actor: string): Promise<VendorResult> {
  const email = normaliseEmail(rawEmail);
  if (!isValidEmail(email)) return { ok: false, error: `"${rawEmail}" is not a valid email address.` };
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" };
  const existing = await db.vendorUser.findUnique({ where: { shop_email: { shop, email } }, include: { vendor: true } });
  if (existing) {
    return existing.vendorId === vendor.id
      ? { ok: false, error: `${email} already has access.` }
      : { ok: false, error: `${email} already belongs to ${existing.vendor.displayName}. An email can belong to one vendor only.` };
  }
  await db.vendorUser.create({ data: { shop, vendorId: vendor.id, email, name: name?.trim() || null } });
  await db.auditLog.create({ data: { shop, actor, action: "vendor_user.added", target: `vendor:${vendor.id}`, detail: { email } } });
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
  return { ok: true };
}

/** Portal status per vendor name, for the overview table. */
export async function portalStatusByVendor(db: PrismaClient, shop: string) {
  const vendors = await db.vendor.findMany({ where: { shop }, include: { _count: { select: { users: true } } } });
  return new Map(vendors.map((v) => [v.vendorName, { status: v.status, users: v._count.users }]));
}
