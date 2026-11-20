import type { ReactNode } from "react";

/** Small shared pieces for the public portal pages (sign in, sign up, reset). */

export function AuthCard({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <main className="vp-login">
      <div className="vp-card">
        <div className="vp-brand">
          Setu Store
          <small>Vendor portal</small>
        </div>
        <h1 style={{ marginTop: 18 }}>{title}</h1>
        {sub && <p className="vp-sub">{sub}</p>}
        {children}
      </div>
    </main>
  );
}

type FieldProps = {
  name: string;
  label: string;
  type?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string;
  multiline?: boolean;
  inputMode?: "text" | "email" | "tel" | "numeric" | "decimal";
  maxLength?: number;
};

export function Field({ name, label, type = "text", error, hint, required, autoComplete, defaultValue, multiline, inputMode, maxLength }: FieldProps) {
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id: name, name, required, defaultValue, maxLength,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  return (
    <div className="vp-field">
      <label htmlFor={name}>
        {label}
        {!required && <span className="vp-optional"> (optional)</span>}
      </label>
      {multiline ? <textarea rows={3} {...common} /> : <input type={type} autoComplete={autoComplete} inputMode={inputMode} {...common} />}
      {hint && <p id={`${name}-hint`} className="vp-note">{hint}</p>}
      {error && <p id={`${name}-error`} className="vp-field-error">{error}</p>}
    </div>
  );
}

export function DevEmailPreview({ preview }: { preview?: { subject: string; link?: string } }) {
  if (!preview) return null;
  return (
    <div className="vp-dev" role="status">
      <b>Development only</b> – no email service is set up. This email would have been sent: &ldquo;{preview.subject}&rdquo;
      {preview.link && (
        <>
          <br />
          <a href={preview.link}>Open the link from the email</a>
        </>
      )}
    </div>
  );
}
