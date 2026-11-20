import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { getVendorProfile } from "../lib/vendors/vendors.server";
import { inr } from "../lib/portal/format";

/** "My brand": the vendor's details as Setu Store holds them. Read-only for now. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const profile = await getVendorProfile(db, me.shop, me.vendor.id);
  if (!profile) throw new Response("Not found", { status: 404 });
  return { profile, me: { name: me.user.name, email: me.user.email } };
};

export default function Profile() {
  const { profile: p, me } = useLoaderData<typeof loader>();
  const rows: [string, string | null][] = [
    ["Brand name", p.displayName],
    ["Phone", p.phone],
    ["GST number", p.gstNumber],
    ["City / state", [p.city, p.state].filter(Boolean).join(", ") || null],
    ["Minimum order value", p.minimumOrderValue ? inr(p.minimumOrderValue) : null],
    ["What you sell", p.productNote],
    ["Brand description", p.description],
    ["Policy", p.policy],
  ];
  return (
    <main>
      <h1>My brand</h1>
      <p className="vp-sub">How Setu Store has your details. To change anything, contact the Setu team.</p>
      <div className="vp-card">
        <dl className="vp-dl">
          {rows.map(([k, val]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{val ?? <span className="vp-note">Not given</span>}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="vp-card">
        <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>Your sign-in</h2>
        <p style={{ margin: 0 }}>{me.name ? `${me.name} · ` : ""}{me.email}</p>
        <p className="vp-note">To change your password, sign out and use &ldquo;Forgot password?&rdquo;.</p>
      </div>
    </main>
  );
}
