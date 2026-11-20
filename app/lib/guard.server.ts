/**
 * Safety guard: this app only works with the shops listed in ALLOWED_SHOPS
 * (comma-separated myshopify domains). During development that is only the
 * dev store. The live store is refused unless it is added on purpose, which
 * is a decision for a future, approved production stage.
 */

export const LIVE_STORE = "q0zr1f-0m.myshopify.com";

export function allowedShops(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ALLOWED_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedShop(shop: string, env: Record<string, string | undefined> = process.env): boolean {
  return allowedShops(env).includes(shop.trim().toLowerCase());
}

export function assertAllowedShop(shop: string, env: Record<string, string | undefined> = process.env): void {
  if (!isAllowedShop(shop, env)) {
    throw new Response(`This app is not enabled for ${shop}.`, { status: 403 });
  }
}
