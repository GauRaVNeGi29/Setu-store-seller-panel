import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { vendorLines } from "../lib/orders/admin.server";
import { addVendorUser, enableVendor, getVendorByName, getVendorProfile, removeVendorUser, setVendorStatus } from "../lib/vendors/vendors.server";

/**
 * One vendor: portal access (Stage 2) and their order lines (Stage 1).
 * Team-only, inside Shopify admin.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const name = new URL(request.url).searchParams.get("name") ?? "";
  const [lines, vendor] = await Promise.all([vendorLines(db, session.shop, name), getVendorByName(db, session.shop, name)]);
  const profile = vendor ? await getVendorProfile(db, session.shop, vendor.id) : null;
  return {
    name,
    lines,
    profile,
    vendor: vendor && {
      id: vendor.id,
      status: vendor.status,
      users: vendor.users.map((u) => ({ id: u.id, email: u.email, name: u.name, phone: u.phone, status: u.status, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const name = String(form.get("name") ?? "");

  if (intent === "enable") {
    if (!name) return { ok: false, error: "Vendor name missing" };
    await enableVendor(db, shop, name, actor);
    return { ok: true, message: "Portal access set up" };
  }
  const vendor = await getVendorByName(db, shop, name);
  if (!vendor) return { ok: false, error: "Set up portal access first" };

  if (intent === "add_user") {
    const r = await addVendorUser(db, shop, vendor.id, String(form.get("email") ?? ""), String(form.get("person") ?? ""), actor);
    return r.ok ? { ok: true, message: "Email added" } : r;
  }
  if (intent === "remove_user") {
    const r = await removeVendorUser(db, shop, String(form.get("userId") ?? ""), actor);
    return r.ok ? { ok: true, message: "Access removed" } : r;
  }
  if (intent === "pause" || intent === "activate") {
    const r = await setVendorStatus(db, shop, vendor.id, intent === "pause" ? "paused" : "active", actor);
    return r.ok ? { ok: true, message: intent === "pause" ? "Vendor paused – signed out everywhere" : "Vendor active" } : r;
  }
  return { ok: false, error: "Unknown action" };
};

const inr = (v: string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cell = { padding: 6, borderBottom: "1px solid #eee", verticalAlign: "top" } as const;
const USER_STATUS: Record<string, string> = {
  invited: "Invited – no password yet", pending: "Waiting for review", active: "Active", rejected: "Declined", disabled: "Removed",
};
const STATUS: Record<string, string> = {
  unfulfilled: "To ship", partial: "Partly shipped", fulfilled: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
};

export default function Vendor() {
  const { name, lines, vendor, profile } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const r = fetcher.data;
    if (r && "message" in r && r.message) shopify.toast.show(r.message);
  }, [fetcher.data, shopify]);

  const submit = (fields: Record<string, string>) => fetcher.submit({ name, ...fields }, { method: "POST" });

  return (
    <s-page heading={name || "(no vendor)"}>
      <s-link slot="breadcrumb-actions" href="/app">Vendors</s-link>

      <s-section heading="Vendor portal access">
        {fetcher.data && "error" in fetcher.data && fetcher.data.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        {!vendor ? (
          <>
            <s-paragraph>
              {name} can&apos;t sign in to the vendor portal yet. Setting up access lets you add the email addresses that may sign in.
              They will only ever see order lines where the product vendor is exactly &ldquo;{name}&rdquo;.
            </s-paragraph>
            <s-button variant="primary" onClick={() => submit({ intent: "enable" })} {...(busy || !name ? { disabled: true } : {})}>Set up portal access</s-button>
          </>
        ) : (
          <>
            <s-paragraph>
              Status: <b>{vendor.status === "active" ? "Active" : "Paused"}</b>.{" "}
              {vendor.status === "active"
                ? "Invited people create their password at /portal/signup with the same email and get in straight away."
                : "Nobody from this vendor can sign in."}
            </s-paragraph>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={cell}>Email</th>
                  <th style={cell}>Name</th>
                  <th style={cell}>Status</th>
                  <th style={cell}>Last sign-in</th>
                  <th style={cell} />
                </tr>
              </thead>
              <tbody>
                {vendor.users.length === 0 && (
                  <tr><td style={cell} colSpan={5}>No one added yet.</td></tr>
                )}
                {vendor.users.map((u) => (
                  <tr key={u.id}>
                    <td style={cell}>{u.email}</td>
                    <td style={cell}>{u.name ?? ""}{u.phone ? <><br /><small>{u.phone}</small></> : null}</td>
                    <td style={cell}>{USER_STATUS[u.status] ?? u.status}</td>
                    <td style={cell}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never"}</td>
                    <td style={cell}>
                      <s-button variant="tertiary" tone="critical" onClick={() => submit({ intent: "remove_user", userId: u.id })} {...(busy ? { disabled: true } : {})}>Remove</s-button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="intent" value="add_user" />
              <input name="email" type="email" required placeholder="person@vendor.com" aria-label="Email" style={{ padding: 6, minWidth: 240 }} />
              <input name="person" placeholder="Name (optional)" aria-label="Name" style={{ padding: 6 }} />
              <s-button type="submit" {...(busy ? { loading: true } : {})}>Add email</s-button>
            </fetcher.Form>
            <div style={{ marginTop: 16 }}>
              {vendor.status === "active" ? (
                <s-button tone="critical" onClick={() => submit({ intent: "pause" })} {...(busy ? { disabled: true } : {})}>Pause vendor (sign everyone out)</s-button>
              ) : (
                <s-button onClick={() => submit({ intent: "activate" })} {...(busy ? { disabled: true } : {})}>Reactivate vendor</s-button>
              )}
            </div>
          </>
        )}
      </s-section>

      {profile && (
        <s-section heading="Brand details">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {([
                ["Phone", profile.phone], ["GST", profile.gstNumber], ["City / state", [profile.city, profile.state].filter(Boolean).join(", ")],
                ["Minimum order (from vendor)", profile.minimumOrderValue ? inr(profile.minimumOrderValue) : null],
                ["Sells", profile.productNote], ["Description", profile.description], ["Policy", profile.policy],
              ] as [string, string | null][]).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ ...cell, color: "#666", width: 200 }}>{k}</td>
                  <td style={{ ...cell, whiteSpace: "pre-wrap" }}>{v || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <s-paragraph>
            Filled in from the vendor&apos;s sign-up. The minimum order value here is not yet used by the cart; the cart still uses the
            &ldquo;Marketplace seller&rdquo; entries in Shopify.
          </s-paragraph>
        </s-section>
      )}

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
