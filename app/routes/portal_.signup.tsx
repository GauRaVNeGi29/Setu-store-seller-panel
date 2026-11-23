import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, getIdentity, readSessionToken, sessionCookie, signUp, type SignupInput } from "../lib/portal/auth.server";
import { portalShop } from "../lib/portal/context.server";
import { MIN_PASSWORD } from "../lib/portal/rules";
import { AuthLayout, Field, portalLinks } from "../lib/portal/ui";

/**
 * /portal/signup – create an account with the seller's own details only.
 * Business and brand details are filled in later, on My brand.
 * Invited email (added by the Setu Store team) → straight into the portal.
 * Any other email → "under review" until the team approves it.
 */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Create your account · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await getIdentity(db, portalShop(), readSessionToken(request));
  if (me) throw redirect(me.user.status === "active" ? "/portal" : "/portal/pending");
  return null;
};

const FIELDS: (keyof SignupInput)[] = ["name", "email", "phone", "password"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const input = Object.fromEntries(FIELDS.map((k) => [k, String(form.get(k) ?? "").slice(0, 400)])) as SignupInput;
  const r = await signUp(db, input, { shop, ip: clientIp(request), userAgent: request.headers.get("user-agent") });
  if (!r.ok) return { values: { ...input, password: "" }, errors: r.errors };
  return redirect(r.status === "active" ? "/portal" : "/portal/pending", { headers: { "Set-Cookie": sessionCookie(r.token, r.expiresAt) } });
};

export default function Signup() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const e = data?.errors ?? {};
  const v = (data?.values ?? {}) as Partial<SignupInput>;
  const formError = e.form ?? (Object.keys(e).length ? "Please check the highlighted fields." : null);

  return (
    <AuthLayout
      title="Create your account"
      lead="Start with your own details. You'll add your business and brand once you're in."
    >
      {formError && <p className="vp-msg vp-msg--error" role="alert">{formError}</p>}
      <Form method="post" noValidate>
        <Field name="name" label="Name" required autoComplete="name" defaultValue={v.name} error={e.name} />
        <Field name="email" label="Email" type="email" required autoComplete="email" inputMode="email" defaultValue={v.email} error={e.email} />
        <Field name="phone" label="Phone" type="tel" required autoComplete="tel" inputMode="tel" defaultValue={v.phone} error={e.phone}
          hint="Add the country code if you're outside India, e.g. +91 98765 43210." />
        <Field name="password" label="Password" type="password" required autoComplete="new-password" error={e.password}
          hint={`At least ${MIN_PASSWORD} characters, with letters as well as numbers.`} />
        <button className="vp-btn vp-btn--block" type="submit" disabled={busy}>{busy ? "Creating your account…" : "Create account"}</button>
      </Form>
      <p className="vp-small vp-signup-note">
        If the Setu Store team invited your email, you&apos;ll go straight to your orders. Otherwise the team will review your account first.
      </p>
      <p className="vp-auth-alt">Already have an account? <Link to="/portal/login">Sign in</Link></p>
    </AuthLayout>
  );
}
