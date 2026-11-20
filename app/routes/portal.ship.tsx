import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { listToShip } from "../lib/portal/data.server";
import { day } from "../lib/portal/format";

/** "What to ship": every unit still to send, oldest order first. Printable as a pick list. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  return { ...(await listToShip(db, { shop: me.shop, vendorName: me.vendor.vendorName })), vendor: me.vendor.displayName };
};

export default function WhatToShip() {
  const d = useLoaderData<typeof loader>();
  return (
    <main>
      <h1>What to ship</h1>
      <p className="vp-sub">
        {d.units} {d.units === 1 ? "unit" : "units"} across {d.orders.length} {d.orders.length === 1 ? "order" : "orders"}, oldest first.
      </p>
      {d.orders.length === 0 ? (
        <div className="vp-card"><p>Nothing to ship right now.</p></div>
      ) : (
        <>
          <p className="vp-noprint"><button className="vp-btn secondary" type="button" onClick={() => window.print()}>Print pick list</button></p>
          {d.orders.map((o) => (
            <section className="vp-card" key={o.orderId} aria-labelledby={`o-${o.orderId}`}>
              <h2 id={`o-${o.orderId}`} style={{ fontSize: 18, margin: "0 0 4px" }}>
                <Link to={`/portal/orders/${o.orderId}`}>{o.orderName}</Link>
              </h2>
              <p className="vp-note" style={{ marginTop: 0 }}>{day(o.createdAt)} · {d.vendor}</p>
              <table className="vp-table">
                <thead>
                  <tr><th>Item</th><th>SKU</th><th className="num">Units to ship</th></tr>
                </thead>
                <tbody>
                  {o.items.map((i, n) => (
                    <tr key={n}><td>{i.title}</td><td>{i.sku ?? "–"}</td><td className="num">{i.toShip}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
