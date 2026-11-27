import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, NavLink, Outlet, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { listToShip } from "../lib/portal/data.server";
import { IconBox, IconHome, IconOrders, IconOut, IconRupee, IconStar, IconStore, IconTeam } from "../lib/portal/icons";
import { portalLinks, Wordmark } from "../lib/portal/ui";
import { canManagePeople } from "../lib/vendors/team.server";

/**
 * Signed-in vendor shell: sidebar on desktop, top bar + bottom tabs on phones.
 * Every child page also calls requireVendor itself.
 */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const ship = await listToShip(db, { shop: me.shop, vendorName: me.vendor.vendorName });
  return {
    vendor: me.vendor.displayName, name: me.user.name, email: me.user.email, toShip: ship.units, owner: canManagePeople(me),
    teamView: me.teamViewer ? { by: me.teamViewer.replace(/^admin:/, ""), as: me.user.name || me.user.email } : null,
  };
};

const NAV = [
  { to: "/portal", label: "Home", long: "Dashboard", Icon: IconHome, end: true },
  { to: "/portal/orders", label: "Orders", long: "My orders", Icon: IconOrders, end: false },
  { to: "/portal/ship", label: "To ship", long: "What to ship", Icon: IconBox, end: false },
  { to: "/portal/earnings", label: "Earnings", long: "Earnings", Icon: IconRupee, end: false },
  { to: "/portal/profile", label: "My brand", long: "My brand", Icon: IconStore, end: false },
  // Reviews and Team stay in the sidebar; on phones Reviews is a link on the dashboard and Team a link on My brand (five tabs fit, more don't).
  { to: "/portal/reviews", label: "Reviews", long: "Reviews", Icon: IconStar, end: false, noTab: true },
  { to: "/portal/team", label: "Team", long: "Team", Icon: IconTeam, end: false, ownerOnly: true, noTab: true },
];

export default function PortalLayout() {
  const { vendor, name, email, toShip, owner, teamView } = useLoaderData<typeof loader>();
  const nav = NAV.filter((n) => owner || !("ownerOnly" in n));
  const count = (to: string) =>
    to === "/portal/ship" && toShip > 0 ? <span className="vp-count" aria-label={`${toShip} units to ship`}>{toShip > 99 ? "99+" : toShip}</span> : null;

  return (
    <div className="vp-app">
      <aside className="vp-side" aria-label="Portal">
        <Wordmark />
        <div className="vp-vendor">
          <b>{vendor}</b>
          <span>Selling on Setu Store</span>
        </div>
        <nav className="vp-nav" aria-label="Main">
          {nav.map(({ to, long, Icon, end }) => (
            <NavLink key={to} to={to} end={end}>
              <Icon />
              {long}
              {count(to)}
            </NavLink>
          ))}
        </nav>
        <div className="vp-side-foot">
          <div className="vp-who">
            {name && <b>{name}</b>}
            {email}
          </div>
          <Form method="post" action="/portal/logout">
            <button className="vp-btn vp-btn--text" type="submit"><IconOut />Sign out</button>
          </Form>
        </div>
      </aside>

      <header className="vp-topbar">
        <Wordmark sub={vendor} />
        <Form method="post" action="/portal/logout">
          <button className="vp-btn vp-btn--quiet" type="submit" style={{ minHeight: 38 }}>Sign out</button>
        </Form>
      </header>

      <main className="vp-main" id="main">
        <div className="vp-page">
          {teamView && (
            <div className="vp-teamview" role="status">
              <p>
                <b>Setu Store team view of {vendor}</b>
                <span>You&apos;re seeing what {teamView.as} sees. Read-only: nothing can be changed here. Ends after an hour.</span>
              </p>
              <Form method="post" action="/portal/logout">
                <button className="vp-btn vp-btn--quiet" type="submit">Leave team view</button>
              </Form>
            </div>
          )}
          <Outlet />
        </div>
      </main>

      <nav className="vp-tabs" aria-label="Main">
        {nav.filter((n) => !("noTab" in n)).map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end}>
            <Icon />
            {label}
            {count(to)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
