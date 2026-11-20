import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { clearSessionCookie, clientIp, resetPassword, resetTokenValid } from "../lib/portal/auth.server";
import { MIN_PASSWORD } from "../lib/portal/rules";
import { portalShop } from "../lib/portal/context.server";
import { AuthCard, Field } from "../lib/portal/ui";
import styles from "../styles/portal.css?url";

/** /portal/reset?token=… – choose a new password. Ends every session of that person. */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Choose a new password · Setu vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return { token, valid: await resetTokenValid(db, portalShop(), token) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "").slice(0, 300);
  if (password !== String(form.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  const r = await resetPassword(db, token, password, { shop, ip: clientIp(request) });
  if (!r.ok) return { error: r.error };
  return redirect("/portal/login?reset=1", { headers: { "Set-Cookie": clearSessionCookie() } });
};

export default function Reset() {
  const { token, valid } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  if (!valid) {
    return (
      <AuthCard title="This link has expired" sub="Reset links work once and expire after 30 minutes.">
        <p><Link className="vp-btn" to="/portal/forgot">Ask for a new link</Link></p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" sub="You'll be signed out everywhere and can sign in with the new password.">
      {data?.error && <p className="vp-error" role="alert">{data.error}</p>}
      <Form method="post">
        <input type="hidden" name="token" value={token} />
        <Field name="password" label="New password" type="password" autoComplete="new-password" required hint={`At least ${MIN_PASSWORD} characters.`} />
        <Field name="confirm" label="Confirm new password" type="password" autoComplete="new-password" required />
        <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </Form>
    </AuthCard>
  );
}
