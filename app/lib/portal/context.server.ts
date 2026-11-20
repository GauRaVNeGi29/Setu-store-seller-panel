import { redirect } from "react-router";
import db from "../../db.server";
import { isAllowedShop } from "../guard.server";
import { getIdentity, readSessionToken, type PortalIdentity } from "./auth.server";

/**
 * The portal serves one Shopify store, named by PORTAL_SHOP. It must also be
 * in ALLOWED_SHOPS, so during development the portal can only ever show the
 * dev store's data.
 */
export function portalShop(env: Record<string, string | undefined> = process.env): string {
  const shop = (env.PORTAL_SHOP ?? "").trim().toLowerCase();
  if (!shop || !isAllowedShop(shop, env)) {
    throw new Response("Vendor portal is not configured.", { status: 503 });
  }
  return shop;
}

export type ActiveVendor = PortalIdentity & { shop: string; vendor: NonNullable<PortalIdentity["vendor"]> };

/**
 * Every page with order data starts here. Signed out → login.
 * Signed in but not yet approved → "under review" page, never order data.
 */
export async function requireVendor(request: Request): Promise<ActiveVendor> {
  const shop = portalShop();
  const identity = await getIdentity(db, shop, readSessionToken(request));
  if (!identity) throw redirect("/portal/login");
  if (identity.user.status !== "active" || !identity.vendor) throw redirect("/portal/pending");
  return { ...identity, shop, vendor: identity.vendor };
}

/** Any signed-in person, approved or not (used by the "under review" page). */
export async function requireUser(request: Request): Promise<PortalIdentity & { shop: string }> {
  const shop = portalShop();
  const identity = await getIdentity(db, shop, readSessionToken(request));
  if (!identity) throw redirect("/portal/login");
  return { ...identity, shop };
}

/** The public address of the portal, for links in emails. */
export function portalBaseUrl(request: Request, env: Record<string, string | undefined> = process.env): string {
  const configured = (env.PORTAL_URL || env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
