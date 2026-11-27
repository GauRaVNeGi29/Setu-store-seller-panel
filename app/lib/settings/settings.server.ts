import type { PrismaClient } from "@prisma/client";
import type { AdminGraphql } from "../orders/sync.server";
import { friendly } from "../storefront/listing.server";
import { cleanDayRange, rangeOf, type DayRange } from "../vendors/shipping";

/**
 * Settings the Setu Store team changes in the Shopify app.
 *
 * Delivery time: the days a shipment takes to reach the buyer once the vendor
 * hands it over. One range for the whole store. The app keeps it in its own
 * table and copies it to the store as two app-data metafields (stored on the
 * app's installation, so only this app can change them). The seller page
 * reads them in Liquid as app.metafields.setu_seller.delivery_days_min / _max
 * and adds them to the seller's processing time.
 */

export const SETTINGS_NAMESPACE = "setu_seller";
export const DELIVERY_KEYS = { min: "delivery_days_min", max: "delivery_days_max" } as const;

export const INSTALLATION_QUERY = `#graphql
  query SetuAppInstallation { currentAppInstallation { id } }`;

export const SETTINGS_SET = `#graphql
  mutation SetuSettingsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key }
      userErrors { field message code }
    }
  }`;

export const SETTINGS_DELETE = `#graphql
  mutation SetuSettingsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }`;

type UserError = { message: string };

async function call<T>(graphql: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const body = (await (await graphql(query, variables ? { variables } : undefined)).json()) as { data?: T; errors?: unknown };
  if (body.errors) throw body.errors;
  if (!body.data) throw new Error("Shopify returned no data.");
  return body.data;
}

/** Copies the delivery time to the store (or removes it when not set). Throws with a message for the team. */
export async function publishDeliveryTime(graphql: AdminGraphql, range: DayRange | null): Promise<void> {
  try {
    const { currentAppInstallation } = await call<{ currentAppInstallation: { id: string } }>(graphql, INSTALLATION_QUERY);
    const ownerId = currentAppInstallation.id;
    const ids = [DELIVERY_KEYS.min, DELIVERY_KEYS.max].map((key) => ({ ownerId, namespace: SETTINGS_NAMESPACE, key }));
    let errors: UserError[];
    if (range) {
      const values = [range.min, range.max];
      const r = await call<{ metafieldsSet: { userErrors: UserError[] } }>(graphql, SETTINGS_SET, {
        metafields: ids.map((id, i) => ({ ...id, type: "number_integer", value: String(values[i]) })),
      });
      errors = r.metafieldsSet.userErrors;
    } else {
      const r = await call<{ metafieldsDelete: { userErrors: UserError[] } }>(graphql, SETTINGS_DELETE, { metafields: ids });
      errors = r.metafieldsDelete.userErrors;
    }
    if (errors.length) throw new Error(`Shopify didn't accept the delivery time: ${errors.map((e) => e.message).join("; ")}`);
  } catch (e) {
    throw new Error(e instanceof Error && e.message.startsWith("Shopify didn't accept") ? e.message : friendly(e));
  }
}

export async function deliveryTime(db: PrismaClient, shop: string) {
  const s = await db.shopSetting.findUnique({ where: { shop } });
  return {
    range: rangeOf(s?.deliveryDaysMin, s?.deliveryDaysMax),
    /** Why the store doesn't show the saved value yet, if the last copy failed. */
    error: s?.deliveryError ?? null,
    updatedBy: s?.updatedBy?.replace(/^admin:/, "") ?? null,
    updatedAt: s?.updatedAt.toISOString() ?? null,
  };
}

export type DeliveryResult =
  | { ok: true; range: DayRange | null; onStore: true }
  | { ok: true; range: DayRange | null; onStore: false; error: string }
  | { ok: false; error: string };

/**
 * Saves the delivery time and copies it to the store. The setting is kept
 * even if the copy fails; the reason is recorded and shown, and saving again
 * (or "Send to the store again") retries.
 */
export async function saveDeliveryTime(
  db: PrismaClient, graphql: AdminGraphql, shop: string, raw: { min: string; max: string }, actor: string,
): Promise<DeliveryResult> {
  const { range, error } = cleanDayRange(raw.min, raw.max, "delivery time");
  if (error) return { ok: false, error };
  const before = await db.shopSetting.findUnique({ where: { shop } });
  const data = { deliveryDaysMin: range?.min ?? null, deliveryDaysMax: range?.max ?? null, updatedBy: actor };
  await db.shopSetting.upsert({ where: { shop }, create: { shop, ...data }, update: data });
  await db.auditLog.create({
    data: {
      shop, actor, action: "settings.delivery_time_updated", target: "settings",
      detail: { from: rangeOf(before?.deliveryDaysMin, before?.deliveryDaysMax), to: range },
    },
  });
  return copyToStore(db, graphql, shop, range);
}

/** Sends the saved delivery time to the store again (after a failed copy, or a reinstall). */
export async function resendDeliveryTime(db: PrismaClient, graphql: AdminGraphql, shop: string): Promise<DeliveryResult> {
  const s = await db.shopSetting.findUnique({ where: { shop } });
  return copyToStore(db, graphql, shop, rangeOf(s?.deliveryDaysMin, s?.deliveryDaysMax));
}

async function copyToStore(db: PrismaClient, graphql: AdminGraphql, shop: string, range: DayRange | null): Promise<DeliveryResult> {
  try {
    await publishDeliveryTime(graphql, range);
  } catch (e) {
    const error = (e as Error).message;
    await db.shopSetting.upsert({ where: { shop }, create: { shop, deliveryError: error }, update: { deliveryError: error } });
    return { ok: true, range, onStore: false, error };
  }
  await db.shopSetting.upsert({ where: { shop }, create: { shop }, update: { deliveryError: null } });
  return { ok: true, range, onStore: true };
}
