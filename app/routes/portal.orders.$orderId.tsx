import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { getMyOrder } from "../lib/portal/data.server";
import { day, inr } from "../lib/portal/format";

const LINE_STATUS: Record<string, string> = {
  unfulfilled: "To ship", partial: "Partly shipped", fulfilled: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
};
const ORDER_STATUS: Record<string, string> = {
  to_ship: "To ship", partly_shipped: "Partly shipped", shipped: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const order = await getMyOrder(db, { shop: me.shop, vendorName: me.vendor.vendorName }, String(params.orderId ?? ""));
  // Another vendor's order and a non-existent order look exactly the same.
  if (!order) throw new Response("Order not found", { status: 404 });
  return { order, vendor: me.vendor.displayName };
};

export default function OrderDetail() {
  const { order, vendor } = useLoaderData<typeof loader>();
  return (
    <main>
      <p className="vp-noprint"><Link to="/portal">← My orders</Link></p>
      <h1>Order {order.orderName}</h1>
      <p className="vp-sub">
        {day(order.createdAt)} · <span className={`vp-badge ${order.status}`}>{ORDER_STATUS[order.status]}</span> · {vendor}
      </p>

      <div className="vp-card">
        <div className="vp-scroll">
          <table className="vp-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th className="num">Ordered</th>
                <th className="num">Refunded</th>
                <th className="num">Shipped</th>
                <th className="num">To ship</th>
                <th className="num">Unit price</th>
                <th className="num">Your sales</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.lineItemId}>
                  <td>{l.title}{l.variantTitle ? <><br /><span className="vp-note">{l.variantTitle}</span></> : null}</td>
                  <td>{l.sku ?? "–"}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{l.refundedQuantity}</td>
                  <td className="num">{l.shipped}</td>
                  <td className="num">{l.toShip}</td>
                  <td className="num">{inr(l.unitPrice)}</td>
                  <td className="num">{inr(l.netAmount)}</td>
                  <td><span className={`vp-badge ${l.status}`}>{LINE_STATUS[l.status]}</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}><b>Your sales on this order</b></td>
                <td className="num"><b>{inr(order.net)}</b></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="vp-note">
          Only your items are shown. Delivery details are handled by the Setu team for now.
        </p>
        <button className="vp-btn secondary vp-noprint" type="button" onClick={() => window.print()}>Print</button>
      </div>
    </main>
  );
}

export function ErrorBoundary() {
  return (
    <main>
      <p><Link to="/portal">← My orders</Link></p>
      <h1>Order not found</h1>
      <p className="vp-sub">This order doesn&apos;t exist or doesn&apos;t include your products.</p>
    </main>
  );
}
