import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import db from "../db.server";
import { requireUser } from "../lib/portal/context.server";
import styles from "../styles/portal.css?url";

/** /portal/pending – a self sign-up waiting for the Setu team. No order data here. */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Account under review · Setu vendor portal" }, { name: "robots", content: "noindex" }];

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
    <main className="vp-login" style={{ maxWidth: 520 }}>
      <div className="vp-card">
        <div className="vp-brand">Setu Store<small>Vendor portal</small></div>
        <h1 style={{ marginTop: 18 }}>Thanks{d.name ? `, ${d.name}` : ""} – your account is under review</h1>
        <p className="vp-sub">
          The Setu team is checking the details you sent{d.brandName ? <> for <b>{d.brandName}</b></> : null}. Once they approve your
          account and link it to your products on Setu Store, you&apos;ll see your orders here.
        </p>
        <p className="vp-note">
          Signed in as {d.email}
          {d.since ? ` · submitted ${new Date(d.since).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}` : ""}.
          Questions? Contact the Setu team.
        </p>
        <Form method="post" action="/portal/logout">
          <button className="vp-btn secondary" type="submit">Sign out</button>
        </Form>
      </div>
    </main>
  );
}
