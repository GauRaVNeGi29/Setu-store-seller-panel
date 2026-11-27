import type { ActionFunctionArgs, LinksFunction, MetaFunction } from "react-router";
import { Form, Link, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { clientIp, requestPasswordReset } from "../lib/portal/auth.server";
import { portalBaseUrl, portalShop } from "../lib/portal/context.server";
import { sendPasswordReset } from "../lib/portal/email.server";
import { AuthLayout, DevEmailPreview, Field, portalLinks } from "../lib/portal/ui";

/** /portal/forgot – emails a reset link. Same answer whether or not the email has an account. */

export const links: LinksFunction = portalLinks;
export const meta: MetaFunction = () => [{ title: "Reset password · Setu Store vendor portal" }, { name: "robots", content: "noindex" }];

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = portalShop();
  const form = await request.formData();
  const email = String(form.get("email") ?? "").slice(0, 254);
  const r = await requestPasswordReset(db, email, { shop, ip: clientIp(request) });
  let devPreview: { subject: string; link?: string } | undefined;
  if (r.status === "sent") {
    const link = `${portalBaseUrl(request)}/portal/reset?token=${encodeURIComponent(r.token)}`;
    try {
      devPreview = (await sendPasswordReset(db, { shop, to: r.email, name: r.name }, link)).devPreview;
    } catch (e) {
      console.error("[vendor-portal] could not send reset email", e);
      return { sent: false, error: "The email couldn't be sent just now. Try again in a few minutes." };
    }
  }
  return { sent: true, email, devPreview };
};

export default function Forgot() {
  const data = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  if (data?.sent) {
    return (
      <AuthLayout
        title="Check your email"
        lead={<>If <b>{data.email}</b> has an account, a link to choose a new password is on its way. It works once and expires in 30 minutes.</>}
      >
        <DevEmailPreview preview={data.devPreview} />
        <p className="vp-small">No email after a few minutes? Check your spam folder, or <Link to="/portal/forgot">ask for another link</Link>.</p>
        <p className="vp-auth-alt"><Link to="/portal/login">Back to sign in</Link></p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Forgot your password?" lead="Enter the email you sign in with and we'll send you a link to choose a new one.">
      {data?.error && <p className="vp-msg vp-msg--error" role="alert">{data.error}</p>}
      <Form method="post">
        <Field name="email" label="Email" type="email" autoComplete="email" inputMode="email" required />
        <button className="vp-btn vp-btn--block" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      </Form>
      <p className="vp-auth-alt"><Link to="/portal/login">Back to sign in</Link></p>
    </AuthLayout>
  );
}
