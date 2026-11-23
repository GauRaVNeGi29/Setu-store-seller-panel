import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { vendorLines } from "../lib/orders/admin.server";
import { addVendorUser, enableVendor, getVendorByName, removeVendorUser, setVendorStatus } from "../lib/vendors/vendors.server";
import {
  adminUpdateDetails, adminUpdateUser, changeRequestState, listPeople, reviewBusinessChange, vendorDetails,
} from "../lib/vendors/team.server";
import { BUSINESS_FIELDS, BUSINESS_FILES, FIELD_LABEL } from "../lib/vendors/fields";

/**
 * One vendor, team-only inside Shopify admin:
 *  - portal access (pause / reactivate the whole vendor)
 *  - business changes waiting for approval
 *  - people: status, role and staff access
 *  - brand and business details (the team edits directly, no approval step)
 *  - order lines
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const name = new URL(request.url).searchParams.get("name") ?? "";
  const [lines, vendor] = await Promise.all([vendorLines(db, session.shop, name), getVendorByName(db, session.shop, name)]);
  const [profile, people, change] = vendor
    ? await Promise.all([vendorDetails(db, session.shop, vendor.id), listPeople(db, session.shop, vendor.id), changeRequestState(db, session.shop, vendor.id)])
    : [null, [], null];
  return { name, lines, profile, people, change, vendor: vendor && { id: vendor.id, status: vendor.status } };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<{ ok: boolean; message?: string; error?: string }> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? "");
  const intent = f("intent");
  const name = f("name");

  if (intent === "enable") {
    if (!name) return { ok: false, error: "Vendor name missing" };
    await enableVendor(db, shop, name, actor);
    return { ok: true, message: "Portal access set up" };
  }
  const vendor = await getVendorByName(db, shop, name);
  if (!vendor) return { ok: false, error: "Set up portal access first" };
  type Out = { ok: boolean; message?: string; error?: string };
  const done = (r: { ok: boolean; error?: string }, message: string): Out => (r.ok ? { ok: true, message } : { ok: false, error: r.error });

  switch (intent) {
    case "add_user": {
      const role = f("role") === "staff" ? "staff" : "owner";
      const access = f("access") === "view" ? "view" : "edit";
      return done(await addVendorUser(db, shop, vendor.id, f("email"), f("person"), actor, { role, access }), "Person added – they create their password at /portal/signup");
    }
    case "update_user":
      return done(await adminUpdateUser(db, shop, f("userId"), { status: f("status"), role: f("role"), access: f("access") }, actor), "Saved");
    case "remove_user":
      return done(await removeVendorUser(db, shop, f("userId"), actor), "Person removed");
    case "pause":
    case "activate":
      return done(await setVendorStatus(db, shop, vendor.id, intent === "pause" ? "paused" : "active", actor), intent === "pause" ? "Vendor paused – everyone signed out" : "Vendor active");
    case "approve_change":
    case "reject_change":
      return done(
        await reviewBusinessChange(db, shop, f("requestId"), intent === "approve_change" ? "approve" : "reject", f("note") || null, actor),
        intent === "approve_change" ? "Change approved – details updated" : "Change declined",
      );
    case "details":
      return done(await adminUpdateDetails(db, shop, vendor.id, Object.fromEntries(form), actor), "Details saved");
  }
  return { ok: false, error: "Unknown action" };
};

const inr = (v: string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never");
const cell = { padding: 6, borderBottom: "1px solid #eee", verticalAlign: "top" } as const;
const input = { padding: 6, border: "1px solid #ccc", borderRadius: 6, font: "inherit" } as const;
const STATUS = {
  unfulfilled: "To ship", partial: "Partly shipped", fulfilled: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
} as Record<string, string>;

type AdminFile = { id: string; fileName: string; mimeType: string; size: number } | null;

/** Files are fetched with the admin session (App Bridge adds the token to fetch), then opened from memory. */
async function openFile(id: string) {
  const res = await fetch(`/app/files/${id}`);
  if (!res.ok) throw new Error(`Couldn't open the file (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function FileButton({ file }: { file: AdminFile }) {
  const [error, setError] = useState<string | null>(null);
  if (!file) return <span style={{ color: "#666" }}>Not uploaded</span>;
  return (
    <span>
      <s-button variant="tertiary" onClick={() => openFile(file.id).catch((e: Error) => setError(e.message))}>{file.fileName}</s-button>
      <small style={{ color: "#666" }}> {(file.size / 1024).toFixed(0)} KB</small>
      {error && <small style={{ color: "#a63a32" }}> {error}</small>}
    </span>
  );
}

function ImagePreview({ file, wide }: { file: AdminFile; wide?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    let url: string | null = null;
    fetch(`/app/files/${file.id}`).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (b) { url = URL.createObjectURL(b); setSrc(url); }
    }).catch(() => undefined);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file]);
  if (!file) return <span style={{ color: "#666" }}>Not uploaded</span>;
  return src
    ? <img src={src} alt="" style={{ display: "block", width: wide ? 320 : 72, height: wide ? 100 : 72, objectFit: wide ? "cover" : "contain", border: "1px solid #e1e3dc", borderRadius: 8, background: "#f3f4f0" }} />
    : <span style={{ color: "#666" }}>Loading…</span>;
}

type Person = { id: string; email: string; name: string | null; status: string; role: string; access: string; lastLoginAt: string | null };

function PersonRow({ p, name }: { p: Person; name: string }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  // "Invited" and "Declined" aren't choices, but must show as the current value.
  const statusOptions: [string, string][] = [
    ...(p.status === "invited" ? [["invited", "Invited – no password yet"] as [string, string]] : []),
    ...(p.status === "rejected" ? [["rejected", "Declined sign-up"] as [string, string]] : []),
    ["active", "Active"], ["disabled", "Deactivated"], ["pending", "Requires approval"],
  ];
  return (
    <tr>
      <td style={cell}>{p.name && <b>{p.name}<br /></b>}{p.email}<br /><small style={{ color: "#666" }}>Last sign-in: {when(p.lastLoginAt)}</small></td>
      <td style={cell} colSpan={3}>
        <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="intent" value="update_user" />
          <input type="hidden" name="userId" value={p.id} />
          <select name="status" defaultValue={p.status} aria-label={`Status for ${p.email}`} style={input}>
            {statusOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select name="role" defaultValue={p.role} aria-label={`Role for ${p.email}`} style={input}>
            <option value="owner">Owner – full access</option>
            <option value="staff">Staff</option>
          </select>
          <select name="access" defaultValue={p.access} aria-label={`Staff access for ${p.email}`} style={input}>
            <option value="view">Staff access: view only</option>
            <option value="edit">Staff access: view and edit</option>
          </select>
          <s-button type="submit" {...(busy ? { loading: true } : {})}>Save</s-button>
        </fetcher.Form>
        {fetcher.data && !fetcher.data.ok && <div style={{ color: "#a63a32", marginTop: 4 }}>{fetcher.data.error}</div>}
      </td>
      <td style={cell}>
        <fetcher.Form method="post" onSubmit={(e) => { if (!confirm(`Remove ${p.email}? They'll be signed out and lose access.`)) e.preventDefault(); }}>
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="intent" value="remove_user" />
          <input type="hidden" name="userId" value={p.id} />
          <s-button variant="tertiary" tone="critical" type="submit" {...(busy ? { disabled: true } : {})}>Remove</s-button>
        </fetcher.Form>
      </td>
    </tr>
  );
}

export default function Vendor() {
  const { name, lines, vendor, profile, people, change } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const r = fetcher.data;
    if (r && "message" in r && r.message) shopify.toast.show(r.message);
  }, [fetcher.data, shopify]);

  const submit = (fields: Record<string, string>) => fetcher.submit({ name, ...fields }, { method: "POST" });
  const pending = change?.pending;

  return (
    <s-page heading={profile?.displayName || name || "(no vendor)"}>
      <s-link slot="breadcrumb-actions" href="/app/vendors">All vendors</s-link>
      {fetcher.data && !fetcher.data.ok && fetcher.data.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}

      {!vendor ? (
        <s-section heading="Vendor portal access">
          <s-paragraph>
            {name} can&apos;t sign in to the vendor portal yet. Setting up access lets you add the people who may sign in.
            They will only ever see order lines where the product vendor is exactly &ldquo;{name}&rdquo;.
          </s-paragraph>
          <s-button variant="primary" onClick={() => submit({ intent: "enable" })} {...(busy || !name ? { disabled: true } : {})}>Set up portal access</s-button>
        </s-section>
      ) : (
        <>
          {pending && (
            <s-section heading="Business change waiting for approval">
              <s-paragraph>Requested {when(pending.createdAt)}{pending.by ? ` by ${pending.by}` : ""}. Nothing changes until you approve.</s-paragraph>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ textAlign: "left" }}><th style={cell}>Detail</th><th style={cell}>Now</th><th style={cell}>Requested</th></tr></thead>
                <tbody>
                  {BUSINESS_FIELDS.filter((k) => pending.changes[k]).map((k) => {
                    const isFile = (BUSINESS_FILES as readonly string[]).includes(k);
                    const show = (v: string | null) => (isFile ? (v ? <FileButton file={change!.files[v] ?? null} /> : "–") : v ?? "–");
                    return (
                      <tr key={k}>
                        <td style={cell}>{FIELD_LABEL[k]}</td>
                        <td style={cell}>{show(pending.changes[k]!.from)}</td>
                        <td style={cell}><b>{pending.changes[k]!.to === null ? "(removed)" : show(pending.changes[k]!.to)}</b></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
                <fetcher.Form method="post">
                  <input type="hidden" name="name" value={name} />
                  <input type="hidden" name="intent" value="approve_change" />
                  <input type="hidden" name="requestId" value={pending.id} />
                  <s-button type="submit" variant="primary" {...(busy ? { disabled: true } : {})}>Approve and update details</s-button>
                </fetcher.Form>
                <fetcher.Form method="post" style={{ display: "flex", gap: 8, flex: 1, minWidth: 300 }}>
                  <input type="hidden" name="name" value={name} />
                  <input type="hidden" name="intent" value="reject_change" />
                  <input type="hidden" name="requestId" value={pending.id} />
                  <input name="note" placeholder="Reason for declining, shown to the vendor (optional)" aria-label="Reason for declining" style={{ ...input, flex: 1 }} />
                  <s-button type="submit" tone="critical" {...(busy ? { disabled: true } : {})}>Decline</s-button>
                </fetcher.Form>
              </div>
            </s-section>
          )}

          <s-section heading="People">
            <s-paragraph>
              <b>Owners</b> can do everything, including adding staff. <b>Staff</b> see orders; with &ldquo;view and edit&rdquo; they can also edit brand details and send
              business changes. Anyone not Active is signed out at once.
            </s-paragraph>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={cell}>Person</th>
                  <th style={cell} colSpan={3}>Status · role · staff access</th>
                  <th style={cell} />
                </tr>
              </thead>
              <tbody>
                {people.length === 0 && <tr><td style={cell} colSpan={5}>No one added yet.</td></tr>}
                {people.map((p) => <PersonRow key={`${p.id}-${p.status}-${p.role}-${p.access}`} p={p} name={name} />)}
              </tbody>
            </table>
            <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="intent" value="add_user" />
              <input name="email" type="email" required placeholder="person@vendor.com" aria-label="Email" style={{ ...input, minWidth: 220 }} />
              <input name="person" placeholder="Name (optional)" aria-label="Name" style={input} />
              <select name="role" defaultValue="owner" aria-label="Role" style={input}>
                <option value="owner">Owner</option>
                <option value="staff">Staff</option>
              </select>
              <select name="access" defaultValue="edit" aria-label="Staff access" style={input}>
                <option value="view">View only (staff)</option>
                <option value="edit">View and edit (staff)</option>
              </select>
              <s-button type="submit" {...(busy ? { loading: true } : {})}>Add person</s-button>
            </fetcher.Form>
          </s-section>

          {profile && (
            <s-section heading="Details">
              {profile.missing.length > 0 && <s-banner tone="warning">Missing: {profile.missing.join(", ")}.</s-banner>}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
                <tbody>
                  {([
                    ["GST certificate", <FileButton key="g" file={profile.gstFile} />],
                    ["IEC certificate", <FileButton key="i" file={profile.iecFile} />],
                    ["AD code letter", <FileButton key="a" file={profile.adCodeFile} />],
                    ["Brand logo", <ImagePreview key="l" file={profile.logoFile} />],
                    ["Brand banner", <ImagePreview key="b" file={profile.bannerFile} wide />],
                  ] as [string, React.ReactNode][]).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ ...cell, color: "#666", width: 170 }}>{k}</td>
                      <td style={cell}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <s-paragraph>Documents, logo and banner come from the vendor. Text details you change here apply at once, without an approval step.</s-paragraph>
              <fetcher.Form method="post" key={JSON.stringify(profile)}>
                <input type="hidden" name="name" value={name} />
                <input type="hidden" name="intent" value="details" />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  {([
                    ["displayName", "Brand name (shown in the portal)", profile.displayName],
                    ["companyName", "Company name", profile.companyName],
                    ["addressLine", "Street address", profile.addressLine],
                    ["city", "City", profile.city],
                    ["state", "State", profile.state],
                    ["postalCode", "PIN code", profile.postalCode],
                    ["minimumOrderValue", "Minimum order value (₹)", profile.minimumOrderValue],
                    ["shortDescription", "Short description", profile.shortDescription],
                  ] as [string, string, string | null][]).map(([k, l, v]) => (
                    <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span>{l}</span>
                      <input name={k} defaultValue={v ?? ""} style={input} />
                    </label>
                  ))}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                  <span>Description</span>
                  <textarea name="description" defaultValue={profile.description ?? ""} rows={4} style={input} />
                </label>
                <div style={{ marginTop: 12 }}>
                  <s-button type="submit" {...(busy ? { loading: true } : {})}>Save details</s-button>
                </div>
              </fetcher.Form>
              <s-paragraph>
                Shopify vendor name: <b>{name}</b> (fixed – this decides which order lines they see). The minimum order value is not yet used by the cart.
              </s-paragraph>
            </s-section>
          )}

          <s-section heading="Portal access">
            <s-paragraph>
              Status: <b>{vendor.status === "active" ? "Active" : "Paused"}</b>.{" "}
              {vendor.status === "active" ? "Pausing signs everyone from this vendor out and stops new sign-ins." : "Nobody from this vendor can sign in."}
            </s-paragraph>
            {vendor.status === "active" ? (
              <s-button tone="critical" onClick={() => submit({ intent: "pause" })} {...(busy ? { disabled: true } : {})}>Pause vendor</s-button>
            ) : (
              <s-button onClick={() => submit({ intent: "activate" })} {...(busy ? { disabled: true } : {})}>Reactivate vendor</s-button>
            )}
          </s-section>
        </>
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
