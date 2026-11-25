import type { Prisma, PrismaClient } from "@prisma/client";
import { PHONE } from "../portal/auth.server";
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
  /** Set during a read-only Setu Store team view. */
  teamViewer?: string | null;
  user: { id: string; email: string; role: "owner" | "staff"; access: "view" | "edit" };
  vendor: { id: string };
};
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; errors?: Record<string, string> };

export const canEdit = (me: Pick<Me, "user" | "teamViewer">) => !me.teamViewer && (me.user.role === "owner" || me.user.access === "edit");
export const canManagePeople = (me: Pick<Me, "user" | "teamViewer">) => !me.teamViewer && me.user.role === "owner";

const DENIED = { ok: false as const, error: "Your access doesn't allow this. Ask your account owner." };

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

import {
  BRAND_FIELDS, BRAND_FILES, BRAND_TEXT, BUSINESS_FIELDS, BUSINESS_FILES, BUSINESS_TEXT, FIELD_LABEL, FILE_FIELD_KIND, SHORT_DESCRIPTION_MAX,
  fileInputName, missingDetails, type BrandField, type BusinessField, type FileField,
} from "./fields";
import { cleanDayRange, rangeOf } from "./shipping";
import { checkUpload, deleteFilesIfUnused, fileInfo, isFilePicked, storeFile, type FileCheck, type FileInfo } from "../files/files.server";
export { BRAND_FIELDS, BUSINESS_FIELDS, FIELD_LABEL, type BrandField, type BusinessField };

/** Reads a field from a submitted form or a plain object (tests, the team's form). */
type Input = FormData | Record<string, unknown>;
const get = (raw: Input, k: string) => (raw instanceof FormData ? raw.get(k) : (raw[k] as FormDataEntryValue | undefined));
const clip = (v: unknown, n: number) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? "" : String(v)).trim().slice(0, n);

const PIN = /^[1-9][0-9]{5}$/;
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;

/** Brand text. `requireAll` is off for the team's direct edits. */
export function cleanBrand(raw: Input, requireAll = true) {
  const v = {
    description: clip(get(raw, "description"), 3000),
    shortDescription: clip(get(raw, "shortDescription"), SHORT_DESCRIPTION_MAX + 40),
    minimumOrderValue: clip(get(raw, "minimumOrderValue"), 14).replace(/[,₹\s]/g, ""),
  };
  const errors: Record<string, string> = {};
  if (v.shortDescription.length > SHORT_DESCRIPTION_MAX) errors.shortDescription = `Keep it to ${SHORT_DESCRIPTION_MAX} characters.`;
  if (!v.minimumOrderValue && requireAll) errors.minimumOrderValue = "Enter your minimum order value in rupees.";
  else if (v.minimumOrderValue && !MONEY.test(v.minimumOrderValue)) errors.minimumOrderValue = "Enter an amount in rupees, e.g. 5000.";
  const p = cleanDayRange(clip(get(raw, "processingDaysMin"), 6), clip(get(raw, "processingDaysMax"), 6), "processing time");
  if (p.error) errors.processingDays = p.error;
  else if (!p.range && requireAll) errors.processingDays = "Enter how many days you need to make or ready an order, e.g. 10 and 15.";
  return { v, errors, processing: p.range };
}

/** Business text. */
export function cleanBusiness(raw: Input, requireAll = true) {
  const v = {
    companyName: clip(get(raw, "companyName"), 160),
    addressLine: clip(get(raw, "addressLine"), 300),
    city: clip(get(raw, "city"), 80),
    state: clip(get(raw, "state"), 80),
    postalCode: clip(get(raw, "postalCode"), 10).replace(/\s/g, ""),
  };
  const errors: Record<string, string> = {};
  if (requireAll) {
    if (!v.companyName) errors.companyName = "Enter your registered company name.";
    if (!v.addressLine) errors.addressLine = "Enter your street address.";
    if (!v.city) errors.city = "Enter your city.";
    if (!v.state) errors.state = "Enter your state.";
    if (!v.postalCode) errors.postalCode = "Enter your PIN code.";
  }
  if (v.postalCode && !PIN.test(v.postalCode)) errors.postalCode = "A PIN code has 6 digits, e.g. 141001.";
  return { v, errors };
}

const textOrNull = (s: string) => s || null;
const asText = (x: unknown) => (x === null || x === undefined || x === "" ? null : typeof x === "object" && "toFixed" in (x as object) ? (x as { toFixed: (n: number) => string }).toFixed(2) : String(x));

/** Checks every picked file before anything is stored, so a bad file stores nothing. */
async function checkFiles(raw: Input, fields: readonly FileField[]) {
  const checked: Partial<Record<FileField, Extract<FileCheck, { ok: true }>>> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = get(raw, fileInputName(f));
    if (!isFilePicked(v ?? null)) continue;
    const c = await checkUpload(FILE_FIELD_KIND[f], v as File);
    if (c.ok) checked[f] = c;
    else errors[fileInputName(f)] = c.error;
  }
  return { checked, errors };
}

// ---------------------------------------------------------------------------
// Vendor side
// ---------------------------------------------------------------------------

/** Each signed-in person keeps their own name and phone up to date. Email is fixed. */
export async function updateSellerDetails(db: PrismaClient, me: Me, raw: Input): Promise<Result> {
  if (me.teamViewer) return DENIED;
  const name = clip(get(raw, "name"), 120);
  const phone = clip(get(raw, "phone"), 20);
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Enter your name.";
  if (!PHONE.test(phone)) errors.phone = "Enter a phone number with at least 8 digits.";
  if (Object.keys(errors).length) return { ok: false, error: "Check the highlighted fields.", errors };
  await db.vendorUser.update({ where: { id: me.user.id }, data: { name, phone } });
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor_user.details_updated", target: `vendor:${me.vendor.id}` } });
  return { ok: true };
}

export async function updateBrand(db: PrismaClient, me: Me, raw: Input): Promise<Result> {
  if (!canEdit(me)) return DENIED;
  const { v, errors, processing } = cleanBrand(raw);
  const files = await checkFiles(raw, BRAND_FILES);
  Object.assign(errors, files.errors);
  if (Object.keys(errors).length) return { ok: false, error: "Check the highlighted fields.", errors };

  const current = await db.vendor.findUniqueOrThrow({ where: { id: me.vendor.id }, select: { logoFileId: true, bannerFileId: true } });
  const data: Record<string, string | number | null> = {
    description: textOrNull(v.description), shortDescription: textOrNull(v.shortDescription), minimumOrderValue: textOrNull(v.minimumOrderValue),
    processingDaysMin: processing?.min ?? null, processingDaysMax: processing?.max ?? null,
  };
  for (const f of BRAND_FILES) {
    const c = files.checked[f];
    if (c) data[f] = await storeFile(db, { shop: me.shop, vendorId: me.vendor.id, kind: FILE_FIELD_KIND[f], checked: c, uploadedById: me.user.id });
    else if (get(raw, `remove_${fileInputName(f)}`) === "1") data[f] = null;
  }
  await db.vendor.update({ where: { id: me.vendor.id }, data });
  await deleteFilesIfUnused(db, me.vendor.id, BRAND_FILES.filter((f) => f in data).map((f) => current[f]));
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor.brand_updated", target: `vendor:${me.vendor.id}`, detail: { files: BRAND_FILES.filter((f) => files.checked[f]) } } });
  return { ok: true };
}

export type Changes = Partial<Record<BusinessField, { from: string | null; to: string | null }>>;

/**
 * Records the differences as a pending request. Sending again replaces the
 * waiting request: its text comes from the form, and files uploaded with the
 * earlier request are kept unless a new file replaces them.
 */
export async function requestBusinessChange(db: PrismaClient, me: Me, raw: Input): Promise<Result> {
  if (!canEdit(me)) return DENIED;
  const { v, errors } = cleanBusiness(raw);
  const files = await checkFiles(raw, BUSINESS_FILES);
  Object.assign(errors, files.errors);
  if (Object.keys(errors).length) return { ok: false, error: "Check the highlighted fields.", errors };

  const current = await db.vendor.findUniqueOrThrow({ where: { id: me.vendor.id } });
  const pending = await db.vendorChangeRequest.findFirst({ where: { vendorId: me.vendor.id, status: "pending" } });
  const earlier = (pending?.changes ?? {}) as Changes;

  const changes: Changes = {};
  for (const f of BUSINESS_TEXT) {
    const from = asText(current[f]);
    const to = textOrNull(v[f]);
    if (from !== to) changes[f] = { from, to };
  }
  const keptFromEarlier: string[] = [];
  for (const f of BUSINESS_FILES) {
    if (!files.checked[f] && earlier[f]?.to) { changes[f] = { from: current[f], to: earlier[f]!.to }; keptFromEarlier.push(earlier[f]!.to!); }
  }
  if (!Object.keys(changes).length && !Object.keys(files.checked).length) return { ok: false, error: "Nothing has changed from your current details." };
  for (const f of BUSINESS_FILES) {
    const c = files.checked[f];
    if (c) changes[f] = { from: current[f], to: await storeFile(db, { shop: me.shop, vendorId: me.vendor.id, kind: FILE_FIELD_KIND[f], checked: c, uploadedById: me.user.id }) };
  }

  if (pending) {
    await db.vendorChangeRequest.update({ where: { id: pending.id }, data: { changes: changes as Prisma.InputJsonValue, requestedById: me.user.id } });
    await deleteFilesIfUnused(db, me.vendor.id, BUSINESS_FILES.map((f) => earlier[f]?.to));
  } else {
    await db.vendorChangeRequest.create({ data: { shop: me.shop, vendorId: me.vendor.id, requestedById: me.user.id, changes: changes as Prisma.InputJsonValue } });
  }
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor.business_change_requested", target: `vendor:${me.vendor.id}`, detail: { fields: Object.keys(changes) } } });
  return { ok: true };
}

export async function withdrawBusinessChange(db: PrismaClient, me: Me): Promise<Result> {
  if (!canEdit(me)) return DENIED;
  const pending = await db.vendorChangeRequest.findFirst({ where: { vendorId: me.vendor.id, status: "pending" } });
  if (!pending) return { ok: false, error: "There's no change waiting for approval." };
  await db.vendorChangeRequest.update({ where: { id: pending.id }, data: { status: "withdrawn" } });
  await deleteFilesIfUnused(db, me.vendor.id, BUSINESS_FILES.map((f) => ((pending.changes ?? {}) as Changes)[f]?.to));
  await db.auditLog.create({ data: { shop: me.shop, actor: `portal:${me.user.email}`, action: "vendor.business_change_withdrawn", target: `vendor:${me.vendor.id}` } });
  return { ok: true };
}

/** The pending request, and the most recent decided one (to tell the vendor what happened), with file names. */
export async function changeRequestState(db: PrismaClient, shop: string, vendorId: string) {
  const [pending, last] = await Promise.all([
    db.vendorChangeRequest.findFirst({ where: { shop, vendorId, status: "pending" }, include: { requestedBy: { select: { email: true, name: true } } } }),
    db.vendorChangeRequest.findFirst({ where: { shop, vendorId, status: { in: ["approved", "rejected"] } }, orderBy: { reviewedAt: "desc" } }),
  ]);
  const pc = (pending?.changes ?? {}) as Changes;
  const files = await fileInfo(db, vendorId, BUSINESS_FILES.flatMap((f) => [pc[f]?.from, pc[f]?.to]));
  const shape = (r: NonNullable<typeof last>) => ({
    id: r.id, status: r.status, changes: r.changes as Changes, note: r.note,
    createdAt: r.createdAt.toISOString(), reviewedAt: r.reviewedAt?.toISOString() ?? null,
  });
  return {
    pending: pending && { ...shape(pending), by: pending.requestedBy?.name || pending.requestedBy?.email || null },
    last: last && shape(last),
    files,
  };
}

/** Everything the My brand page and the team's vendor page show, with file names (never file contents). */
export async function vendorDetails(db: PrismaClient, shop: string, vendorId: string) {
  const v = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!v) return null;
  const files: Record<string, FileInfo> = await fileInfo(db, v.id, [v.gstFileId, v.iecFileId, v.adCodeFileId, v.logoFileId, v.bannerFileId]);
  const file = (id: string | null) => (id && files[id]) || null;
  const d = {
    vendorName: v.vendorName, displayName: v.displayName,
    companyName: v.companyName, addressLine: v.addressLine, city: v.city, state: v.state, postalCode: v.postalCode,
    gstFile: file(v.gstFileId), iecFile: file(v.iecFileId), adCodeFile: file(v.adCodeFileId),
    description: v.description, shortDescription: v.shortDescription,
    minimumOrderValue: v.minimumOrderValue ? v.minimumOrderValue.toFixed(2) : null,
    processingDaysMin: v.processingDaysMin, processingDaysMax: v.processingDaysMax,
    logoFile: file(v.logoFileId), bannerFile: file(v.bannerFileId),
  };
  return { ...d, missing: missingDetails(d) };
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
  const changes = (r.changes ?? {}) as Changes;
  if (decision === "reject") {
    await db.vendorChangeRequest.update({ where: { id: r.id }, data: { status: "rejected", ...reviewed } });
    await deleteFilesIfUnused(db, r.vendorId, BUSINESS_FILES.map((f) => changes[f]?.to));
  } else {
    const current = await db.vendor.findUniqueOrThrow({ where: { id: r.vendorId } });
    const data: Record<string, string | null> = {};
    for (const f of BUSINESS_FIELDS) if (changes[f]) data[f] = changes[f]!.to; // older requests' other keys are ignored
    await db.$transaction([
      db.vendor.update({ where: { id: r.vendorId }, data }),
      db.vendorChangeRequest.update({ where: { id: r.id }, data: { status: "approved", ...reviewed } }),
    ]);
    // Replaced documents are removed; the audit log keeps the record of the change.
    await deleteFilesIfUnused(db, r.vendorId, BUSINESS_FILES.filter((f) => changes[f]).map((f) => current[f]));
  }
  await db.auditLog.create({ data: { shop, actor, action: `vendor.business_change_${decision === "approve" ? "approved" : "rejected"}`, target: `vendor:${r.vendorId}` } });
  return { ok: true };
}

/** The team edits the brand name and the text details directly (no approval step). Files come from the vendor. */
export async function adminUpdateDetails(db: PrismaClient, shop: string, vendorId: string, raw: Input, actor: string): Promise<Result> {
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" };
  const displayName = clip(get(raw, "displayName"), 120);
  const b = cleanBrand(raw, false);
  const s = cleanBusiness(raw, false);
  const errors: Record<string, string> = { ...b.errors, ...s.errors };
  if (!displayName) errors.displayName = "Enter the brand name.";
  if (Object.keys(errors).length) return { ok: false, error: Object.values(errors).join(" "), errors };
  const data: Record<string, string | number | null> = { displayName, processingDaysMin: b.processing?.min ?? null, processingDaysMax: b.processing?.max ?? null };
  for (const f of BRAND_TEXT) data[f] = textOrNull(b.v[f]);
  for (const f of BUSINESS_TEXT) data[f] = textOrNull(s.v[f]);
  await db.vendor.update({ where: { id: vendor.id }, data });
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
      commissions: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }], take: 1, select: { ratePercent: true } },
    },
  });
  const ratings = await db.vendorReview.groupBy({ by: ["vendorId"], where: { shop, status: "published" }, _avg: { rating: true }, _count: { _all: true } });
  const ratingOf = new Map(ratings.map((r) => [r.vendorId, { average: (Math.round((r._avg.rating ?? 0) * 10) / 10).toFixed(1), count: r._count._all }]));
  return vendors.map((v) => {
    const count = (s: string) => v.users.filter((u) => u.status === s).length;
    const owners = v.users.filter((u) => u.role === "owner");
    return {
      id: v.id, vendorName: v.vendorName, displayName: v.displayName, status: v.status,
      owners: owners.map((o) => o.name || o.email),
      people: v.users.length, staff: v.users.length - owners.length,
      active: count("active"), deactivated: count("disabled"), needsApproval: count("pending"), invited: count("invited"),
      pendingChange: v.changeRequests.length > 0,
      commission: v.commissions[0]?.ratePercent.toFixed(2) ?? null,
      missing: missingDetails({ ...v, minimumOrderValue: v.minimumOrderValue?.toFixed(2) ?? null }),
      city: [v.city, v.state].filter(Boolean).join(", "),
      store: v.storeSyncError ? "error" : v.storeSyncedAt ? "ok" : "never",
      rating: ratingOf.get(v.id) ?? null,
      processing: rangeOf(v.processingDaysMin, v.processingDaysMax),
    };
  });
}
