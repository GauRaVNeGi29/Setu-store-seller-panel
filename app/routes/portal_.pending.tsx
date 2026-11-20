import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import db from "../db.server";
import { requireUser } from "../lib/portal/context.server";
import { day } from "../lib/portal/format";
import { AuthLayout, portalLinks } from "../lib/portal/ui";

/** /portal/pending – a self sign-up waiting for the Setu Store team. No order data here. */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Account under review · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireUser(request);
  if (me.user.status === "active") throw redirect("/portal");
  const u = await db.vendorUser.findUnique({ where: { id: me.user.id }, select: { application: true, createdAt: true } });
  const a = (u?.application ?? {}) as { brandName?: string };
  return { name: me.user.name, email: me.user.email, brandName: a.brandName ?? null, since: u?.createdAt.toISOString() ?? null };
};

export default function Pending() {
  const d = useLoaderData<typeof loader>();
  return (
    <AuthLayout
      title={d.name ? `Thanks, ${d.name.split(" ")[0]}. We're reviewing your account.` : "We're reviewing your account."}
      lead={
        <>
          The Setu Store team is checking the details you sent{d.brandName ? <> for <b>{d.brandName}</b></> : null}. Once they approve your
          account and link it to your products, your orders will appear here.
        </>
      }
    >
      <div className="vp-panel vp-panel-body vp-summary" style={{ marginBottom: 20, position: "static" }}>
        <dl>
          <div><dt>Signed in as</dt><dd style={{ fontWeight: 500 }}>{d.email}</dd></div>
          {d.since && <div><dt>Sent</dt><dd style={{ fontWeight: 500 }}>{day(d.since)}</dd></div>}
          <div><dt>Status</dt><dd><span className="vp-status vp-status--to_ship">Under review</span></dd></div>
        </dl>
      </div>
      <p className="vp-small">You don&apos;t need to do anything else. Questions? Contact the Setu Store team.</p>
      <Form method="post" action="/portal/logout" className="vp-auth-alt">
        <button className="vp-btn vp-btn--quiet" type="submit">Sign out</button>
      </Form>
    </AuthLayout>
  );
}
