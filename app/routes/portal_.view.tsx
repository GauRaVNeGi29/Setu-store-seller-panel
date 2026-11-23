import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import db from "../db.server";
import { clientIp, redeemTeamHandoff, sessionCookie } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { AuthLayout, portalLinks } from "../lib/portal/ui";

/**
 * /portal/view?token=… – opened in a new tab by "View portal as this vendor"
 * in Shopify admin. Swaps the one-time token for a read-only, one-hour session
 * and goes to the dashboard. An expired or used link shows how to get a new one.
 */
export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Team view · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const s = await redeemTeamHandoff(db, token, { shop: portalShop(), ip: clientIp(request), userAgent: request.headers.get("user-agent") });
  if (s) throw redirect("/portal", { headers: { "Set-Cookie": sessionCookie(s.token, s.expiresAt) } });
  return null;
};

export default function TeamView() {
  return (
    <AuthLayout
      title="This team-view link has expired"
      lead="Links from Shopify admin work once, for 60 seconds. Go back to the vendor's page in the Setu Store Seller Panel app and choose “View portal as this vendor” again."
    >
      <p className="vp-small">Vendors sign in on the <a href="/portal/login">sign-in page</a>.</p>
    </AuthLayout>
  );
}
