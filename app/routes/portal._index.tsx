import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { listMyOrders, type OrderFilter } from "../lib/portal/data.server";
import { day, inr } from "../lib/portal/format";
import { IconBox } from "../lib/portal/icons";
import { plural, Status } from "../lib/portal/ui";

const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "to_ship", label: "To ship" },
  { value: "shipped", label: "Shipped" },
  { value: "cancelled", label: "Cancelled" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const url = new URL(request.url);
  const f = url.searchParams.get("status") as OrderFilter | null;
  const filter = FILTERS.some((x) => x.value === f) ? (f as OrderFilter) : "all";
  const page = Number(url.searchParams.get("page") ?? 1);
  const list = await listMyOrders(db, { shop: me.shop, vendorName: me.vendor.vendorName }, filter, page);
  return { ...list, filter };
};

export default function MyOrders() {
  const d = useLoaderData<typeof loader>();
  const o = d.overview;
  const navigate = useNavigate();
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const q = (status: string, page = 1) =>
    `?${new URLSearchParams({ ...(status !== "all" ? { status } : {}), ...(page > 1 ? { page: String(page) } : {}) })}`;
  const waiting = o.unitsToShip > 0;

  return (
    <>
      <section className={`vp-hero${waiting ? "" : " vp-hero--clear"}`} aria-labelledby="hero-line">
        <div>
          <p className="vp-hero-line" id="hero-line">
            {waiting ? (
              <><strong>{plural(o.unitsToShip, "unit", "units")}</strong> waiting to ship across {plural(o.openOrders, "order", "orders")}.</>
            ) : o.counts.all ? (
              <>Everything is shipped.</>
            ) : (
              <>Your orders will appear here.</>
            )}
          </p>
          {waiting && o.oldestOpen && <p className="vp-hero-sub">The oldest is from {day(o.oldestOpen)}.</p>}
          <div className="vp-hero-figs">
            <div className="vp-fig"><b className="vp-num">{o.counts.all}</b><span>orders with your products</span></div>
            <div className="vp-fig"><b className="vp-num">{inr(o.sales)}</b><span>your sales after refunds</span></div>
          </div>
        </div>
        {waiting && (
          <Link className="vp-btn" to="/portal/ship"><IconBox />Open pick list</Link>
        )}
      </section>

      <section className="vp-panel" aria-labelledby="orders-title">
        <div className="vp-panel-head">
          <h1 className="vp-h2" id="orders-title">My orders</h1>
          <nav className="vp-seg" aria-label="Filter orders">
            {FILTERS.map((f) => (
              <Link key={f.value} to={q(f.value)} aria-current={d.filter === f.value ? "true" : undefined} preventScrollReset>
                {f.label}<span className="vp-num">{o.counts[f.value]}</span>
              </Link>
            ))}
          </nav>
        </div>

        {d.orders.length === 0 ? (
          <div className="vp-empty">
            <p className="vp-h3">{d.filter === "all" ? "No orders yet" : "Nothing in this list"}</p>
            <p>
              {d.filter === "all"
                ? "When a retailer orders your products on Setu Store, the order appears here."
                : <Link to="?">Show all orders</Link>}
            </p>
          </div>
        ) : (
          <>
            <table className="vp-table vp-table--orders">
              <caption className="vp-sr">Orders that include your products. Only your items are counted.</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="r">Your items</th>
                  <th scope="col" className="r">To ship</th>
                  <th scope="col" className="r">Your sales</th>
                </tr>
              </thead>
              <tbody>
                {d.orders.map((r) => (
                  <tr key={r.orderId} className="vp-rowlink" onClick={() => navigate(`/portal/orders/${r.orderId}`)}>
                    <td><Link className="vp-ordno" to={`/portal/orders/${r.orderId}`}>{r.orderName}</Link></td>
                    <td>{day(r.createdAt)}</td>
                    <td><Status value={r.status} /></td>
                    <td className="r">{r.status === "cancelled" ? "–" : plural(r.units, "unit", "units")}</td>
                    <td className="r">{r.toShip || "–"}</td>
                    <td className="r">{inr(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="vp-cards" aria-label="Orders">
              {d.orders.map((r) => (
                <li key={r.orderId}>
                  <Link className="vp-card-link" to={`/portal/orders/${r.orderId}`}>
                    <b>{r.orderName}</b>
                    <Status value={r.status} />
                    <span className="vp-card-meta">
                      <span>{day(r.createdAt)}{r.status === "cancelled" ? "" : `, ${plural(r.units, "unit", "units")}`}{r.toShip ? `, ${r.toShip} to ship` : ""}</span>
                      <strong>{inr(r.net)}</strong>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {pages > 1 && (
          <div className="vp-pager">
            {d.page > 1 ? <Link to={q(d.filter, d.page - 1)}>Newer orders</Link> : <span />}
            <span className="vp-small">Page {d.page} of {pages}</span>
            {d.page < pages ? <Link to={q(d.filter, d.page + 1)}>Older orders</Link> : <span />}
          </div>
        )}
      </section>
      <p className="vp-small" style={{ marginTop: 14 }}>
        Your sales are your items&apos; value after discounts and refunds, before Setu Store&apos;s commission.
      </p>
    </>
  );
}
