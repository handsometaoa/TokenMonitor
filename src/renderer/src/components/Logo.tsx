export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <div className="brand-mark" style={{ width: size, height: size, borderRadius: Math.round(size * 0.34) }}>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect x="5" y="17" width="5.5" height="10" rx="2.2" fill="white" opacity="0.82" />
        <rect x="13.25" y="11" width="5.5" height="16" rx="2.2" fill="white" opacity="0.92" />
        <rect x="21.5" y="5" width="5.5" height="22" rx="2.2" fill="white" />
        <circle cx="24.25" cy="5.4" r="2.5" fill="#C8F25A" />
      </svg>
    </div>
  );
}
