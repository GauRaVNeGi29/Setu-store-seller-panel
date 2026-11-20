import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, NavLink, Outlet, useLoaderData } from "react-router";
import { requireVendor } from "../lib/portal/context.server";
import styles from "../styles/portal.css?url";

/** Signed-in vendor layout. Every child page also calls requireVendor itself. */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Setu vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  return { vendor: me.vendor.displayName, email: me.user.email };
};

export default function PortalLayout() {
  const { vendor, email } = useLoaderData<typeof loader>();
  return (
    <div className="vp-shell">
      <header className="vp-top">
        <div className="vp-brand">
          {vendor}
          <small>Setu Store vendor portal</small>
        </div>
        <nav className="vp-nav" aria-label="Portal">
          <NavLink to="/portal" end>My orders</NavLink>
          <NavLink to="/portal/ship">What to ship</NavLink>
        </nav>
        <div className="vp-user">
          <span>{email}</span>
          <Form method="post" action="/portal/logout">
            <button className="vp-btn secondary" type="submit">Sign out</button>
          </Form>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
