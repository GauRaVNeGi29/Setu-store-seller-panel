import type { PrismaClient } from "@prisma/client";
import { FIELD_LABEL } from "../vendors/fields";
import { queueMail, type Recipient } from "./queue.server";
import { TEMPLATES, type TemplateKey } from "./templates";

/**
 * Which mails go out when something happens. Each function is called right
 * where the event is recorded. None of them ever throws: a mail that can't be
 * queued must not undo or fail the thing that was just done.
 */

const DAY = 24 * 60 * 60 * 1000;
/** The day in India, as YYYY-MM-DD: for "at most once a day" mails. */
export const dayKey = (now = new Date()) => new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function safely(what: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    console.error(`[mail] couldn't queue "${what}":`, e);
  }
}

type Person = { email: string; name: string | null };
const to = (p: Person): Recipient => ({ email: p.email, name: p.name });

/** The team addresses that receive team mails (set on the Mail page). */
export async function teamAddresses(db: PrismaClient, shop: string): Promise<Recipient[]> {
  const s = await db.shopSetting.findUnique({ where: { shop }, select: { adminEmails: true } });
  return (s?.adminEmails ?? []).map((email) => ({ email }));
}

/** A vendor's name and the people on its team who can sign in: owners only, or everyone. */
async function vendorPeople(db: PrismaClient, shop: string, vendorId: string, who: "owners" | "everyone") {
  const vendor = await db.vendor.findFirst({
    where: { id: vendorId, shop },
    select: { id: true, displayName: true, vendorName: true, status: true, users: { where: { status: "active", ...(who === "owners" ? { role: "owner" as const } : {}) }, select: { email: true, name: true } } },
  });
  return vendor && { id: vendor.id, vendorName: vendor.vendorName, brand: vendor.displayName || vendor.vendorName, status: vendor.status, people: vendor.users.map(to) };
}

const labels = (fields: string[]) => fields.map((f) => (FIELD_LABEL as Record<string, string>)[f] ?? f);

// ------------------------------------------------------------------ account

export const mailSignupReceived = (db: PrismaClient, shop: string, user: Person) => safely("sign-up received", async () => {
  await queueMail(db, shop, "signup_received", [to(user)], {});
  await queueMail(db, shop, "admin_signup_waiting", await teamAddresses(db, shop), { name: user.name, email: user.email });
});

export const mailSignupApproved = (db: PrismaClient, shop: string, user: Person, vendorId: string, brand: string) =>
  safely("sign-up approved", () => queueMail(db, shop, "signup_approved", [to(user)], { brand }, { vendorId }));

export const mailSignupDeclined = (db: PrismaClient, shop: string, user: Person) =>
  safely("sign-up declined", () => queueMail(db, shop, "signup_declined", [to(user)], {}));

export const mailPersonAdded = (db: PrismaClient, shop: string, vendorId: string, brand: string, user: Person, role: "owner" | "staff") =>
  safely("person added", () => queueMail(db, shop, "person_added", [to(user)], { brand, role }, { vendorId }));

export const mailPasswordChanged = (db: PrismaClient, shop: string, user: Person) =>
  safely("password changed", () => queueMail(db, shop, "password_changed", [to(user)], {}));

/** Only for an address that has an account, and at most once an hour, however many wrong tries follow. */
export const mailLoginLocked = (db: PrismaClient, shop: string, email: string, minutes: number, now = new Date()) => safely("sign-in paused", async () => {
  const user = await db.vendorUser.findUnique({ where: { shop_email: { shop, email } }, select: { email: true, name: true, status: true } });
  if (!user || user.status === "rejected") return;
  await queueMail(db, shop, "login_locked", [to(user)], { minutes }, { dedupe: `login_locked:${now.toISOString().slice(0, 13)}` });
});

/** `change` is a full sentence for the person, e.g. "You were removed from Ashnur's team." */
export const mailAccessChanged = (db: PrismaClient, shop: string, vendorId: string | null, brand: string, user: Person, change: string) =>
  safely("access changed", () => queueMail(db, shop, "access_changed", [to(user)], { brand, change }, { vendorId }));

/** The sentence for a change of status, role or access, or null when nothing the person would notice changed. */
export function accessSentence(brand: string, before: { status: string; role: string; access: string }, after: { status?: string; role?: string; access?: string }): string | null {
  const status = after.status ?? before.status;
  const role = after.role ?? before.role;
  const access = after.access ?? before.access;
  if (status !== before.status) {
    if (status === "disabled") return `Your access to ${brand} on the vendor portal was deactivated. You can no longer sign in.`;
    if (before.status === "disabled") return `Your access to ${brand} on the vendor portal is active again.`;
    return null;
  }
  if (role !== before.role) return role === "owner" ? `You are now an owner of ${brand} on the vendor portal, with full access.` : `You are now a staff member of ${brand} on the vendor portal.`;
  if (access !== before.access && role === "staff") return access === "edit" ? `You can now view and change things for ${brand} on the vendor portal.` : `You can now view ${brand} on the vendor portal, but not change anything.`;
  return null;
}

export const mailVendorStatus = (db: PrismaClient, shop: string, vendorId: string, status: "active" | "paused") => safely("vendor status", async () => {
  // Paused vendors' people can't sign in, but the owners still need to be told.
  const v = await vendorPeople(db, shop, vendorId, "owners");
  if (v) await queueMail(db, shop, status === "paused" ? "vendor_paused" : "vendor_active", v.people, { brand: v.brand }, { vendorId });
});

// ------------------------------------------------------------------ profile

export const mailChangeSubmitted = (db: PrismaClient, shop: string, vendorId: string, brand: string, byEmail: string, fields: string[]) => safely("business change sent", async () => {
  const by = await db.vendorUser.findUnique({ where: { shop_email: { shop, email: byEmail } }, select: { email: true, name: true } });
  if (by) await queueMail(db, shop, "change_submitted", [to(by)], { brand, fields: labels(fields) }, { vendorId });
  await queueMail(db, shop, "admin_change_waiting", await teamAddresses(db, shop), { brand, fields: labels(fields) }, { vendorId });
});

export const mailChangeDecided = (db: PrismaClient, shop: string, vendorId: string, approved: boolean, reason: string | null) => safely("business change decided", async () => {
  const v = await vendorPeople(db, shop, vendorId, "owners");
  if (!v) return;
  if (approved) await queueMail(db, shop, "change_approved", v.people, { brand: v.brand }, { vendorId });
  else await queueMail(db, shop, "change_declined", v.people, { brand: v.brand, reason }, { vendorId });
});

export const mailDetailsChangedByTeam = (db: PrismaClient, shop: string, vendorId: string) => safely("details changed by team", async () => {
  const v = await vendorPeople(db, shop, vendorId, "owners");
  if (v) await queueMail(db, shop, "details_changed_by_team", v.people, { brand: v.brand }, { vendorId });
});

export const mailCommissionSet = (db: PrismaClient, shop: string, vendorId: string, rate: string) => safely("commission set", async () => {
  const v = await vendorPeople(db, shop, vendorId, "owners");
  if (v) await queueMail(db, shop, "commission_set", v.people, { brand: v.brand, rate: String(Number(rate)) }, { vendorId });
});

// ------------------------------------------------------------------ orders

export type OrderLineState = {
  vendorName: string; lineItemId: bigint; title: string; variantTitle: string | null; quantity: number; currentQuantity: number;
  refundedAmount: { toString(): string } | string | number; orderCancelled: boolean; orderCreatedAt: Date;
};

/**
 * Compares an order's lines before and after it was re-read from Shopify and
 * mails each vendor concerned: once when the order is new to them, and once
 * for each real change (cancelled, refunded, items changed). Shipping updates
 * mail nobody: the vendor made those. Only vendors that are active on the
 * portal are mailed, and an order older than a week that the app is only now
 * seeing is never announced as new.
 */
export const mailOrderChanges = (
  db: PrismaClient, shop: string, order: { id: bigint; name: string }, before: OrderLineState[], after: OrderLineState[], now = new Date(),
) => safely("order changes", async () => {
  const names = [...new Set([...before, ...after].map((l) => l.vendorName).filter(Boolean))];
  if (!names.length) return;
  const vendors = await db.vendor.findMany({ where: { shop, vendorName: { in: names }, status: "active" }, select: { id: true } });
  for (const { id } of vendors) {
    const v = await vendorPeople(db, shop, id, "everyone");
    if (!v || !v.people.length) continue;
    const was = before.filter((l) => l.vendorName === v.vendorName);
    const is = after.filter((l) => l.vendorName === v.vendorName);
    const base = { brand: v.brand, orderName: order.name, orderId: order.id.toString() };
    const sum = (ls: OrderLineState[], pick: (l: OrderLineState) => number) => ls.reduce((n, l) => n + pick(l), 0);
    const cancelled = (ls: OrderLineState[]) => ls.length > 0 && ls.every((l) => l.orderCancelled);

    if (!was.length) {
      // New to this vendor: a new order, or their item was just added to one the app already had.
      const addedLater = before.length > 0;
      if (!is.length || cancelled(is) || (!addedLater && now.getTime() - is[0].orderCreatedAt.getTime() > 7 * DAY)) continue;
      const items = is.filter((l) => l.currentQuantity > 0).map((l) => ({ title: l.variantTitle ? `${l.title} – ${l.variantTitle}` : l.title, quantity: l.currentQuantity }));
      if (items.length) await queueMail(db, shop, "order_new", v.people, { ...base, items }, { vendorId: id, dedupe: `order_new:${order.id}:${id}` });
      continue;
    }
    const refunded = (ls: OrderLineState[]) => sum(ls, (l) => Number(l.refundedAmount));
    const units = (ls: OrderLineState[]) => sum(ls, (l) => l.currentQuantity);
    let change: string | null = null;
    if (!is.length) change = "Your items were removed from this order. Please don't ship them.";
    else if (cancelled(is) && !cancelled(was)) change = "The order was cancelled. Please don't ship it.";
    else if (refunded(is) > refunded(was)) {
      const fewer = units(was) - units(is);
      change = fewer > 0 ? `A refund was made on this order: ${fewer} ${fewer === 1 ? "unit" : "units"} no longer ${fewer === 1 ? "needs" : "need"} to ship.` : "A refund was made on this order. The quantities to ship are unchanged.";
    } else if (units(is) !== units(was) || is.length !== was.length || sum(is, (l) => l.quantity) !== sum(was, (l) => l.quantity)) {
      change = "The items or quantities on this order were changed. Please check what to ship before you pack it.";
    }
    if (!change) continue;
    const state = `${cancelled(is) ? 1 : 0}-${refunded(is).toFixed(2)}-${units(is)}-${is.length}`;
    await queueMail(db, shop, "order_changed", v.people, { ...base, change }, { vendorId: id, dedupe: `order_changed:${order.id}:${id}:${state}` });
  }
});

// ------------------------------------------------------------------ reviews

/**
 * A new review mails the vendor's owners. A buyer changing their review mails
 * the vendor nobody (they see it in the portal); the team hears of a low
 * review either way, when the rating first drops to 2 stars or fewer.
 */
export const mailReview = (
  db: PrismaClient, shop: string, vendorId: string, review: { rating: number; comment: string | null; author: string }, earlierRating: number | null = null,
) => safely("new review", async () => {
  const v = await vendorPeople(db, shop, vendorId, "owners");
  if (!v) return;
  if (earlierRating === null) await queueMail(db, shop, "review_new", v.people, { brand: v.brand, ...review }, { vendorId });
  if (review.rating <= 2 && (earlierRating === null || earlierRating > 2)) await queueMail(db, shop, "admin_low_review", await teamAddresses(db, shop), { brand: v.brand, rating: review.rating, comment: review.comment }, { vendorId });
});

export const mailReviewVisibility = (db: PrismaClient, shop: string, vendorId: string, review: { rating: number; hidden: boolean; reason: string | null }) => safely("review visibility", async () => {
  const v = await vendorPeople(db, shop, vendorId, "owners");
  if (!v) return;
  if (review.hidden) await queueMail(db, shop, "review_hidden", v.people, { brand: v.brand, rating: review.rating, reason: review.reason }, { vendorId });
  else await queueMail(db, shop, "review_shown", v.people, { brand: v.brand, rating: review.rating }, { vendorId });
});

// ------------------------------------------------------------------ the team: things that broke (at most once a day each)

export const mailSyncFailed = (db: PrismaClient, shop: string, error: string, now = new Date()) =>
  safely("sync failed", async () => queueMail(db, shop, "admin_sync_failed", await teamAddresses(db, shop), { error }, { dedupe: `admin_sync_failed:${dayKey(now)}` }));

/** `what` reads after "couldn't copy …": "Ashnur's store listing", "the delivery time". */
export const mailStoreCopyFailed = (db: PrismaClient, shop: string, what: string, error: string, now = new Date()) =>
  safely("store copy failed", async () => queueMail(db, shop, "admin_store_copy_failed", await teamAddresses(db, shop), { what, error }, { dedupe: `admin_store_copy_failed:${what}:${dayKey(now)}` }));

/** A seller's address refused a mail: tell the team, once a day for each address. */
export const mailBounced = (db: PrismaClient, shop: string, m: { toEmail: string; template: string; vendorId: string | null; audience: string }, now = new Date()) => safely("bounce", async () => {
  if (m.audience !== "seller") return;
  const vendor = m.vendorId ? await db.vendor.findFirst({ where: { id: m.vendorId, shop }, select: { displayName: true } }) : null;
  const name = (TEMPLATES as Record<string, { name: string }>)[m.template as TemplateKey]?.name ?? m.template;
  await queueMail(db, shop, "admin_email_bouncing", await teamAddresses(db, shop), { email: m.toEmail, brand: vendor?.displayName ?? null, mail: name }, { vendorId: m.vendorId, dedupe: `admin_email_bouncing:${m.toEmail}:${dayKey(now)}` });
});
