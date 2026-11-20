import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, getIdentity, readSessionToken, sessionCookie, signUp, type SignupInput } from "../lib/portal/auth.server";
import { MIN_PASSWORD } from "../lib/portal/rules";
import { portalShop } from "../lib/portal/context.server";
import { AuthCard, Field } from "../lib/portal/ui";
import styles from "../styles/portal.css?url";

/**
 * /portal/signup – create an account.
 * Invited email (added by the Setu team) → straight into the portal.
 * Any other email → "under review" until the team approves it.
 */

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];
export const meta: MetaFunction = () => [{ title: "Create your account · Setu vendor portal" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await getIdentity(db, portalShop(), readSessionToken(request));
  if (me) throw redirect(me.user.status === "active" ? "/portal" : "/portal/pending");
  return null;
};

const FIELDS: (keyof SignupInput)[] = ["name", "email", "password", "phone", "brandName", "gstNumber", "city", "state", "productNote", "description", "policy", "minimumOrderValue"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const input = Object.fromEntries(FIELDS.map((k) => [k, String(form.get(k) ?? "").slice(0, 4000)])) as SignupInput;
  if (input.password !== String(form.get("confirm") ?? "")) {
    return { values: { ...input, password: "" }, errors: { confirm: "The two passwords don't match." } as Record<string, string> };
  }
  const r = await signUp(db, input, { shop, ip: clientIp(request), userAgent: request.headers.get("user-agent") });
  if (!r.ok) return { values: { ...input, password: "" }, errors: r.errors };
  return redirect(r.status === "active" ? "/portal" : "/portal/pending", { headers: { "Set-Cookie": sessionCookie(r.token, r.expiresAt) } });
};

export default function Signup() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const e = data?.errors ?? {};
  const v = (data?.values ?? {}) as Partial<SignupInput>;

  return (
    <AuthCard
      title="Create your account"
      sub={<>If the Setu team invited your email, you&apos;ll go straight in. Otherwise the team will review your details first.</>}
    >
      {e.form && <p className="vp-error" role="alert">{e.form}</p>}
      {Object.keys(e).length > 0 && !e.form && <p className="vp-error" role="alert">Please check the highlighted fields.</p>}
      <Form method="post" noValidate>
        <fieldset className="vp-fieldset">
          <legend>About you</legend>
          <Field name="name" label="Your name" required autoComplete="name" defaultValue={v.name} error={e.name} />
          <Field name="email" label="Work email" type="email" required autoComplete="email" inputMode="email" defaultValue={v.email} error={e.email} />
          <Field name="phone" label="Phone" type="tel" required autoComplete="tel" inputMode="tel" defaultValue={v.phone} error={e.phone} hint="With country code if outside India, e.g. +91 98765 43210" />
          <Field name="password" label="Password" type="password" required autoComplete="new-password" error={e.password} hint={`At least ${MIN_PASSWORD} characters.`} />
          <Field name="confirm" label="Confirm password" type="password" required autoComplete="new-password" error={e.confirm} />
        </fieldset>

        <fieldset className="vp-fieldset">
          <legend>Your business</legend>
          <Field name="brandName" label="Business / brand name" required autoComplete="organization" defaultValue={v.brandName} error={e.brandName} />
          <Field name="gstNumber" label="GST number (GSTIN)" defaultValue={v.gstNumber} error={e.gstNumber} maxLength={15} hint="15 characters, e.g. 08ABCDE1234F1Z5" />
          <div className="vp-row">
            <Field name="city" label="City" required autoComplete="address-level2" defaultValue={v.city} error={e.city} />
            <Field name="state" label="State" required autoComplete="address-level1" defaultValue={v.state} error={e.state} />
          </div>
          <Field name="productNote" label="What do you sell?" multiline defaultValue={v.productNote} error={e.productNote} hint="A line or two, e.g. handmade soy candles and wax sachets." />
        </fieldset>

        <fieldset className="vp-fieldset">
          <legend>Your brand on Setu Store</legend>
          <Field name="description" label="Brand description" multiline defaultValue={v.description} error={e.description} hint="Shown to retailers on your brand page." />
          <Field name="policy" label="Short policy" multiline defaultValue={v.policy} error={e.policy} hint="E.g. dispatch time, returns, damages." />
          <Field name="minimumOrderValue" label="Minimum order value (₹)" inputMode="decimal" defaultValue={v.minimumOrderValue} error={e.minimumOrderValue} hint="The smallest order a retailer can place with you. Leave empty for no minimum." />
        </fieldset>

        <button className="vp-btn" type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
      </Form>
      <p className="vp-note" style={{ marginTop: 14 }}>
        Already have an account? <Link to="/portal/login">Sign in</Link>
      </p>
    </AuthCard>
  );
}
