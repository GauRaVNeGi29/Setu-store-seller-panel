import type { LoaderFunctionArgs, MetaFunction } from "react-router";
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

export const meta: MetaFunction = () => [{ title: "My brand · Setu vendor portal" }];

function Rows({ rows }: { rows: [string, string | null][] }) {
  return (
    <dl className="vp-dl">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ? v : <span className="vp-none">Not added yet</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function Profile() {
  const { profile: p, me } = useLoaderData<typeof loader>();
  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">{p.displayName}</h1>
          <p className="vp-lead">The details Setu Store holds for your brand. To change any of them, contact the Setu team.</p>
        </div>
      </div>

      <section className="vp-panel" aria-labelledby="b1">
        <div className="vp-panel-head"><h2 className="vp-h2" id="b1">Business</h2></div>
        <Rows rows={[
          ["Phone", p.phone],
          ["GST number", p.gstNumber],
          ["City and state", [p.city, p.state].filter(Boolean).join(", ") || null],
          ["What you sell", p.productNote],
        ]} />
      </section>

      <section className="vp-panel" aria-labelledby="b2">
        <div className="vp-panel-head"><h2 className="vp-h2" id="b2">Your brand on Setu Store</h2></div>
        <Rows rows={[
          ["Brand description", p.description],
          ["Policy", p.policy],
          ["Minimum order value", p.minimumOrderValue ? inr(p.minimumOrderValue) : null],
        ]} />
      </section>

      <section className="vp-panel" aria-labelledby="b3">
        <div className="vp-panel-head"><h2 className="vp-h2" id="b3">Your sign-in</h2></div>
        <Rows rows={[["Name", me.name], ["Email", me.email]]} />
        <p className="vp-small" style={{ padding: "0 20px 18px", margin: 0 }}>
          To change your password, sign out and choose &ldquo;Forgot password?&rdquo; on the sign-in page.
        </p>
      </section>
    </>
  );
}
