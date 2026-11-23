import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { approveSignup, listSignups, rejectSignup } from "../lib/vendors/vendors.server";

/**
 * Sign-ups waiting for review. Approving links the person to a Shopify vendor
 * name; from then on they see that vendor's orders. Until then they see nothing.
 */

const VENDORS_QUERY = `#graphql
  query SetuVendorNames { productVendors(first: 250) { nodes } }`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [pending, rejected, vendorsRes] = await Promise.all([
    listSignups(db, session.shop, "pending"),
    listSignups(db, session.shop, "rejected"),
    admin.graphql(VENDORS_QUERY).then((r) => r.json()).catch(() => null),
  ]);
  const shopifyVendors: string[] = vendorsRes?.data?.productVendors?.nodes ?? [];
  return { pending, rejected: rejected.slice(-20).reverse(), shopifyVendors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const userId = String(form.get("userId") ?? "");
  if (form.get("intent") === "approve") {
    const r = await approveSignup(db, session.shop, userId, String(form.get("vendorName") ?? ""), actor);
    return r.ok ? { ok: true, message: "Approved – they can now see their orders" } : r;
  }
  if (form.get("intent") === "reject") {
    const r = await rejectSignup(db, session.shop, userId, actor);
    return r.ok ? { ok: true, message: "Sign-up declined" } : r;
  }
  return { ok: false, error: "Unknown action" };
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

type Signup = Awaited<ReturnType<typeof loader>>["pending"][number];

function SignupCard({ s, vendors }: { s: Signup; vendors: string[] }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const a = s.application;
  useEffect(() => {
    const r = fetcher.data;
    if (r && "message" in r && r.message) shopify.toast.show(r.message);
  }, [fetcher.data, shopify]);
  const guess = vendors.find((v) => v.toLowerCase() === (a.brandName ?? "").trim().toLowerCase()) ?? "";
  const [vendorName, setVendorName] = useState(guess);
  const listId = `vendors-${s.id}`;

  // Sign-up now asks only for the person's details. Older sign-ups also carried brand details; show them if present.
  const rows: [string, string | null | undefined][] = [
    ["Name", s.name],
    ["Email", s.email],
    ["Phone", s.phone],
    ...(a.brandName ? ([["Brand (from sign-up)", a.brandName], ["City / state", [a.city, a.state].filter(Boolean).join(", ")]] as [string, string][]) : []),
  ];

  return (
    <s-section heading={s.name || s.email}>
      <s-paragraph>Signed up {when(s.createdAt)}</s-paragraph>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: "4px 8px 4px 0", color: "#666", width: 130, verticalAlign: "top" }}>{k}</td>
              <td style={{ padding: "4px 0", whiteSpace: "pre-wrap" }}>{v || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fetcher.data && "error" in fetcher.data && fetcher.data.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <label htmlFor={`v-${s.id}`} style={{ fontSize: 13 }}>Sells on Setu Store as</label>
        <input
          id={`v-${s.id}`} list={listId} value={vendorName} onChange={(e) => setVendorName(e.target.value)}
          placeholder="Shopify vendor name" style={{ padding: 6, minWidth: 240 }}
        />
        <datalist id={listId}>{vendors.map((v) => <option key={v} value={v} />)}</datalist>
        <s-button variant="primary" {...(busy || !vendorName.trim() ? { disabled: true } : {})}
          onClick={() => fetcher.submit({ intent: "approve", userId: s.id, vendorName }, { method: "POST" })}>Approve</s-button>
        <s-button tone="critical" variant="tertiary" {...(busy ? { disabled: true } : {})}
          onClick={() => fetcher.submit({ intent: "reject", userId: s.id }, { method: "POST" })}>Decline</s-button>
      </div>
      <s-paragraph>
        They will see orders for products whose Shopify vendor is exactly this name.
        {vendorName && !vendors.includes(vendorName.trim()) && " No products use this vendor name yet."}
      </s-paragraph>
    </s-section>
  );
}

export default function Signups() {
  const { pending, rejected, shopifyVendors } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Sign-ups">
      {pending.length === 0 ? (
        <s-section><s-paragraph>No sign-ups waiting for review.</s-paragraph></s-section>
      ) : (
        pending.map((s) => <SignupCard key={s.id} s={s} vendors={shopifyVendors} />)
      )}
      {rejected.length > 0 && (
        <s-section heading="Recently declined">
          {rejected.map((s) => (
            <s-paragraph key={s.id}>{s.name ?? "–"} · {s.email} · declined {s.reviewedAt ? when(s.reviewedAt) : ""}</s-paragraph>
          ))}
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
