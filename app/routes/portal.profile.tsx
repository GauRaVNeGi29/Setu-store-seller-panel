import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { getVendorProfile } from "../lib/vendors/vendors.server";
import { canEdit, changeRequestState, requestBusinessChange, updateBrand, withdrawBusinessChange } from "../lib/vendors/team.server";
import { BUSINESS_FIELDS, FIELD_LABEL, type BusinessField } from "../lib/vendors/fields";
import { inr } from "../lib/portal/format";
import { Field } from "../lib/portal/ui";

/**
 * My brand.
 *  - Brand details: saved at once (owners and "view and edit" staff).
 *  - Business details: sent to the Setu Store team; the current ones stay until approved.
 *  - Sign-in: email fixed; password through "Forgot password".
 * Editing opens with ?edit=brand or ?edit=business, so it works without JavaScript.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const [profile, change] = await Promise.all([getVendorProfile(db, me.shop, me.vendor.id), changeRequestState(db, me.shop, me.vendor.id)]);
  if (!profile) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const editable = canEdit(me);
  const edit = editable ? url.searchParams.get("edit") : null;
  return {
    profile, change, editable,
    edit: edit === "brand" || edit === "business" ? edit : null,
    saved: url.searchParams.get("saved"),
    me: { name: me.user.name, email: me.user.email, role: me.user.role, access: me.user.access },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const me = await requireVendor(request);
  const form = Object.fromEntries(await request.formData());
  const intent = String(form.intent ?? "");
  if (intent === "brand") {
    const r = await updateBrand(db, me, form);
    if (r.ok) throw redirect("/portal/profile?saved=brand");
    return { ...r, intent, values: form };
  }
  if (intent === "business") {
    const r = await requestBusinessChange(db, me, form);
    if (r.ok) throw redirect("/portal/profile?saved=business");
    return { ...r, intent, values: form };
  }
  if (intent === "withdraw") {
    const r = await withdrawBusinessChange(db, me);
    if (r.ok) throw redirect("/portal/profile?saved=withdrawn");
    return { ...r, intent };
  }
  return { ok: false as const, error: "Unknown action", intent };
};

export const meta: MetaFunction = () => [{ title: "My brand · Setu Store vendor portal" }];

const SAVED: Record<string, string> = {
  brand: "Brand details saved.",
  business: "Sent to the Setu Store team. Your current details stay in place until they approve the change.",
  withdrawn: "Change request withdrawn. Your details are as before.",
};

function Rows({ rows }: { rows: [string, string | null][] }) {
  return (
    <dl className="vp-dl">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ? v : <span className="vp-none">Not added yet</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

const show = (v: string | null) => (v ? v : "–");
const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default function Profile() {
  const { profile: p, change, editable, edit, saved, me } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const err = (data && !data.ok && "errors" in data ? data.errors : undefined) ?? {};
  const back = (data && "values" in data ? data.values : undefined) as Record<string, string> | undefined;
  const editing = (edit ?? (data && !data.ok ? data.intent : null)) as string | null;
  const pending = change.pending;
  // When a request is waiting, editing starts from the requested values.
  const proposed = (f: BusinessField) => back?.[f] ?? (pending?.changes[f] ? pending.changes[f]!.to ?? "" : (p[f] as string | null) ?? "");

  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">{p.displayName}</h1>
          <p className="vp-lead">
            {editable
              ? "Keep your brand details up to date. Business details are checked by the Setu Store team before they change."
              : "You have view-only access. Ask your account owner if you need to change anything."}
          </p>
        </div>
      </div>

      {saved && SAVED[saved] && <p className="vp-msg vp-msg--ok" role="status">{SAVED[saved]}</p>}
      {data && !data.ok && !("errors" in data && data.errors) && <p className="vp-msg vp-msg--error" role="alert">{data.error}</p>}

      {/* ---------------- Brand ---------------- */}
      <section className="vp-panel" aria-labelledby="b1">
        <div className="vp-panel-head">
          <div>
            <h2 className="vp-h2" id="b1">Your brand on Setu Store</h2>
            <p className="vp-small vp-panel-note">Changes show straight away.</p>
          </div>
          {editable && editing !== "brand" && <Link className="vp-btn vp-btn--quiet" to="?edit=brand">Edit</Link>}
        </div>
        {editing === "brand" ? (
          <Form method="post" className="vp-panel-body vp-form">
            <input type="hidden" name="intent" value="brand" />
            <Field name="description" label="Brand description" multiline defaultValue={back?.description ?? p.description ?? ""} error={err.description}
              hint="A few sentences retailers will read on your brand page." />
            <Field name="productNote" label="What you sell" multiline defaultValue={back?.productNote ?? p.productNote ?? ""} error={err.productNote}
              hint="A line or two, e.g. hand-poured soy candles and wax sachets." />
            <Field name="policy" label="Short policy" multiline defaultValue={back?.policy ?? p.policy ?? ""} error={err.policy}
              hint="For example dispatch time, returns and damaged goods." />
            <Field name="minimumOrderValue" label="Minimum order value (₹)" inputMode="decimal" defaultValue={back?.minimumOrderValue ?? p.minimumOrderValue ?? ""}
              error={err.minimumOrderValue} hint="The smallest order a retailer can place with you. Leave empty for no minimum." />
            <div className="vp-form-actions">
              <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Save brand details"}</button>
              <Link className="vp-btn vp-btn--quiet" to="/portal/profile">Cancel</Link>
            </div>
          </Form>
        ) : (
          <Rows rows={[
            ["Brand description", p.description],
            ["What you sell", p.productNote],
            ["Short policy", p.policy],
            ["Minimum order value", p.minimumOrderValue ? inr(p.minimumOrderValue) : null],
          ]} />
        )}
      </section>

      {/* ---------------- Business ---------------- */}
      <section className="vp-panel" aria-labelledby="b2">
        <div className="vp-panel-head">
          <div>
            <h2 className="vp-h2" id="b2">Business details</h2>
            <p className="vp-small vp-panel-note">Changes need approval from the Setu Store team.</p>
          </div>
          {editable && editing !== "business" && (
            <Link className="vp-btn vp-btn--quiet" to="?edit=business">{pending ? "Edit request" : "Request a change"}</Link>
          )}
        </div>

        {pending && editing !== "business" && (
          <div className="vp-change" role="status">
            <p className="vp-change-title">
              <span className="vp-badge vp-badge--pending">Waiting for approval</span>
              Sent {when(pending.createdAt)}{pending.by ? ` by ${pending.by}` : ""}
            </p>
            <table className="vp-change-table">
              <thead><tr><th>Detail</th><th>Now</th><th>Requested</th></tr></thead>
              <tbody>
                {BUSINESS_FIELDS.filter((f) => pending.changes[f]).map((f) => (
                  <tr key={f}>
                    <th scope="row">{FIELD_LABEL[f]}</th>
                    <td>{show(pending.changes[f]!.from)}</td>
                    <td><b>{show(pending.changes[f]!.to)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {editable && (
              <Form method="post">
                <input type="hidden" name="intent" value="withdraw" />
                <button className="vp-btn vp-btn--text" type="submit" disabled={busy}>Withdraw request</button>
              </Form>
            )}
          </div>
        )}
        {!pending && change.last?.status === "rejected" && editing !== "business" && (
          <div className="vp-change vp-change--declined" role="status">
            <p className="vp-change-title">
              <span className="vp-badge vp-badge--declined">Not approved</span>
              Your change from {when(change.last.createdAt)} wasn&apos;t approved{change.last.note ? ":" : "."}
            </p>
            {change.last.note && <p className="vp-change-note">{change.last.note}</p>}
          </div>
        )}

        {editing === "business" ? (
          <Form method="post" className="vp-panel-body vp-form">
            <input type="hidden" name="intent" value="business" />
            <p className="vp-small" style={{ marginTop: 0 }}>
              Your current details stay in place until the Setu Store team approves. {pending ? "Sending this replaces your earlier request." : ""}
            </p>
            <Field name="displayName" label="Business name" required autoComplete="organization" defaultValue={proposed("displayName")} error={err.displayName} />
            <Field name="gstNumber" label="GST number (GSTIN)" maxLength={15} defaultValue={proposed("gstNumber")} error={err.gstNumber} hint="15 characters, e.g. 08ABCDE1234F1Z5." />
            <Field name="phone" label="Business phone" type="tel" inputMode="tel" autoComplete="tel" defaultValue={proposed("phone")} error={err.phone} />
            <div className="vp-row">
              <Field name="city" label="City" required autoComplete="address-level2" defaultValue={proposed("city")} error={err.city} />
              <Field name="state" label="State" required autoComplete="address-level1" defaultValue={proposed("state")} error={err.state} />
            </div>
            <div className="vp-form-actions">
              <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Send for approval"}</button>
              <Link className="vp-btn vp-btn--quiet" to="/portal/profile">Cancel</Link>
            </div>
          </Form>
        ) : (
          <Rows rows={[
            ["Business name", p.displayName],
            ["GST number", p.gstNumber],
            ["Business phone", p.phone],
            ["City and state", [p.city, p.state].filter(Boolean).join(", ") || null],
          ]} />
        )}
      </section>

      {/* ---------------- Sign-in ---------------- */}
      <section className="vp-panel" aria-labelledby="b3">
        <div className="vp-panel-head">
          <div>
            <h2 className="vp-h2" id="b3">Your sign-in</h2>
            <p className="vp-small vp-panel-note">Your email can&apos;t be changed.</p>
          </div>
        </div>
        <Rows rows={[
          ["Name", me.name],
          ["Email", me.email],
          ["Role", me.role === "owner" ? "Owner – full access" : me.access === "edit" ? "Staff – view and edit" : "Staff – view only"],
        ]} />
        <div className="vp-panel-foot">
          <span className="vp-small">To change your password, we&apos;ll email you a link.</span>
          <Link className="vp-btn vp-btn--quiet" to="/portal/forgot">Change password</Link>
        </div>
      </section>
    </>
  );
}
