import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import db from "../db.server";
import { clientIp, getIdentity, readSessionToken, sessionCookie, signIn } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { AuthCard, Field } from "../lib/portal/ui";
import styles from "../styles/portal.css?url";

/** /portal/login – email + password. One generic error for every failure. */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Sign in · Setu vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await getIdentity(db, portalShop(), readSessionToken(request));
  if (me) throw redirect(me.user.status === "active" ? "/portal" : "/portal/pending");
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const email = String(form.get("email") ?? "").slice(0, 254);
  const password = String(form.get("password") ?? "").slice(0, 300);
  const r = await signIn(db, email, password, { shop, ip: clientIp(request), userAgent: request.headers.get("user-agent") });
  if (!r.ok) {
    return {
      email,
      error: r.reason === "locked"
        ? "Too many tries. Please wait 15 minutes, or reset your password."
        : "That email and password don't match an account.",
    };
  }
  return redirect(r.status === "active" ? "/portal" : "/portal/pending", { headers: { "Set-Cookie": sessionCookie(r.token, r.expiresAt) } });
};

export default function Login() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  const notice = params.get("reset") === "1" ? "Your password has been changed. Sign in with the new one." : null;

  return (
    <AuthCard title="Sign in">
      {notice && <p className="vp-info" role="status">{notice}</p>}
      {data?.error && <p className="vp-error" role="alert">{data.error}</p>}
      <Form method="post">
        <Field name="email" label="Email" type="email" autoComplete="email" inputMode="email" required defaultValue={data?.email} />
        <Field name="password" label="Password" type="password" autoComplete="current-password" required />
        <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </Form>
      <p className="vp-note" style={{ marginTop: 14 }}>
        <Link to="/portal/forgot">Forgot password?</Link>
      </p>
      <p className="vp-note">
        New to Setu Store, or invited by the Setu team? <Link to="/portal/signup">Create your account</Link>
      </p>
    </AuthCard>
  );
}
