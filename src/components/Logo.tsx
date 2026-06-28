// Legacy logo mark — concentric brand-blue rings rippling out from a warm
// center, per docs/design/legacy-brand-kit. Geometry: viewBox 0 0 120 120,
// center (60,60). Colors reference the CSS design tokens.

export function LegacyMark({ size = 64 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="60" cy="60" r="52" stroke="var(--accent)" strokeOpacity="0.22" strokeWidth="2.5" />
      <circle cx="60" cy="60" r="39" stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="2.5" />
      <circle cx="60" cy="60" r="26" stroke="var(--accent)" strokeOpacity="0.85" strokeWidth="2.5" />
      <circle cx="60" cy="60" r="12.5" fill="var(--tan)" />
    </svg>
  );
}

// Stacked brand header for the auth screens: mark, wordmark, and mono tagline.
export function BrandHeader() {
  return (
    <div className="brand">
      <LegacyMark size={60} />
      <div className="wordmark">Legacy</div>
      <div className="eyebrow">Plan · Protect · Pass on</div>
    </div>
  );
}
