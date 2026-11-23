import type { Prisma, PrismaClient } from "@prisma/client";
import { GST, PHONE } from "../portal/auth.server";
import { isValidEmail, normaliseEmail } from "./vendors.server";

/**
 * Who may change what, for one vendor.
 *
 * Brand details      – owners and "view and edit" staff; saved at once.
 * Business details   – owners and "view and edit" staff; held as a request
 *                      until the Setu Store team approves. Nothing changes
 *                      on the vendor before that.
 * Sign-in details    – nobody in the portal: the email is fixed, the password
 *                      changes only through "Forgot password".
 * People             – owners add staff and set their access and status;
 *                      staff never manage anyone. The team (Shopify admin)
 *                      can change anyone's status, role and access.
 *
 * Every check here runs on the server from the signed-in session; nothing the
 * browser sends decides the vendor, role or access.
 */

export type Me = {
  shop: string;
  user: { id: string; email: string; role: "owner" | "staff"; access: "view" | "edit" };
  vendor: { id: string };
};
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; errors?: Record<string, string> };

export const canEdit = (me: Pick<Me, "user">) => me.user.role === "owner" || me.user.access === "edit";
export const canManagePeople = (me: Pick<Me, "user">) => me.user.role === "owner";

const DENIED = { ok: false as const, error: "Your access doesn't allow this. Ask your account owner." };

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

import { BRAND_FIELDS, BUSINESS_FIELDS, FIELD_LABEL, type BrandField, type BusinessField } from "./fields";
export { BRAND_FIELDS, BUSINESS_FIELDS, FIELD_LABEL, type BrandField, type BusinessField };

const clip = (v: FormDataEntryValue | string | null | undefined, n: number) => String(v ?? "").trim().slice(0, n);

export function cleanBrand(raw: Record<string, unknown>) {
  const v = {
    description: clip(raw.description as string, 3000),
    policy: clip(raw.policy as string, 3000),
    productNote: clip(raw.productNote as string, 1000),
    minimumOrderValue: clip(raw.minimumOrderValue as string, 12).replace(/[,₹\s]/g, ""),
  };
  const errors: Record<string, string> = {};
  if (v.minimumOrderValue && !/^\d{1,9}(\.\d{1,2})?$/.test(v.minimumOrderValue)) errors.minimumOrderValue = "Enter an amount in rupees, e.g. 5000.";
  return { v, errors };
}

export function cleanBusiness(raw: Record<string, unknown>) {
  const v = {
    displayName: clip(raw.displayName as string, 120),
    gstNumber: clip(raw.gstNumber as string, 15).toUpperCase(),
    phone: clip(raw.phone as string, 20),
    city: clip(raw.city as string, 80),
    state: clip(raw.state as string, 80),
  };
  const errors: Record<string, string> = {};
  if (!v.displayName) errors.displayName = "Enter your business name.";
  if (v.gstNumber && !GST.test(v.gstNumber)) errors.gstNumber = "That doesn't look like a 15-character GSTIN.";
  if (v.phone && !PHONE.test(v.phone)) errors.phone = "Enter a phone number with at least 8 digits.";
  if (!v.city) errors.city = "Enter your city.";
  if (!v.state) errors.state = "Enter your state.";
  return { v, errors };
}

const brandData = (v: ReturnType<typeof cleanBrand>["v"]) => ({
  description: v.description || null, policy: v.policy || null, productNote: v.productNote || null,
  minimumOrderValue: v.minimumOrderValue || null,
});
const businessData = (v: ReturnType<typeof cleanBusiness>["v"]) => ({
  displayName: v.displayName, gstNumber: v.gstNumber || null, phone: v.phone || null, city: v.city || null, state: v.state || null,
});

const asText = (x: unknown) => (x === null || x === undefined || x === "" ? null : typeof x === "object" && "toFixed" in (x as object) ? (x as { toFixed: (n: number) => string }).toFixed(2) : String(x));

// ---------------------------------------------------------------------------
// Vendor side
// ---------------------------------------------------------------------------

export async function updateBrand(db: PrismaClient, me: Me, raw: Record<string, unknown>): Promise<Result> {
  if (!canEdit(me)) return DENIED;
  const { v, errors } = cleanBrand(raw);
  if (Object.keys(errors).length) return { ok: false, error: "Check the highlighted fields.", errors };
  await db.vendor.update({ where: { id: me.vendor.id }, data: brandData(v) });
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor.brand_updated", target: `vendor:${me.vendor.id}` } });
  return { ok: true };
}

export type Changes = Partial<Record<BusinessField, { from: string | null; to: string | null }>>;

/** Records the differences as a pending request (replacing any earlier pending one). */
export async function requestBusinessChange(db: PrismaClient, me: Me, raw: Record<string, unknown>): Promise<Result> {
  if (!canEdit(me)) return DENIED;
  const { v, errors } = cleanBusiness(raw);
  if (Object.keys(errors).length) return { ok: false, error: "Check the highlighted fields.", errors };
  const current = await db.vendor.findUniqueOrThrow({ where: { id: me.vendor.id } });
  const next = businessData(v);
  const changes: Changes = {};
  for (const f of BUSINESS_FIELDS) {
    const from = asText(current[f]);
    const to = asText(next[f]);
    if (from !== to) changes[f] = { from, to };
  }
  if (!Object.keys(changes).length) return { ok: false, error: "Nothing has changed from your current details." };

  const pending = await db.vendorChangeRequest.findFirst({ where: { vendorId: me.vendor.id, status: "pending" } });
  if (pending) {
    await db.vendorChangeRequest.update({ where: { id: pending.id }, data: { changes: changes as Prisma.InputJsonValue, requestedById: me.user.id } });
  } else {
    await db.vendorChangeRequest.create({ data: { shop: me.shop, vendorId: me.vendor.id, requestedById: me.user.id, changes: changes as Prisma.InputJsonValue } });
  }
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor.business_change_requested", target: `vendor:${me.vendor.id}`, detail: { fields: Object.keys(changes) } } });
  return { ok: true };
}

export async function withdrawBusinessChange(db: PrismaClient, me: Me): Promise<Result> {
  if (!canEdit(me)) return DENIED;
  const r = await db.vendorChangeRequest.updateMany({ where: { vendorId: me.vendor.id, status: "pending" }, data: { status: "withdrawn" } });
  if (!r.count) return { ok: false, error: "There's no change waiting for approval." };
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor.business_change_withdrawn", target: `vendor:${me.vendor.id}` } });
  return { ok: true };
}

/** The pending request, and the most recent decided one (to tell the vendor what happened). */
export async function changeRequestState(db: PrismaClient, shop: string, vendorId: string) {
  const [pending, last] = await Promise.all([
    db.vendorChangeRequest.findFirst({ where: { shop, vendorId, status: "pending" }, include: { requestedBy: { select: { email: true, name: true } } } }),
    db.vendorChangeRequest.findFirst({ where: { shop, vendorId, status: { in: ["approved", "rejected"] } }, orderBy: { reviewedAt: "desc" } }),
  ]);
  const shape = (r: NonNullable<typeof last>) => ({
    id: r.id, status: r.status, changes: r.changes as Changes, note: r.note,
    createdAt: r.createdAt.toISOString(), reviewedAt: r.reviewedAt?.toISOString() ?? null,
  });
  return {
    pending: pending && { ...shape(pending), by: pending.requestedBy?.name || pending.requestedBy?.email || null },
    last: last && shape(last),
  };
}

// ---------------------------------------------------------------------------
// People, from the owner's side
// ---------------------------------------------------------------------------

export async function listPeople(db: PrismaClient, shop: string, vendorId: string) {
  const users = await db.vendorUser.findMany({ where: { shop, vendorId }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] });
  return users.map((u) => ({
    id: u.id, email: u.email, name: u.name, status: u.status, role: u.role, access: u.access,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString(),
  }));
}

/** Owner adds a staff member. Returns the new user's id; the caller sends the set-password link. */
export async function addStaff(db: PrismaClient, me: Me, raw: { email: string; name: string; access: string }): Promise<Result<{ userId: string; email: string; name: string | null }>> {
  if (!canManagePeople(me)) return DENIED;
  const email = normaliseEmail(clip(raw.email, 254));
  const name = clip(raw.name, 120) || null;
  const access = raw.access === "edit" ? "edit" : "view";
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address.", errors: { email: "Enter a valid email address." } };
  const existing = await db.vendorUser.findUnique({ where: { shop_email: { shop: me.shop, email } } });
  if (existing) {
    const msg = existing.vendorId === me.vendor.id ? `${email} is already on your team.` : `${email} already has a Setu Store vendor account. Each email can belong to one vendor only.`;
    return { ok: false, error: msg, errors: { email: msg } };
  }
  const u = await db.vendorUser.create({
    data: { shop: me.shop, vendorId: me.vendor.id, email, name, role: "staff", access, status: "invited", invitedById: me.user.id },
  });
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor_user.staff_added", target: `vendor:${me.vendor.id}`, detail: { email, access } } });
  return { ok: true, userId: u.id, email, name };
}

async function ownStaff(db: PrismaClient, me: Me, userId: string) {
  const u = await db.vendorUser.findFirst({ where: { id: userId, shop: me.shop, vendorId: me.vendor.id } });
  return u && u.role === "staff" ? u : null;
}

/** Owner changes a staff member's access, or deactivates / reactivates them. */
export async function ownerUpdateStaff(db: PrismaClient, me: Me, userId: string, change: { access?: string; status?: string }): Promise<Result> {
  if (!canManagePeople(me)) return DENIED;
  const u = await ownStaff(db, me, userId);
  if (!u) return { ok: false, error: "That person isn't on your staff." };
  const data: Prisma.VendorUserUpdateInput = {};
  if (change.access === "view" || change.access === "edit") data.access = change.access;
  if (change.status === "disabled") data.status = "disabled";
  if (change.status === "active") {
    // Owners can only undo their own deactivation; "Requires approval" and declined people are the team's call.
    if (u.status !== "disabled") return { ok: false, error: "Only the Setu Store team can activate this person." };
    data.status = u.passwordHash ? "active" : "invited";
  }
  if (!Object.keys(data).length) return { ok: false, error: "Nothing to change." };
  await db.$transaction([
    db.vendorUser.update({ where: { id: u.id }, data }),
    ...(data.status === "disabled" ? [db.portalSession.updateMany({ where: { vendorUserId: u.id, revokedAt: null }, data: { revokedAt: new Date() } })] : []),
    db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor_user.staff_updated", target: `vendor:${me.vendor.id}`, detail: { email: u.email, ...change } } }),
  ]);
  return { ok: true };
}

/** Owner removes a staff member entirely (their sessions end). */
export async function ownerRemoveStaff(db: PrismaClient, me: Me, userId: string): Promise<Result> {
  if (!canManagePeople(me)) return DENIED;
  const u = await ownStaff(db, me, userId);
  if (!u) return { ok: false, error: "That person isn't on your staff." };
  await db.$transaction([
    db.portalSession.deleteMany({ where: { vendorUserId: u.id } }),
    db.vendorUser.delete({ where: { id: u.id } }),
    db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor_user.staff_removed", target: `vendor:${me.vendor.id}`, detail: { email: u.email } } }),
  ]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Team (Shopify admin) side
// ---------------------------------------------------------------------------

export const ADMIN_STATUSES = ["active", "disabled", "pending"] as const;

/** The team sets anyone's status, role and access. Leaving "active" ends their sessions. */
export async function adminUpdateUser(
  db: PrismaClient, shop: string, userId: string,
  change: { status?: string; role?: string; access?: string }, actor: string,
): Promise<Result> {
  const u = await db.vendorUser.findFirst({ where: { id: userId, shop } });
  if (!u) return { ok: false, error: "Person not found" };
  const data: Prisma.VendorUserUpdateInput = {};
  if (change.status && change.status !== u.status) {
    if (!(ADMIN_STATUSES as readonly string[]).includes(change.status)) return { ok: false, error: "Unknown status" };
    if (change.status === "active" && !u.vendorId) return { ok: false, error: "Link this person to a vendor first (Sign-ups page)." };
    // Someone who never set a password stays "Invited" until they do.
    data.status = change.status === "active" && !u.passwordHash ? "invited" : (change.status as "active" | "disabled" | "pending");
  }
  if (change.role === "owner" || change.role === "staff") data.role = change.role;
  if (change.access === "view" || change.access === "edit") data.access = change.access;
  if (!Object.keys(data).length) return { ok: true };
  const endsAccess = data.status !== undefined && data.status !== "active";
  await db.$transaction([
    db.vendorUser.update({ where: { id: u.id }, data }),
    ...(endsAccess ? [db.portalSession.updateMany({ where: { vendorUserId: u.id, revokedAt: null }, data: { revokedAt: new Date() } })] : []),
    db.auditLog.create({ data: { shop, actor, action: "vendor_user.updated", target: `vendor:${u.vendorId}`, detail: { email: u.email, ...change } } }),
  ]);
  return { ok: true };
}

/** Approve applies the requested values to the vendor; decline keeps the current ones. */
export async function reviewBusinessChange(
  db: PrismaClient, shop: string, requestId: string, decision: "approve" | "reject", note: string | null, actor: string,
): Promise<Result> {
  const r = await db.vendorChangeRequest.findFirst({ where: { id: requestId, shop, status: "pending" } });
  if (!r) return { ok: false, error: "That change is no longer waiting for approval." };
  const now = new Date();
  const reviewed = { reviewedAt: now, reviewedBy: actor, note: clip(note, 500) || null };
  if (decision === "reject") {
    await db.vendorChangeRequest.update({ where: { id: r.id }, data: { status: "rejected", ...reviewed } });
  } else {
    const changes = r.changes as Changes;
    const data: Record<string, string | null> = {};
    for (const f of BUSINESS_FIELDS) if (changes[f]) data[f] = changes[f]!.to;
    if (data.displayName === null) delete data.displayName; // a business name is required
    await db.$transaction([
      db.vendor.update({ where: { id: r.vendorId }, data }),
      db.vendorChangeRequest.update({ where: { id: r.id }, data: { status: "approved", ...reviewed } }),
    ]);
  }
  await db.auditLog.create({ data: { shop, actor, action: `vendor.business_change_${decision === "approve" ? "approved" : "rejected"}`, target: `vendor:${r.vendorId}` } });
  return { ok: true };
}

/** The team edits brand and business details directly (no approval step). */
export async function adminUpdateDetails(db: PrismaClient, shop: string, vendorId: string, raw: Record<string, unknown>, actor: string): Promise<Result> {
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" };
  const b = cleanBrand(raw);
  const s = cleanBusiness(raw);
  const errors = { ...b.errors, ...s.errors };
  if (Object.keys(errors).length) return { ok: false, error: Object.values(errors).join(" "), errors };
  await db.vendor.update({ where: { id: vendor.id }, data: { ...brandData(b.v), ...businessData(s.v) } });
  await db.auditLog.create({ data: { shop, actor, action: "vendor.details_updated_by_team", target: `vendor:${vendor.id}` } });
  return { ok: true };
}

/** Every vendor with a portal record, for the team's "All vendors" page. */
export async function listAllVendors(db: PrismaClient, shop: string) {
  const vendors = await db.vendor.findMany({
    where: { shop },
    orderBy: { displayName: "asc" },
    include: {
      users: { select: { status: true, role: true, email: true, name: true } },
      changeRequests: { where: { status: "pending" }, select: { id: true } },
    },
  });
  return vendors.map((v) => {
    const count = (s: string) => v.users.filter((u) => u.status === s).length;
    const owners = v.users.filter((u) => u.role === "owner");
    return {
      id: v.id, vendorName: v.vendorName, displayName: v.displayName, status: v.status,
      owners: owners.map((o) => o.name || o.email),
      people: v.users.length, staff: v.users.length - owners.length,
      active: count("active"), deactivated: count("disabled"), needsApproval: count("pending"), invited: count("invited"),
      pendingChange: v.changeRequests.length > 0,
      city: [v.city, v.state].filter(Boolean).join(", "),
    };
  });
}
