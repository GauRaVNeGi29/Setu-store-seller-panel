import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import styles from "../../styles/portal.css?url";
import { BridgeArch, IconCheck } from "./icons";

/** Fonts and stylesheet for every portal page: Setu Store's storefront faces. */
export const portalLinks = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" as const },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,300..600&family=Red+Hat+Display:wght@400..700&display=swap",
  },
  { rel: "stylesheet", href: styles },
  { rel: "icon", type: "image/png", href: "/setu-favicon-logo.png" },
];

export const Wordmark = ({ sub, to = "/portal" }: { sub?: string; to?: string }) => (
  <Link className="vp-wordmark" to={to}>
    <b>Setu Store</b>
    <span>{sub ?? "Vendor portal"}</span>
  </Link>
);

/** Split screen for sign in, sign up and password pages: Setu Store green on the left, the form on the right. */
export function AuthLayout({ title, lead, wide, children }: { title: string; lead?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className="vp-auth">
      <aside className="vp-auth-side">
        <BridgeArch className="vp-auth-arch" />
        <Wordmark to="/portal/login" />
        <div>
          <p className="vp-auth-quote">Your Setu Store orders, in one place.</p>
          <ul className="vp-auth-points">
            <li><IconCheck />See every order that includes your products, as it arrives.</li>
            <li><IconCheck />Get a pick list of what to pack, oldest order first.</li>
            <li><IconCheck />Follow what you&apos;ve sold after discounts and refunds.</li>
          </ul>
        </div>
        <p className="vp-auth-foot">For brands selling wholesale on Setu Store.</p>
      </aside>
      <main className="vp-auth-main">
        <div className={`vp-auth-form${wide ? " vp-auth-form--wide" : ""}`}>
          <h1 className="vp-h1">{title}</h1>
          {lead && <p className="vp-lead">{lead}</p>}
          {children}
        </div>
      </main>
    </div>
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

/** Labelled input with hint and error wired to aria-describedby. Passwords get a Show/Hide button. */
export function Field({ name, label, type = "text", error, hint, required, autoComplete, defaultValue, multiline, inputMode, maxLength }: FieldProps) {
  const [show, setShow] = useState(false);
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id: name, name, required, defaultValue, maxLength,
    className: "vp-input",
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  const isPassword = type === "password";
  return (
    <div className="vp-field">
      <label htmlFor={name}>
        {label}
        {!required && <span className="vp-optional"> (optional)</span>}
      </label>
      {multiline ? (
        <textarea rows={3} {...common} />
      ) : isPassword ? (
        <div className="vp-pw">
          <input type={show ? "text" : "password"} autoComplete={autoComplete} {...common} />
          <button type="button" onClick={() => setShow((s) => !s)} aria-controls={name} aria-pressed={show}>
            {show ? "Hide" : "Show"}
          </button>
        </div>
      ) : (
        <input type={type} autoComplete={autoComplete} inputMode={inputMode} {...common} />
      )}
      {hint && <p id={`${name}-hint`} className="vp-hint">{hint}</p>}
      {error && <p id={`${name}-error`} className="vp-field-error">{error}</p>}
    </div>
  );
}

/**
 * Two whole numbers of days, "from" and "to" (e.g. 10 to 15). One group label,
 * with the hint and error read out for both inputs.
 */
export function DayRangeField({ name, label, min, max, error, hint, required }: {
  name: string; label: string; min: string; max: string; error?: string; hint?: string; required?: boolean;
}) {
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  const input = (suffix: "Min" | "Max", value: string, what: string) => (
    <input id={`${name}${suffix}`} name={`${name}${suffix}`} className="vp-input" type="number" inputMode="numeric" min={suffix === "Min" ? 0 : 1} max={365} step={1}
      required={required} defaultValue={value} aria-label={`${label}: ${what}`} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
  );
  return (
    <fieldset className="vp-field vp-range">
      <legend>
        {label}
        {!required && <span className="vp-optional"> (optional)</span>}
      </legend>
      <div className="vp-range-row">
        {input("Min", min, "from, in days")}
        <span aria-hidden="true">to</span>
        {input("Max", max, "to, in days")}
        <span aria-hidden="true">days</span>
      </div>
      {hint && <p id={`${name}-hint`} className="vp-hint">{hint}</p>}
      {error && <p id={`${name}-error`} className="vp-field-error">{error}</p>}
    </fieldset>
  );
}

export function DevEmailPreview({ preview }: { preview?: { subject: string; link?: string } }) {
  if (!preview) return null;
  return (
    <div className="vp-msg vp-msg--dev" role="status">
      Development only: no email service is set up, so here is the email that would have been sent (&ldquo;{preview.subject}&rdquo;).
      {preview.link && (
        <>
          {" "}
          <a href={preview.link}>Open the link from the email</a>
        </>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  to_ship: "To ship", partly_shipped: "Partly shipped", shipped: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
  unfulfilled: "To ship", partial: "Partly shipped", fulfilled: "Shipped",
};
export const Status = ({ value }: { value: string }) => (
  <span className={`vp-status vp-status--${value}`}>{STATUS_LABEL[value] ?? value}</span>
);

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type PortalFile = { id: string; fileName: string; mimeType: string; size: number } | null;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Link to one of the vendor's own files (opens in a new tab). */
export function FileLink({ file, label }: { file: NonNullable<PortalFile>; label?: string }) {
  return (
    <a className="vp-filelink" href={`/portal/files/${file.id}`} target="_blank" rel="noreferrer">
      <span className="vp-filename">{label ?? file.fileName}</span>
      <span className="vp-small"> · {file.mimeType === "application/pdf" ? "PDF" : file.mimeType.replace("image/", "").toUpperCase()} · {kb(file.size)}</span>
    </a>
  );
}

/** File picker with the current file, the rules and any error. `removable` adds a "Remove" tick box. */
export function FileField({ name, label, current, accept, hint, error, removable, image }: {
  name: string; label: string; current: PortalFile; accept: string; hint: string; error?: string; removable?: boolean; image?: boolean;
}) {
  const describedBy = [error ? `${name}-error` : null, `${name}-hint`].filter(Boolean).join(" ");
  return (
    <div className="vp-field vp-filefield">
      <label htmlFor={name}>{label}<span className="vp-optional"> (optional)</span></label>
      {current && (
        <div className="vp-filecurrent">
          {image && <img src={`/portal/files/${current.id}`} alt="" className={`vp-thumb vp-thumb--${name}`} />}
          <span>Current: <FileLink file={current} /></span>
          {removable && (
            <label className="vp-remove" htmlFor={`remove_${name}`}>
              <input type="checkbox" id={`remove_${name}`} name={`remove_${name}`} value="1" /> Remove
            </label>
          )}
        </div>
      )}
      <input
        id={name} name={name} type="file" accept={accept} className="vp-input vp-file"
        aria-invalid={error ? true : undefined} aria-describedby={describedBy}
      />
      <p id={`${name}-hint`} className="vp-hint">{current ? "Choose a file only if you want to replace it. " : ""}{hint}</p>
      {error && <p id={`${name}-error`} className="vp-field-error">{error}</p>}
    </div>
  );
}
