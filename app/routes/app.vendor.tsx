import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { vendorLines } from "../lib/orders/admin.server";

/**
 * One vendor's order lines, as the vendor will later see them in the portal.
 * Team-only for now (inside Shopify admin).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const name = new URL(request.url).searchParams.get("name") ?? "";
  return { name, lines: await vendorLines(db, session.shop, name) };
};

const inr = (v: string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cell = { padding: 6, borderBottom: "1px solid #eee", verticalAlign: "top" } as const;
const STATUS: Record<string, string> = {
  unfulfilled: "To ship", partial: "Partly shipped", fulfilled: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
};

export default function Vendor() {
  const { name, lines } = useLoaderData<typeof loader>();
  return (
    <s-page heading={name || "(no vendor)"}>
      <s-link slot="breadcrumb-actions" href="/app">Vendors</s-link>
      <s-section heading={`Order lines (${lines.length})`}>
        {lines.length === 0 ? (
          <s-paragraph>No orders for this vendor.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={cell}>Order</th>
                <th style={cell}>Date</th>
                <th style={cell}>Item</th>
                <th style={cell}>Qty</th>
                <th style={cell}>Shipped</th>
                <th style={cell}>Refunded</th>
                <th style={cell}>To ship</th>
                <th style={cell}>Line total</th>
                <th style={cell}>Net</th>
                <th style={cell}>Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineItemId}>
                  <td style={cell}>
                    <s-link href={`shopify://admin/orders/${l.orderId}`} target="_top">{l.orderName}</s-link>
                  </td>
                  <td style={cell}>{new Date(l.orderCreatedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                  <td style={cell}>{l.title}{l.sku ? <><br /><small>{l.sku}</small></> : null}</td>
                  <td style={cell}>{l.quantity}</td>
                  <td style={cell}>{l.fulfilledQuantity}</td>
                  <td style={cell}>{l.refundedQuantity}</td>
                  <td style={cell}>{l.toShip}</td>
                  <td style={cell}>{inr(l.lineTotal)}</td>
                  <td style={cell}>{inr(l.netAmount)}</td>
                  <td style={cell}>{STATUS[l.status] ?? l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
