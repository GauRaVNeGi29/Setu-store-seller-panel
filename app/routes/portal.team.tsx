import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, createInviteLink } from "../lib/portal/auth.server";
import { portalBaseUrl, requireVendor } from "../lib/portal/context.server";
import { sendStaffInvite } from "../lib/portal/email.server";
import { addStaff, canManagePeople, listPeople, ownerRemoveStaff, ownerUpdateStaff } from "../lib/vendors/team.server";
import { DevEmailPreview, Field } from "../lib/portal/ui";

/**
 * Team – owners only. Add staff (they get a set-password link), choose
 * view-only or view-and-edit, deactivate, reactivate or remove them.
 * Staff who open this address are sent back to their orders.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  if (!canManagePeople(me)) throw redirect("/portal");
  const people = await listPeople(db, me.shop, me.vendor.id);
  return { people, meId: me.user.id, brand: me.vendor.displayName };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const me = await requireVendor(request);
  if (!canManagePeople(me)) throw redirect("/portal");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const userId = String(form.get("userId") ?? "");

  if (intent === "add") {
    const r = await addStaff(db, me, { email: String(form.get("email") ?? ""), name: String(form.get("name") ?? ""), access: String(form.get("access") ?? "view") });
    if (!r.ok) return { ...r, intent, values: Object.fromEntries(form) as Record<string, string> };
    const token = await createInviteLink(db, r.userId, { shop: me.shop, ip: clientIp(request) });
    const link = `${portalBaseUrl(request)}/portal/reset?token=${encodeURIComponent(token)}`;
    try {
      const sent = await sendStaffInvite(r.email, r.name, me.vendor.displayName, me.user.name || me.user.email, link);
      return { ok: true as const, intent, message: `Invite sent to ${r.email}.`, devPreview: sent.devPreview };
    } catch (e) {
      console.error("[vendor-portal] could not send invite", e);
      return { ok: true as const, intent, message: `${r.email} was added, but the invite email couldn't be sent. They can use “Forgot password” on the sign-in page to set a password.` };
    }
  }
  if (intent === "access") {
    const r = await ownerUpdateStaff(db, me, userId, { access: String(form.get("access") ?? "") });
    return r.ok ? { ok: true as const, intent, message: "Access updated." } : { ...r, intent };
  }
  if (intent === "deactivate" || intent === "reactivate") {
    const r = await ownerUpdateStaff(db, me, userId, { status: intent === "deactivate" ? "disabled" : "active" });
    return r.ok ? { ok: true as const, intent, message: intent === "deactivate" ? "Deactivated – they've been signed out." : "Reactivated." } : { ...r, intent };
  }
  if (intent === "remove") {
    const r = await ownerRemoveStaff(db, me, userId);
    return r.ok ? { ok: true as const, intent, message: "Removed from your team." } : { ...r, intent };
  }
  return { ok: false as const, error: "Unknown action", intent };
};

export const meta: MetaFunction = () => [{ title: "Team · Setu Store vendor portal" }];

const STATUS: Record<string, [string, string]> = {
  active: ["Active", "active"], invited: ["Invited", "invited"], disabled: ["Deactivated", "off"],
  pending: ["Requires approval", "pending"], rejected: ["Declined", "off"],
};
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "Never";

export default function Team() {
  const { people, meId, brand } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const addErr = data && !data.ok && data.intent === "add" ? ("errors" in data && data.errors) || {} : {};
  const back = data && "values" in data ? data.values : undefined;

  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">Team</h1>
          <p className="vp-lead">People who can sign in for {brand}. Staff never manage other people; only owners can.</p>
        </div>
      </div>

      {data?.ok && <p className="vp-msg vp-msg--ok" role="status">{data.message}</p>}
      {data?.ok && "devPreview" in data && <DevEmailPreview preview={data.devPreview} />}
      {data && !data.ok && data.intent !== "add" && <p className="vp-msg vp-msg--error" role="alert">{data.error}</p>}

      <section className="vp-panel" aria-labelledby="t1">
        <div className="vp-panel-head"><h2 className="vp-h2" id="t1">People</h2></div>
        <ul className="vp-people">
          {people.map((u) => {
            const [label, tone] = STATUS[u.status] ?? [u.status, "off"];
            const self = u.id === meId;
            return (
              <li key={u.id} className="vp-person">
                <div className="vp-person-who">
                  <b>{u.name || u.email}{self && <span className="vp-you"> (you)</span>}</b>
                  {u.name && <span className="vp-small">{u.email}</span>}
                  <span className="vp-person-meta">
                    <span className={`vp-badge vp-badge--${tone}`}>{label}</span>
                    <span className="vp-small">Last signed in: {when(u.lastLoginAt)}</span>
                  </span>
                </div>

                {u.role === "owner" ? (
                  <div className="vp-person-role"><span className="vp-role">Owner</span><span className="vp-small">Full access</span></div>
                ) : (
                  <Form method="post" className="vp-person-role">
                    <input type="hidden" name="intent" value="access" />
                    <input type="hidden" name="userId" value={u.id} />
                    <label className="vp-small" htmlFor={`access-${u.id}`}>Staff access</label>
                    <span className="vp-inline">
                      <select id={`access-${u.id}`} name="access" defaultValue={u.access} className="vp-input vp-select">
                        <option value="view">View only</option>
                        <option value="edit">View and edit</option>
                      </select>
                      <button className="vp-btn vp-btn--quiet" type="submit" disabled={busy}>Save</button>
                    </span>
                  </Form>
                )}

                {u.role === "staff" && (
                  <div className="vp-person-actions">
                    {u.status === "disabled" ? (
                      <Form method="post"><input type="hidden" name="userId" value={u.id} />
                        <button className="vp-btn vp-btn--quiet" name="intent" value="reactivate" disabled={busy}>Reactivate</button>
                      </Form>
                    ) : u.status === "active" || u.status === "invited" ? (
                      <Form method="post"><input type="hidden" name="userId" value={u.id} />
                        <button className="vp-btn vp-btn--quiet" name="intent" value="deactivate" disabled={busy}>Deactivate</button>
                      </Form>
                    ) : null}
                    <Form method="post" onSubmit={(e) => { if (!confirm(`Remove ${u.email} from your team?`)) e.preventDefault(); }}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button className="vp-btn vp-btn--text vp-btn--danger" name="intent" value="remove" disabled={busy}>Remove</button>
                    </Form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="vp-panel" aria-labelledby="t2">
        <div className="vp-panel-head">
          <div>
            <h2 className="vp-h2" id="t2">Add a staff member</h2>
            <p className="vp-small vp-panel-note">We&apos;ll email them a link to set their password.</p>
          </div>
        </div>
        <Form method="post" className="vp-panel-body vp-form" key={data?.ok && data.intent === "add" ? "done" : "form"}>
          <input type="hidden" name="intent" value="add" />
          {data && !data.ok && data.intent === "add" && !addErr.email && <p className="vp-msg vp-msg--error" role="alert">{data.error}</p>}
          <div className="vp-row">
            <Field name="name" label="Name" autoComplete="off" defaultValue={back?.name} />
            <Field name="email" label="Email" type="email" inputMode="email" autoComplete="off" required defaultValue={back?.email} error={addErr.email} />
          </div>
          <fieldset className="vp-choice">
            <legend>Access</legend>
            <label htmlFor="access-view">
              <input id="access-view" type="radio" name="access" value="view" defaultChecked={(back?.access ?? "view") === "view"} />
              <span>View only<small>Sees orders, the pick list and brand details. Can&apos;t change anything.</small></span>
            </label>
            <label htmlFor="access-edit">
              <input id="access-edit" type="radio" name="access" value="edit" defaultChecked={back?.access === "edit"} />
              <span>View and edit<small>Can also edit brand details and send business changes for approval.</small></span>
            </label>
          </fieldset>
          <div className="vp-form-actions">
            <button className="vp-btn" type="submit" disabled={busy}>{busy && nav.formData?.get("intent") === "add" ? "Adding…" : "Add and send invite"}</button>
          </div>
        </Form>
      </section>
    </>
  );
}
