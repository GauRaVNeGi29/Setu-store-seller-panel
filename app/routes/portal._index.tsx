import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { listMyOrders, type OrderFilter } from "../lib/portal/data.server";
import { day, inr } from "../lib/portal/format";

const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "to_ship", label: "To ship" },
  { value: "shipped", label: "Shipped" },
  { value: "cancelled", label: "Cancelled / refunded" },
];
const STATUS: Record<string, string> = {
  to_ship: "To ship", partly_shipped: "Partly shipped", shipped: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const url = new URL(request.url);
  const f = url.searchParams.get("status") as OrderFilter | null;
  const filter = FILTERS.some((x) => x.value === f) ? (f as OrderFilter) : "all";
  const page = Number(url.searchParams.get("page") ?? 1);
  const [list, open] = await Promise.all([
    listMyOrders(db, { shop: me.shop, vendorName: me.vendor.vendorName }, filter, page),
    listMyOrders(db, { shop: me.shop, vendorName: me.vendor.vendorName }, "to_ship", 1),
  ]);
  return { ...list, filter, openOrders: open.total, unitsToShip: open.orders.reduce((a, o) => a + o.toShip, 0) };
};


export default function MyOrders() {
  const d = useLoaderData<typeof loader>();
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const q = (status: string, page = 1) => `?${new URLSearchParams({ ...(status !== "all" ? { status } : {}), ...(page > 1 ? { page: String(page) } : {}) })}`;

  return (
    <main>
      <h1>My orders</h1>
      <p className="vp-sub">Orders from Setu Store that include your products. Only your items are shown.</p>

      <div className="vp-stats">
        <div className="vp-stat"><b>{d.openOrders}</b><span>orders waiting to ship</span></div>
        <div className="vp-stat"><b>{d.unitsToShip}</b><span>units to ship</span></div>
      </div>

      <div className="vp-card">
        <nav className="vp-filters" aria-label="Filter orders">
          {FILTERS.map((f) => (
            <Link key={f.value} to={q(f.value)} aria-current={d.filter === f.value ? "true" : undefined}>{f.label}</Link>
          ))}
        </nav>
        {d.orders.length === 0 ? (
          <p>No orders here yet.</p>
        ) : (
          <div className="vp-scroll">
            <table className="vp-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Date</th>
                  <th className="num">Your items</th>
                  <th className="num">Units</th>
                  <th className="num">To ship</th>
                  <th className="num">Your sales</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.orderId}>
                    <td><Link to={`/portal/orders/${o.orderId}`}>{o.orderName}</Link></td>
                    <td>{day(o.createdAt)}</td>
                    <td className="num">{o.items}</td>
                    <td className="num">{o.units}</td>
                    <td className="num">{o.toShip}</td>
                    <td className="num">{inr(o.net)}</td>
                    <td><span className={`vp-badge ${o.status}`}>{STATUS[o.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="vp-pager">
            {d.page > 1 && <Link to={q(d.filter, d.page - 1)}>← Newer</Link>}
            <span className="vp-note">Page {d.page} of {pages}</span>
            {d.page < pages && <Link to={q(d.filter, d.page + 1)}>Older →</Link>}
          </div>
        )}
        <p className="vp-note">&ldquo;Your sales&rdquo; is your items&apos; value after discounts and refunds, before Setu&apos;s commission.</p>
      </div>
    </main>
  );
}
