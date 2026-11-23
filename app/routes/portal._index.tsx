import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { sellerDashboard } from "../lib/portal/dashboard.server";
import { RANGES, isRange, type RangeKey } from "../lib/portal/ranges";
import { canManagePeople, changeRequestState, vendorDetails } from "../lib/vendors/team.server";
import { vendorEarnings } from "../lib/commission/commission.server";
import { CHART_GREEN, CHART_MADDER, CHART_TURMERIC, RankedBars, SalesChart, StatusBar } from "../lib/portal/charts";
import { day, inr } from "../lib/portal/format";
import { IconBox } from "../lib/portal/icons";
import { plural, Status } from "../lib/portal/ui";

/**
 * Dashboard – the seller's home. Everything in brief:
 *  - right now: what's waiting to ship, and the state of their brand profile;
 *  - for a chosen period (7 / 30 / 90 days / all time, compared with the period before):
 *    sales, orders, units, average order value, refunds, sales over time,
 *    top products, orders by status and the latest orders.
 * Only this vendor's own lines, as everywhere in the portal.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const want = new URL(request.url).searchParams.get("range");
  const range: RangeKey = isRange(want) ? want : "30";
  const owner = canManagePeople(me);
  const [dash, earnings, details, change, people] = await Promise.all([
    sellerDashboard(db, { shop: me.shop, vendorName: me.vendor.vendorName }, range),
    vendorEarnings(db, { shop: me.shop, vendorName: me.vendor.vendorName, vendorId: me.vendor.id }, range),
    vendorDetails(db, me.shop, me.vendor.id),
    changeRequestState(db, me.shop, me.vendor.id),
    owner ? db.vendorUser.count({ where: { shop: me.shop, vendorId: me.vendor.id, status: { in: ["active", "invited"] } } }) : Promise.resolve(null),
  ]);
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }));
  return {
    dash,
    earn: { rate: earnings.rate, ...earnings.totals },
    greeting: hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening",
    firstName: (me.user.name ?? "").split(" ")[0] || null,
    teamView: !!me.teamViewer,
    brand: details && {
      name: details.displayName, logoId: details.logoFile?.id ?? null, missing: details.missing,
      minimumOrderValue: details.minimumOrderValue, shortDescription: details.shortDescription,
    },
    change: { pending: !!change.pending, declined: !change.pending && change.last?.status === "rejected" },
    people,
  };
};

export const meta: MetaFunction = () => [{ title: "Dashboard · Setu Store vendor portal" }];

const pctText = (n: number) => `${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;

/** "▲ 12% vs the previous 30 days" – colour by direction × whether up is good; the words carry it too. */
function Delta({ now, before, goodWhenUp = true, period }: { now: number | null; before: number | null; goodWhenUp?: boolean; period: string }) {
  if (before === null || now === null) return null;
  if (before === 0) {
    return <span className="vp-delta">{now > 0 ? `None in the previous ${period}` : `Same as the previous ${period}`}</span>;
  }
  const change = ((now - before) / before) * 100;
  if (Math.abs(change) < 0.05) return <span className="vp-delta">Same as the previous {period}</span>;
  const up = change > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`vp-delta ${good ? "vp-delta--good" : "vp-delta--bad"}`}>
      <span aria-hidden="true">{up ? "▲" : "▼"}</span> {up ? "Up" : "Down"} {pctText(change)} on the previous {period}
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="vp-tile">
      <span className="vp-tile-label">{label}</span>
      <span className="vp-tile-value">{value}</span>
      {children}
    </div>
  );
}

export default function Dashboard() {
  const { dash: d, earn, greeting, firstName, brand, change, people, teamView } = useLoaderData<typeof loader>();
  const loading = useNavigation().state === "loading";
  const period = d.range === "all" ? "" : `${d.range} days`;
  const k = d.kpis;
  const n = (v: string | null) => (v === null ? null : Number(v));
  const chartTitle = `Sales by ${d.bucket}, ${d.rangeLabel.toLowerCase()}`;

  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">{teamView ? `${brand?.name ?? "Vendor"} dashboard` : `${greeting}${firstName ? `, ${firstName}` : ""}`}</h1>
          <p className="vp-lead">Here&apos;s how {brand?.name ?? "your brand"} is doing on Setu Store.</p>
        </div>
      </div>

      {brand && brand.missing.length > 0 && (
        <p className="vp-msg vp-msg--todo" role="status">
          Complete your profile: add your {brand.missing.join(", ").replace(/, ([^,]*)$/, " and $1")} on <Link to="/portal/profile">My brand</Link>.
        </p>
      )}

      {/* ---------------- Right now ---------------- */}
      <div className="vp-dash-now">
        <section className="vp-panel vp-panel-body vp-now" aria-labelledby="now-ship">
          <div className="vp-now-head">
            <h2 className="vp-h2" id="now-ship">To ship</h2>
            {d.toShip.units > 0 && <Link className="vp-btn vp-btn--quiet" to="/portal/ship"><IconBox />Open pick list</Link>}
          </div>
          {d.toShip.units > 0 ? (
            <>
              <p className="vp-now-line">
                <b>{plural(d.toShip.units, "unit", "units")}</b> waiting across {plural(d.toShip.orders, "order", "orders")}.
              </p>
              <ul className="vp-now-list">
                {d.toShip.oldest.map((o) => (
                  <li key={o.orderId}>
                    <Link to={`/portal/orders/${o.orderId}`}>{o.orderName}</Link>
                    <span className="vp-small">{plural(o.toShip, "unit", "units")} · placed {day(o.createdAt)}</span>
                    <span className={`vp-wait${o.daysWaiting >= 3 ? " vp-wait--late" : ""}`}>
                      {o.daysWaiting === 0 ? "Today" : `Waiting ${plural(o.daysWaiting, "day", "days")}`}
                    </span>
                  </li>
                ))}
              </ul>
              {d.toShip.orders > d.toShip.oldest.length && (
                <p className="vp-small" style={{ margin: "10px 0 0" }}>Oldest first. {d.toShip.orders - d.toShip.oldest.length} more on the pick list.</p>
              )}
            </>
          ) : (
            <p className="vp-now-line">Nothing waiting to ship. You&apos;re all caught up.</p>
          )}
        </section>

        <section className="vp-panel vp-panel-body vp-now vp-brandcard" aria-labelledby="now-brand">
          <div className="vp-brandcard-id">
            {brand?.logoId
              ? <img src={`/portal/files/${brand.logoId}`} alt="" className="vp-brandcard-logo" />
              : <span className="vp-brandcard-logo vp-brandcard-logo--empty" aria-hidden="true">{(brand?.name ?? "?").slice(0, 1)}</span>}
            <div>
              <h2 className="vp-h2" id="now-brand">{brand?.name}</h2>
              {brand?.shortDescription && <p className="vp-small" style={{ margin: "2px 0 0" }}>{brand.shortDescription}</p>}
            </div>
          </div>
          <dl className="vp-brandcard-facts">
            <div>
              <dt>Profile</dt>
              <dd>{brand && brand.missing.length === 0
                ? <span className="vp-badge vp-badge--active">Complete</span>
                : <Link to="/portal/profile">{plural(brand?.missing.length ?? 0, "detail", "details")} missing</Link>}</dd>
            </div>
            <div>
              <dt>Minimum order</dt>
              <dd>{brand?.minimumOrderValue ? inr(brand.minimumOrderValue) : <Link to="/portal/profile?edit=brand">Add</Link>}</dd>
            </div>
            {(change.pending || change.declined) && (
              <div>
                <dt>Business details</dt>
                <dd>{change.pending
                  ? <span className="vp-badge vp-badge--pending">Waiting for approval</span>
                  : <Link to="/portal/profile">Change not approved – see why</Link>}</dd>
              </div>
            )}
            {people !== null && (
              <div>
                <dt>Team</dt>
                <dd><Link to="/portal/team">{plural(people, "person", "people")}</Link></dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      {/* ---------------- Period ---------------- */}
      <nav className="vp-seg vp-dash-range" aria-label="Period">
        {(Object.keys(RANGES) as RangeKey[]).map((r) => (
          <Link key={r} to={r === "30" ? "/portal" : `/portal?range=${r}`} aria-current={d.range === r ? "true" : undefined} preventScrollReset>
            {RANGES[r]}
          </Link>
        ))}
      </nav>

      <div className={`vp-dash-period${loading ? " vp-dash-period--loading" : ""}`}>
        <div className="vp-dash-kpis">
        <section className="vp-panel vp-panel-body vp-hero-fig" aria-labelledby="sales-label">
          <span className="vp-tile-label" id="sales-label">Sales after refunds · {d.rangeLabel.toLowerCase()}</span>
          <span className="vp-hero-value">{inr(d.sales.net)}</span>
          <Delta now={n(d.sales.net)} before={n(d.sales.previous)} period={period} />
        </section>

        <div className="vp-tiles">
          <Tile label="Orders" value={k.orders.value.toLocaleString("en-IN")}>
            <Delta now={k.orders.value} before={k.orders.previous} period={period} />
          </Tile>
          <Tile label="Units sold" value={k.units.value.toLocaleString("en-IN")}>
            <Delta now={k.units.value} before={k.units.previous} period={period} />
          </Tile>
          <Tile label="Average order" value={k.aov.value ? inr(k.aov.value) : "–"}>
            <Delta now={n(k.aov.value)} before={n(k.aov.previous)} period={period} />
          </Tile>
          <Tile label="Refunded" value={inr(k.refunded.value)}>
            <Delta now={n(k.refunded.value)} before={n(k.refunded.previous)} goodWhenUp={false} period={period} />
          </Tile>
        </div>
        </div>

        <section className="vp-panel vp-panel-body vp-earncard" aria-labelledby="earn-title">
          <div className="vp-now-head">
            <h2 className="vp-h2" id="earn-title">Earnings</h2>
            <Link to={d.range === "30" ? "/portal/earnings" : `/portal/earnings?range=${d.range}`}>See by order</Link>
          </div>
          {earn.rate === null ? (
            <p className="vp-now-line">Your commission rate hasn&apos;t been set yet. Your earnings will show here once the Setu Store team sets it.</p>
          ) : (
            <dl className="vp-earnline">
              <div><dt>Sales after refunds</dt><dd>{inr(earn.net)}</dd></div>
              <div><dt>Setu Store commission ({Number(earn.rate)}%)</dt><dd>− {inr(earn.commission)}</dd></div>
              <div className="vp-earnline-total"><dt>You earn</dt><dd>{inr(earn.earnings)}</dd></div>
            </dl>
          )}
        </section>

        <section className="vp-panel vp-panel-body" aria-labelledby="chart-title">
          <h2 className="vp-h2" id="chart-title">Sales by {d.bucket}</h2>
          <p className="vp-small vp-panel-note">{d.rangeLabel}, after refunds, by the day each order was placed.</p>
          <SalesChart points={d.series} title={chartTitle} />
        </section>

        <div className="vp-dash-split">
          <section className="vp-panel vp-panel-body" aria-labelledby="top-title">
            <h2 className="vp-h2" id="top-title">Top products</h2>
            <p className="vp-small vp-panel-note">By sales after refunds, {d.rangeLabel.toLowerCase()}.</p>
            {d.topProducts.length
              ? <RankedBars rows={d.topProducts.map((p) => ({ label: p.title, value: Number(p.net), display: inr(p.net), sub: plural(p.units, "unit", "units") }))} />
              : <p className="vp-small">No products sold in this period.</p>}
          </section>
          <section className="vp-panel vp-panel-body" aria-labelledby="status-title">
            <h2 className="vp-h2" id="status-title">Orders by status</h2>
            <p className="vp-small vp-panel-note">Orders placed {d.rangeLabel.toLowerCase()}, as they stand today.</p>
            <StatusBar parts={[
              { name: "Shipped", value: d.status.shipped, color: CHART_GREEN, ink: "#fff" },
              { name: "To ship", value: d.status.open, color: CHART_TURMERIC, ink: "#2e2b28" },
              { name: "Cancelled or refunded", value: d.status.cancelled, color: CHART_MADDER, ink: "#fff" },
            ]} />
          </section>
        </div>

        <section className="vp-panel" aria-labelledby="recent-title">
          <div className="vp-panel-head">
            <h2 className="vp-h2" id="recent-title">Latest orders</h2>
            <Link to="/portal/orders">See all orders</Link>
          </div>
          {d.recent.length ? (
            <>
            <table className="vp-table vp-table--orders">
              <thead><tr><th>Order</th><th>Placed</th><th className="r">Units</th><th className="r">Your sales</th><th>Status</th></tr></thead>
              <tbody>
                {d.recent.map((o) => (
                  <tr key={o.orderId}>
                    <td><Link className="vp-ordno" to={`/portal/orders/${o.orderId}`}>{o.orderName}</Link></td>
                    <td>{day(o.createdAt)}</td>
                    <td className="r">{o.status === "cancelled" ? "–" : o.units}</td>
                    <td className="r">{o.status === "cancelled" ? "–" : inr(o.net)}</td>
                    <td><Status value={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="vp-cards" aria-label="Latest orders">
              {d.recent.map((o) => (
                <li key={o.orderId}>
                  <Link className="vp-card-link" to={`/portal/orders/${o.orderId}`}>
                    <b>{o.orderName}</b>
                    <Status value={o.status} />
                    <span className="vp-card-meta">
                      <span>{day(o.createdAt)}{o.status === "cancelled" ? "" : `, ${plural(o.units, "unit", "units")}`}</span>
                      <strong>{o.status === "cancelled" ? "–" : inr(o.net)}</strong>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            </>
          ) : (
            <p className="vp-panel-body vp-small" style={{ margin: 0 }}>No orders {d.rangeLabel.toLowerCase()}.{d.hasOrders ? " Try a longer period." : ""}</p>
          )}
        </section>
      </div>
    </>
  );
}
