import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import db from "../db.server";
import { clientIp, getIdentity, readSessionToken, sessionCookie, signIn } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { AuthLayout, Field, portalLinks } from "../lib/portal/ui";

/** /portal/login – email + password. One generic error for every failure. */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Sign in · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

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
        ? "Too many tries. Wait 15 minutes, or reset your password."
        : "That email and password don't match an account.",
    };
  }
  return redirect(r.status === "active" ? "/portal" : "/portal/pending", { headers: { "Set-Cookie": sessionCookie(r.token, r.expiresAt) } });
};

export default function Login() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  const changed = params.get("reset") === "1";
  const welcome = params.get("welcome") === "1";

  return (
    <AuthLayout title="Sign in" lead="Welcome back. Sign in to see your orders and what to ship.">
      {welcome && <p className="vp-msg vp-msg--ok" role="status">Your password is set. Sign in to get started.</p>}
      {changed && <p className="vp-msg vp-msg--ok" role="status">Your password has been changed. Sign in with the new one.</p>}
      {data?.error && <p className="vp-msg vp-msg--error" role="alert">{data.error}</p>}
      <Form method="post">
        <Field name="email" label="Email" type="email" autoComplete="email" inputMode="email" required defaultValue={data?.email} />
        <Field name="password" label="Password" type="password" autoComplete="current-password" required />
        <div className="vp-linkrow"><Link to="/portal/forgot">Forgot password?</Link></div>
        <button className="vp-btn vp-btn--block" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </Form>
      <p className="vp-auth-alt">
        New to Setu Store, or invited by the Setu Store team? <Link to="/portal/signup">Create your account</Link>
      </p>
    </AuthLayout>
  );
}
