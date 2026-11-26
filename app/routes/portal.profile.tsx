import type { ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import {
  canEdit, canManagePeople, changeRequestState, requestBusinessChange, updateBrand, updateSellerDetails, vendorDetails, withdrawBusinessChange,
} from "../lib/vendors/team.server";
import { MAX_REQUEST_BYTES } from "../lib/files/files.server";
import { updateStoreListing } from "../lib/storefront/update.server";
import { FILE_RULES } from "../lib/files/rules";
import { BUSINESS_FIELDS, BUSINESS_FILES, FIELD_LABEL, SHORT_DESCRIPTION_MAX, fileInputName, type BusinessField } from "../lib/vendors/fields";
import { inr } from "../lib/portal/format";
import { BrandValuesField, DayRangeField, Field, FileField, FileLink, type PortalFile } from "../lib/portal/ui";
import { daysText, rangeOf } from "../lib/vendors/shipping";
import { BRAND_VALUES_MAX } from "../lib/vendors/values";

/**
 * My brand, in three parts:
 *  - Seller details: the signed-in person's own name and phone (saved at once); email fixed; password by email link.
 *  - Business details: company name, address, GST / IEC / AD code documents. Sent to the Setu Store team;
 *    the current details stay until they approve.
 *  - Brand details: short description, brand values, description, minimum order value, processing time, logo, banner. Saved at once.
 * Business and brand need an owner or "view and edit" staff. Editing opens with ?edit=…, so it works without JavaScript.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const [details, change, person] = await Promise.all([
    vendorDetails(db, me.shop, me.vendor.id),
    changeRequestState(db, me.shop, me.vendor.id),
    db.vendorUser.findUnique({ where: { id: me.user.id }, select: { name: true, email: true, phone: true } }),
  ]);
  if (!details || !person) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const editable = canEdit(me);
  const want = url.searchParams.get("edit");
  const edit = (want === "seller" && !me.teamViewer) || (editable && (want === "business" || want === "brand")) ? want : null;
  return {
    details, change, editable, edit, saved: url.searchParams.get("saved"), teamView: !!me.teamViewer, manageTeam: canManagePeople(me),
    me: { ...person, role: me.user.role, access: me.user.access },
  };
};

type ActionResult = { ok: false; intent: string; error: string; errors?: Record<string, string>; values?: Record<string, string> };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const me = await requireVendor(request);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
    return { ok: false, intent: "", error: `Those files are too large together – keep the total under ${MAX_REQUEST_BYTES / 1024 / 1024} MB.` };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // Only text goes back to the page (a file can't be put back into a file picker).
  const values = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const run = {
    seller: () => updateSellerDetails(db, me, form),
    brand: () => updateBrand(db, me, form),
    business: () => requestBusinessChange(db, me, form),
    withdraw: () => withdrawBusinessChange(db, me),
  }[intent];
  if (!run) return { ok: false, intent, error: "Unknown action" };
  const r = await run();
  // Brand details are public: copy them to the store listing. A failure here is recorded for the team; the save stands.
  if (r.ok && intent === "brand") await updateStoreListing(db, me.shop, me.vendor.id);
  if (r.ok) throw redirect(`/portal/profile?saved=${intent === "withdraw" ? "withdrawn" : intent}`);
  return { ok: false, intent, error: r.error, errors: r.errors, values };
};

export const meta: MetaFunction = () => [{ title: "My brand · Setu Store vendor portal" }];

const SAVED: Record<string, string> = {
  seller: "Your details are saved.",
  brand: "Brand details saved.",
  business: "Sent to the Setu Store team. Your current details stay in place until they approve the change.",
  withdrawn: "Change request withdrawn. Your details are as before.",
};

type Row = [string, ReactNode, boolean?];
function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="vp-dl">
      {rows.map(([k, v, required]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v || <span className={required ? "vp-none vp-none--required" : "vp-none"}>{required ? "Required – not added yet" : "Not added yet"}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const address = (d: { addressLine: string | null; city: string | null; state: string | null; postalCode: string | null }) =>
  d.addressLine || d.city ? [d.addressLine, [d.city, d.state].filter(Boolean).join(", "), d.postalCode].filter(Boolean).join("\n") : null;

function SectionHead({ id, title, note, action }: { id: string; title: string; note: string; action?: ReactNode }) {
  return (
    <div className="vp-panel-head">
      <div>
        <h2 className="vp-h2" id={id}>{title}</h2>
        <p className="vp-small vp-panel-note">{note}</p>
      </div>
      {action}
    </div>
  );
}

const DOCS = [
  { field: "gstFileId", kind: "gst", current: "gstFile" },
  { field: "iecFileId", kind: "iec", current: "iecFile" },
  { field: "adCodeFileId", kind: "ad_code", current: "adCodeFile" },
] as const;

export default function Profile() {
  const { details: d, change, editable, edit, saved, me, teamView, manageTeam } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const failed = data && !data.ok ? data : null;
  const editing = edit ?? (failed?.intent || null);
  const err = failed?.errors ?? {};
  const back = failed?.values;
  const pending = change.pending;
  const files = change.files as Record<string, NonNullable<PortalFile>>;
  const val = (k: string, fallback: string | null | undefined) => back?.[k] ?? fallback ?? "";
  // When a business request is waiting, editing starts from the requested values.
  const requested = (f: BusinessField, now: string | null) => val(f, pending?.changes[f] ? pending.changes[f]!.to : now);
  const busyFor = (intent: string) => busy && nav.formData?.get("intent") === intent;
  const processing = rangeOf(d.processingDaysMin, d.processingDaysMax);
  const isFile = (f: BusinessField) => (BUSINESS_FILES as readonly string[]).includes(f);
  const cell = (f: BusinessField, v: string | null) =>
    isFile(f) ? (v && files[v] ? <FileLink file={files[v]} /> : "–") : v || "–";

  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">{d.displayName}</h1>
          <p className="vp-lead">
            {teamView
              ? "The vendor's seller, business and brand details, as they see them."
              : editable
              ? "Your seller, business and brand details. Business details are checked by the Setu Store team before they change."
              : "You have view-only access to the business and brand details. Ask your account owner if something needs changing."}
          </p>
        </div>
        {manageTeam && <Link className="vp-btn vp-btn--quiet vp-teamlink" to="/portal/team">Manage your team</Link>}
      </div>

      {saved && SAVED[saved] && <p className="vp-msg vp-msg--ok" role="status">{SAVED[saved]}</p>}
      {failed && !failed.errors && <p className="vp-msg vp-msg--error" role="alert">{failed.error}</p>}
      {d.missing.length > 0 && (
        <p className="vp-msg vp-msg--todo" role="status">
          To complete your profile, add your {d.missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.
          {pending && " (Details waiting for approval count once they're approved.)"}
        </p>
      )}

      {/* ---------------- 1. Seller details ---------------- */}
      <section className="vp-panel" aria-labelledby="s1">
        <SectionHead id="s1" title="Seller details" note="Your own details. Everyone on your team has their own."
          action={editing !== "seller" && !teamView && <Link className="vp-btn vp-btn--quiet" to="?edit=seller">Edit</Link>} />
        {editing === "seller" ? (
          <Form method="post" className="vp-panel-body vp-form">
            <input type="hidden" name="intent" value="seller" />
            <Field name="name" label="Name" required autoComplete="name" defaultValue={val("name", me.name)} error={err.name} />
            <div className="vp-field">
              <span className="vp-label">Email</span>
              <p className="vp-readonly">{me.email}<span className="vp-small"> · can&apos;t be changed</span></p>
            </div>
            <Field name="phone" label="Phone" type="tel" required inputMode="tel" autoComplete="tel" defaultValue={val("phone", me.phone)} error={err.phone}
              hint="Add the country code if you're outside India, e.g. +91 98765 43210." />
            <div className="vp-form-actions">
              <button className="vp-btn" type="submit" disabled={busy}>{busyFor("seller") ? "Saving…" : "Save"}</button>
              <Link className="vp-btn vp-btn--quiet" to="/portal/profile">Cancel</Link>
            </div>
          </Form>
        ) : (
          <Rows rows={[
            ["Name", me.name, true],
            ["Email", me.email],
            ["Phone", me.phone, true],
            ["Password", <span key="pw" className="vp-pwrow">••••••••••{!teamView && <Link to="/portal/forgot">Change password</Link>}</span>],
            ["Role", me.role === "owner" ? "Owner – full access" : me.access === "edit" ? "Staff – view and edit" : "Staff – view only"],
          ]} />
        )}
      </section>

      {/* ---------------- 2. Business details ---------------- */}
      <section className="vp-panel" aria-labelledby="s2">
        <SectionHead id="s2" title="Business details" note="Changes need approval from the Setu Store team."
          action={editable && editing !== "business" && (
            <Link className="vp-btn vp-btn--quiet" to="?edit=business">{pending ? "Edit request" : d.companyName ? "Request a change" : "Add details"}</Link>
          )} />

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
                    <td>{cell(f, pending.changes[f]!.from)}</td>
                    <td><b>{cell(f, pending.changes[f]!.to)}</b></td>
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
          <Form method="post" encType="multipart/form-data" className="vp-panel-body vp-form">
            <input type="hidden" name="intent" value="business" />
            <p className="vp-small" style={{ marginTop: 0 }}>
              Your current details stay in place until the Setu Store team approves.
              {pending ? " Sending this replaces your earlier request; files you sent with it are kept unless you choose new ones." : ""}
            </p>
            <Field name="companyName" label="Company name" required autoComplete="organization" defaultValue={requested("companyName", d.companyName)}
              error={err.companyName} hint="Your registered company name, as on your GST certificate." />
            <fieldset className="vp-group">
              <legend>Address</legend>
              <Field name="addressLine" label="Street address" required autoComplete="street-address" defaultValue={requested("addressLine", d.addressLine)} error={err.addressLine} />
              <div className="vp-row3">
                <Field name="city" label="City" required autoComplete="address-level2" defaultValue={requested("city", d.city)} error={err.city} />
                <Field name="state" label="State" required autoComplete="address-level1" defaultValue={requested("state", d.state)} error={err.state} />
                <Field name="postalCode" label="PIN code" required inputMode="numeric" autoComplete="postal-code" maxLength={6}
                  defaultValue={requested("postalCode", d.postalCode)} error={err.postalCode} />
              </div>
            </fieldset>
            {DOCS.map(({ field, kind, current }) => {
              const rule = FILE_RULES[kind];
              const waiting = pending?.changes[field]?.to;
              return (
                <FileField key={field} name={fileInputName(field)} label={rule.label} accept={rule.accept} hint={rule.hint}
                  current={(waiting && files[waiting]) || d[current]} error={err[fileInputName(field)]} />
              );
            })}
            <div className="vp-form-actions">
              <button className="vp-btn" type="submit" disabled={busy}>{busyFor("business") ? "Sending…" : "Send for approval"}</button>
              <Link className="vp-btn vp-btn--quiet" to="/portal/profile">Cancel</Link>
            </div>
          </Form>
        ) : (
          <Rows rows={[
            ["Company name", d.companyName, true],
            ["Address", address(d), true],
            ["GST certificate", d.gstFile && <FileLink file={d.gstFile} />],
            ["IEC certificate", d.iecFile && <FileLink file={d.iecFile} />],
            ["AD code letter", d.adCodeFile && <FileLink file={d.adCodeFile} />],
          ]} />
        )}
      </section>

      {/* ---------------- 3. Brand details ---------------- */}
      <section className="vp-panel" aria-labelledby="s3">
        <SectionHead id="s3" title="Brand details" note="How retailers see your brand on Setu Store. Changes show straight away."
          action={editable && editing !== "brand" && <Link className="vp-btn vp-btn--quiet" to="?edit=brand">Edit</Link>} />
        {editing === "brand" ? (
          <Form method="post" encType="multipart/form-data" className="vp-panel-body vp-form">
            <input type="hidden" name="intent" value="brand" />
            <Field name="shortDescription" label="Short description" maxLength={SHORT_DESCRIPTION_MAX} defaultValue={val("shortDescription", d.shortDescription)}
              error={err.shortDescription} hint={`One line about your brand, shown beside your name on your product pages. Up to ${SHORT_DESCRIPTION_MAX} characters.`} />
            <BrandValuesField name="brandValues" label="Brand values" value={val("brandValues", d.brandValues.join(", "))} error={err.brandValues}
              hint={`Up to ${BRAND_VALUES_MAX} short tags that say what your brand stands for, shown under your name on your seller page. Tap to choose, or type your own, separated by commas.`} />
            <Field name="description" label="Description" multiline defaultValue={val("description", d.description)} error={err.description}
              hint="A few sentences: what you make, how, and what makes it yours. Shown under Brand details on your product pages." />
            <Field name="minimumOrderValue" label="Minimum order value (₹)" required inputMode="decimal" defaultValue={val("minimumOrderValue", d.minimumOrderValue)}
              error={err.minimumOrderValue} hint="The smallest order a retailer can place with you, in rupees. Shown as “Min” beside your name and applied in the cart." />
            <DayRangeField name="processingDays" label="Processing time" required
              min={val("processingDaysMin", d.processingDaysMin?.toString())} max={val("processingDaysMax", d.processingDaysMax?.toString())}
              error={err.processingDays} hint="How many days you need to make or ready an order before it ships, as a range, e.g. 10 to 15. Your seller page uses it, with the delivery time, to show buyers the dates their order will arrive." />
            <FileField name="logoFile" label="Brand logo" current={d.logoFile} accept={FILE_RULES.logo.accept} hint={FILE_RULES.logo.hint}
              error={err.logoFile} removable image />
            <FileField name="bannerFile" label="Brand banner" current={d.bannerFile} accept={FILE_RULES.banner.accept} hint={FILE_RULES.banner.hint}
              error={err.bannerFile} removable image />
            <div className="vp-form-actions">
              <button className="vp-btn" type="submit" disabled={busy}>{busyFor("brand") ? "Saving…" : "Save brand details"}</button>
              <Link className="vp-btn vp-btn--quiet" to="/portal/profile">Cancel</Link>
            </div>
          </Form>
        ) : (
          <>
            {(d.bannerFile || d.logoFile) && (
              <div className="vp-brandpreview">
                {d.bannerFile
                  ? <img className="vp-brandpreview-banner" src={`/portal/files/${d.bannerFile.id}`} alt={`${d.displayName} banner`} />
                  : <div className="vp-brandpreview-banner vp-brandpreview-banner--empty" />}
                {d.logoFile && <img className="vp-brandpreview-logo" src={`/portal/files/${d.logoFile.id}`} alt={`${d.displayName} logo`} />}
              </div>
            )}
            <Rows rows={[
              ["Short description", d.shortDescription],
              ["Brand values", d.brandValues.length > 0 && <ul className="vp-taglist">{d.brandValues.map((v) => <li key={v}>{v}</li>)}</ul>],
              ["Description", d.description],
              ["Minimum order value", d.minimumOrderValue ? inr(d.minimumOrderValue) : null, true],
              ["Processing time", processing ? daysText(processing) : null, true],
              ["Brand logo", d.logoFile && <FileLink file={d.logoFile} />],
              ["Brand banner", d.bannerFile && <FileLink file={d.bannerFile} />],
            ]} />
          </>
        )}
      </section>
    </>
  );
}
