import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { mailLog, mailNumbers, mailSetup, mailTemplates, saveTeamAddresses, sendLogMailAgain, sendTest, setTemplateEnabled } from "../lib/mail/admin.server";
import { LOG_KEPT_DAYS, LOG_STATUSES, TEAM_ADDRESSES_MAX } from "../lib/mail/rules";
import { cell, headRow, input, muted, plural, Stats, table, Tabs, when } from "../lib/admin/ui";

/**
 * Mail: every mail the app sends to sellers and to the team.
 *  - Mails: what each one says, when it goes out and to whom; switch one off
 *    or on, read it, send yourself a test.
 *  - Log: every mail that went out or didn't, and why; send one again.
 *  - Team addresses: who on the team gets the team's mails.
 */
type Template = Awaited<ReturnType<typeof mailTemplates>>[number];
type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const q = new URL(request.url).searchParams;
  const view = q.get("view") === "log" ? "log" as const : q.get("view") === "team" ? "team" as const : "mails" as const;
  const [numbers, templates, log] = await Promise.all([
    mailNumbers(db, session.shop),
    view === "mails" ? mailTemplates(db, session.shop) : Promise.resolve([] as Template[]),
    view === "log" ? mailLog(db, session.shop, { status: q.get("status") ?? "", template: q.get("mail") ?? "", to: q.get("to") ?? "", page: Number(q.get("page")) || 1 }) : Promise.resolve(null),
  ]);
  const names = view === "log" ? (await mailTemplates(db, session.shop)).map((t) => ({ key: t.key, name: t.name })) : [];
  return { view, numbers, templates, log, names, mode: mailSetup(), me: session.onlineAccessInfo?.associated_user?.email ?? "" };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult & { intent: string; key?: string }> => {
  const { session } = await authenticate.admin(request);
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? "");
  const intent = f("intent");
  const key = f("template");
  if (intent === "template_on" || intent === "template_off") return { intent, key, ...(await setTemplateEnabled(db, session.shop, key, intent === "template_on", actor)) };
  if (intent === "test") return { intent, key, ...(await sendTest(db, session.shop, key, f("to"))) };
  if (intent === "send_again") return { intent, key: f("id"), ...(await sendLogMailAgain(db, session.shop, f("id"))) };
  if (intent === "team_addresses") return { intent, ...(await saveTeamAddresses(db, session.shop, f("addresses"), actor)) };
  return { intent, ok: false, error: "Unknown action" };
};

const STATUS_TEXT: Record<string, { label: string; tone?: "success" | "critical" | "warning" | "info" }> = {
  queued: { label: "Waiting", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  delivered: { label: "Delivered", tone: "success" },
  bounced: { label: "Bounced", tone: "critical" },
  failed: { label: "Failed", tone: "critical" },
  logged: { label: "Not sent", tone: "warning" },
};

export default function Mail() {
  const { view, numbers, templates, log, names, mode, me } = useLoaderData<typeof loader>();
  const noTeam = numbers.team.length === 0;
  return (
    <s-page heading="Mail">
      <s-banner tone={mode.real ? "info" : "warning"}>{mode.text}</s-banner>
      {noTeam && view !== "team" && (
        <s-banner tone="warning">
          No team address is set, so the team&apos;s mails go to nobody. <s-link href="/app/mail?view=team">Add an address</s-link>
        </s-banner>
      )}
      <Tabs label="Mail" current={view} tabs={[
        { id: "mails", label: "Mails", to: "/app/mail" },
        { id: "log", label: "Log", to: "/app/mail?view=log" },
        { id: "team", label: "Team addresses", to: "/app/mail?view=team", count: numbers.team.length },
      ]} />
      <s-section>
        <Stats items={[
          { label: "Sent", value: String(numbers.sent), note: "Last 7 days" },
          { label: "Waiting", value: String(numbers.waiting), note: "Going out within a minute, or being retried" },
          { label: "Failed", value: String(numbers.failed), note: "Last 7 days", to: numbers.failed ? "/app/mail?view=log&status=failed" : undefined, linkLabel: "See them" },
          { label: "Bounced", value: String(numbers.bounced), note: "The address refused it", to: numbers.bounced ? "/app/mail?view=log&status=bounced" : undefined, linkLabel: "See them" },
          { label: "Not sent", value: String(numbers.logged), note: "Kept in the log only", to: numbers.logged ? "/app/mail?view=log&status=logged" : undefined, linkLabel: "See them" },
        ]} />
      </s-section>
      {view === "mails" && <Mails templates={templates} testTo={numbers.team[0] ?? me} replyTo={mode.replyTo} />}
      {view === "log" && log && <Log log={log} names={names} />}
      {view === "team" && <Team addresses={numbers.team} />}
    </s-page>
  );
}

function Mails({ templates, testTo, replyTo }: { templates: Template[]; testTo: string; replyTo: string | null }) {
  const groups = (audience: "seller" | "admin") => {
    const out = new Map<string, Template[]>();
    for (const t of templates.filter((x) => x.audience === audience)) out.set(t.group, [...(out.get(t.group) ?? []), t]);
    return [...out];
  };
  const off = templates.filter((t) => !t.enabled).length;
  return (
    <>
      <s-section heading="Mails to sellers">
        <s-paragraph>
          {templates.filter((t) => t.audience === "seller").length} mails. {replyTo ? `A seller who replies to one reaches ${replyTo}.` : "No reply address is set yet."}
          {off > 0 && <> {plural(off, "mail")} in total {off === 1 ? "is" : "are"} switched off.</>}
        </s-paragraph>
        {groups("seller").map(([group, list]) => <Group key={group} name={group} list={list} testTo={testTo} />)}
      </s-section>
      <s-section heading="Mails to the team">
        <s-paragraph>These go to the addresses under <s-link href="/app/mail?view=team">Team addresses</s-link>. An alert about something that broke is sent at most once a day.</s-paragraph>
        {groups("admin").map(([group, list]) => <Group key={group} name={group} list={list} testTo={testTo} />)}
      </s-section>
    </>
  );
}

function Group({ name, list, testTo }: { name: string; list: Template[]; testTo: string }) {
  return (
    <div style={{ margin: "14px 0 22px" }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>{name}</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={{ ...cell, width: "34%" }}>Mail</th>
              <th style={{ ...cell, width: "24%" }}>Goes to</th>
              <th style={cell}>Status</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>{list.map((t) => <TemplateRow key={t.key} t={t} testTo={testTo} />)}</tbody>
        </table>
      </div>
    </div>
  );
}

function TemplateRow({ t, testTo }: { t: Template; testTo: string }) {
  const fetcher = useFetcher<typeof action>();
  const busy = (intent: string) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const result = fetcher.data && fetcher.data.key === t.key ? fetcher.data : null;
  return (
    <>
      <tr>
        <td style={{ ...cell, borderBottom: 0 }}>
          <b style={{ fontWeight: 600 }}>{t.name}</b>
          <div style={muted}>{t.when}</div>
        </td>
        <td style={{ ...cell, borderBottom: 0 }}>{t.to}</td>
        <td style={{ ...cell, borderBottom: 0 }}>
          {t.required ? <s-badge>Always on</s-badge> : t.enabled ? <s-badge tone="success">On</s-badge> : <s-badge tone="warning">Off</s-badge>}
        </td>
        <td style={{ ...cell, borderBottom: 0, textAlign: "right", whiteSpace: "nowrap" }}>
          {!t.required && (
            <fetcher.Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value={t.enabled ? "template_off" : "template_on"} />
              <input type="hidden" name="template" value={t.key} />
              <s-button type="submit" variant="tertiary" {...(busy("template_on") || busy("template_off") ? { loading: true } : {})}>{t.enabled ? "Switch off" : "Switch on"}</s-button>
            </fetcher.Form>
          )}
        </td>
      </tr>
      <tr>
        <td style={{ ...cell, paddingTop: 0 }} colSpan={4}>
          {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
          {result && result.ok && result.intent === "test" && <s-banner tone="success">{result.message}</s-banner>}
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "#005bd3" }}>Read it, or send a test</summary>
            <div style={{ margin: "8px 0 4px", padding: 14, border: "1px solid #e3e3e3", borderRadius: 8, background: "#fafafa", maxWidth: 640 }}>
              <div style={{ fontSize: 12, ...muted }}>Subject</div>
              <div style={{ fontWeight: 600, margin: "0 0 10px" }}>{t.preview.subject}</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>{t.preview.text}</div>
              <p style={{ margin: "10px 0 0", fontSize: 12, ...muted }}>
                This is an example with made-up names.{t.secret ? " The real mail carries a one-time link, which is never kept in the log." : ""}
              </p>
            </div>
            <fetcher.Form method="post" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", margin: "10px 0 6px" }}>
              <input type="hidden" name="intent" value="test" />
              <input type="hidden" name="template" value={t.key} />
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                Send this example to
                <input name="to" type="email" required defaultValue={testTo} style={{ ...input, minWidth: 260 }} />
              </label>
              <s-button type="submit" {...(busy("test") ? { loading: true } : {})}>Send test</s-button>
            </fetcher.Form>
          </details>
        </td>
      </tr>
    </>
  );
}

function Log({ log, names }: { log: NonNullable<Awaited<ReturnType<typeof mailLog>>>; names: { key: string; name: string }[] }) {
  const f = log.filter;
  const filtered = !!(f.status || f.template || f.to);
  const link = (page: number) => {
    const q = new URLSearchParams({ view: "log" });
    if (f.status) q.set("status", f.status);
    if (f.template) q.set("mail", f.template);
    if (f.to) q.set("to", f.to);
    if (page > 1) q.set("page", String(page));
    return `/app/mail?${q}`;
  };
  return (
    <s-section heading="Log">
      <Form method="get" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", margin: "0 0 14px" }}>
        <input type="hidden" name="view" value="log" />
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Status
          <select name="status" defaultValue={f.status} style={input}>
            <option value="">Any</option>
            {LOG_STATUSES.map((s) => <option key={s} value={s}>{STATUS_TEXT[s].label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Mail
          <select name="mail" defaultValue={f.template} style={{ ...input, maxWidth: 240 }}>
            <option value="">Any</option>
            {names.map((n) => <option key={n.key} value={n.key}>{n.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Sent to
          <input name="to" type="search" defaultValue={f.to} placeholder="Part of an address" style={{ ...input, minWidth: 200 }} />
        </label>
        <s-button type="submit">Show</s-button>
        {filtered && <s-link href="/app/mail?view=log">Clear</s-link>}
      </Form>
      {log.total === 0 ? (
        <s-paragraph>{filtered ? "No mails match." : "No mail has been sent yet."}</s-paragraph>
      ) : (
        <>
          <s-paragraph>{plural(log.total, "mail")}{filtered ? " match" : ""}, newest first.</s-paragraph>
          <div style={{ overflowX: "auto" }}>
            <table style={table}>
              <thead>
                <tr style={headRow}>
                  <th style={cell}>When</th>
                  <th style={cell}>To</th>
                  <th style={cell}>Mail</th>
                  <th style={cell}>Status</th>
                  <th style={cell}></th>
                </tr>
              </thead>
              <tbody>{log.rows.map((m) => <LogRow key={m.id} m={m} />)}</tbody>
            </table>
          </div>
          {log.pages > 1 && (
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 12, fontSize: 13 }}>
              {log.page > 1 ? <s-link href={link(log.page - 1)}>Newer</s-link> : <span style={muted}>Newer</span>}
              <span>Page {log.page} of {log.pages}</span>
              {log.page < log.pages ? <s-link href={link(log.page + 1)}>Older</s-link> : <span style={muted}>Older</span>}
            </div>
          )}
        </>
      )}
      <s-paragraph>
        “Not sent” means the mail was written but held back: no mail service is set up, or the address isn&apos;t on the test list.
        “Delivered” and “Bounced” appear once the mail service reports back. Mails stay in the log for {LOG_KEPT_DAYS} days.
      </s-paragraph>
    </s-section>
  );
}

function LogRow({ m }: { m: NonNullable<Awaited<ReturnType<typeof mailLog>>>["rows"][number] }) {
  const fetcher = useFetcher<typeof action>();
  const s = STATUS_TEXT[m.status] ?? { label: m.status };
  const result = fetcher.data;
  return (
    <tr>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{when(m.createdAt)}</td>
      <td style={cell}>
        {m.to}
        <div style={muted}>{m.audience === "admin" ? "Team" : "Seller"}</div>
      </td>
      <td style={cell}>
        {m.subject}
        <div style={muted}>{m.mail}</div>
      </td>
      <td style={cell}>
        <s-badge {...(s.tone ? { tone: s.tone } : {})}>{s.label}</s-badge>
        {m.note && <div style={{ ...muted, marginTop: 4, maxWidth: 320 }}>{m.note}</div>}
        {m.status === "queued" && m.attempts > 0 && <div style={{ ...muted, marginTop: 4 }}>Tried {plural(m.attempts, "time")}; trying again</div>}
      </td>
      <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
        {result && !result.ok && <div style={{ color: "#8e1f0b", maxWidth: 260, whiteSpace: "normal", textAlign: "left" }}>{result.error}</div>}
        {result?.ok ? <span style={muted}>Queued again</span> : m.canSendAgain && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="send_again" />
            <input type="hidden" name="id" value={m.id} />
            <s-button type="submit" variant="tertiary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Send again</s-button>
          </fetcher.Form>
        )}
      </td>
    </tr>
  );
}

function Team({ addresses }: { addresses: string[] }) {
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data?.intent === "team_addresses" ? fetcher.data : null;
  return (
    <s-section heading="Team addresses">
      <s-paragraph>
        Who on the Setu Store team gets the team&apos;s mails: a new sign-up or a business change waiting for approval, a low review,
        orders that are late to ship, and anything that broke. Sellers never see these addresses.
      </s-paragraph>
      {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
      {result?.ok && <s-banner tone="success">{result.message}</s-banner>}
      <fetcher.Form method="post" key={addresses.join(",")} style={{ display: "grid", gap: 8, maxWidth: 460, marginTop: 8 }}>
        <input type="hidden" name="intent" value="team_addresses" />
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Email addresses, one on each line (up to {TEAM_ADDRESSES_MAX})
          <textarea name="addresses" rows={Math.max(3, addresses.length + 1)} defaultValue={addresses.join("\n")} style={{ ...input, resize: "vertical" }} />
        </label>
        <div><s-button type="submit" variant="primary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button></div>
      </fetcher.Form>
      <s-paragraph>Leave it empty and save to stop all team mails.</s-paragraph>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
