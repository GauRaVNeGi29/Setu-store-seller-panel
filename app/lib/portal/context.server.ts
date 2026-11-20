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

/** Every portal page and action starts here. Signed out → login page. */
export async function requireVendor(request: Request): Promise<PortalIdentity & { shop: string }> {
  const shop = portalShop();
  const identity = await getIdentity(db, shop, readSessionToken(request));
  if (!identity) throw redirect("/portal/login");
  return { ...identity, shop };
}
