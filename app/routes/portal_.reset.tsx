import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { clearSessionCookie, clientIp, resetLinkInfo, resetPassword } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { MIN_PASSWORD } from "../lib/portal/rules";
import { AuthLayout, Field, portalLinks } from "../lib/portal/ui";

/** /portal/reset?token=… – choose a new password. Ends every session of that person. */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Choose a new password · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const info = await resetLinkInfo(db, portalShop(), token);
  return { token, valid: info.valid, invite: info.valid && info.invite, email: info.valid ? info.email : null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "").slice(0, 300);
  if (password !== String(form.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  const r = await resetPassword(db, token, password, { shop, ip: clientIp(request) });
  if (!r.ok) return { error: r.error };
  return redirect(`/portal/login?${form.get("invite") === "1" ? "welcome" : "reset"}=1`, { headers: { "Set-Cookie": clearSessionCookie() } });
};

export default function Reset() {
  const { token, valid, invite, email } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  if (!valid) {
    return (
      <AuthLayout title="This link has expired" lead="Links work once. Reset links expire after 30 minutes, invite links after 7 days. Ask for a new one with the email you were invited with.">
        <Link className="vp-btn vp-btn--block" to="/portal/forgot">Send a new link</Link>
        <p className="vp-auth-alt"><Link to="/portal/login">Back to sign in</Link></p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={invite ? "Welcome – choose your password" : "Choose a new password"}
      lead={invite
        ? <>You&apos;ll sign in as <b>{email}</b>. Once your password is set, sign in to see your team&apos;s orders.</>
        : "You'll be signed out on every device, then you can sign in with the new password."}
    >
      {data?.error && <p className="vp-msg vp-msg--error" role="alert">{data.error}</p>}
      <Form method="post">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="invite" value={invite ? "1" : "0"} />
        <Field name="password" label="New password" type="password" autoComplete="new-password" required hint={`At least ${MIN_PASSWORD} characters, with letters as well as numbers.`} />
        <Field name="confirm" label="Confirm new password" type="password" autoComplete="new-password" required />
        <button className="vp-btn vp-btn--block" type="submit" disabled={busy}>{busy ? "Saving…" : invite ? "Set password" : "Save new password"}</button>
      </Form>
    </AuthLayout>
  );
}
