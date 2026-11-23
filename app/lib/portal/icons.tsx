/** Small line icons for the vendor portal (1.6px stroke, 24px grid). Decorative unless labelled. */
type P = { title?: string };
const base = (title?: string) => ({
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": title ? undefined : true, role: title ? "img" : undefined,
});

export const IconOrders = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 9h6M9 13h6" /></svg>
);
export const IconBox = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9" /></svg>
);
export const IconStore = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M4 9.5V20h16V9.5" /><path d="M3 9.5 5 4h14l2 5.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" /><path d="M10 20v-5h4v5" /></svg>
);
export const IconHome = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<rect x="4" y="4" width="7" height="8" rx="1.5" /><rect x="13" y="4" width="7" height="5" rx="1.5" /><rect x="4" y="14" width="7" height="6" rx="1.5" /><rect x="13" y="11" width="7" height="9" rx="1.5" /></svg>
);
export const IconRupee = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M7 5h10M7 9.5h10" /><path d="M10 5c3.2 0 5 1.6 5 4.3 0 2.7-2 4.2-5 4.2H7l7.5 6.5" /></svg>
);
export const IconTeam = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2" /><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.6c1.7.7 2.9 2.3 3.3 4.9" /></svg>
);
export const IconOut = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M14 5h5v14h-5" /><path d="M10 8 6 12l4 4M6 12h10" /></svg>
);
export const IconBack = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M15 6l-6 6 6 6" /></svg>
);
export const IconPrint = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></svg>
);
export const IconCheck = ({ title }: P) => (
  <svg {...base(title)}>{title && <title>{title}</title>}<circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16 9.5" /></svg>
);

/** A single bridge arch – the Hindi word setu means "bridge". Used once, large and faint, on the sign-in panel. */
export const BridgeArch = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 600 220" fill="none" stroke="currentColor" strokeWidth="10" aria-hidden="true">
    <path d="M0 200 Q300 -40 600 200" />
    <path d="M0 200h600" />
    {[60, 120, 180, 240, 300, 360, 420, 480, 540].map((x) => {
      const t = x / 600;
      const y = (1 - t) * (1 - t) * 200 + 2 * (1 - t) * t * -40 + t * t * 200;
      return <path key={x} d={`M${x} ${y.toFixed(1)}V200`} strokeWidth="6" />;
    })}
  </svg>
);
