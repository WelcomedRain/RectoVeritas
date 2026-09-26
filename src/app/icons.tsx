/** Lucide only, inline SVG on currentColor. */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
};

function Icon({ size = 15, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} {...base} aria-hidden="true">
      {children}
    </svg>
  );
}

export const Monitor = ({ size = 15 }) => (
  <Icon size={size}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <path d="M8 21h8m-4-4v4" />
  </Icon>
);

export const Tablet = ({ size = 15 }) => (
  <Icon size={size}>
    <rect width="16" height="20" x="4" y="2" rx="2" />
    <path d="M12 18h.01" />
  </Icon>
);

export const Smartphone = ({ size = 15 }) => (
  <Icon size={size}>
    <rect width="14" height="20" x="5" y="2" rx="2" />
    <path d="M12 18h.01" />
  </Icon>
);

export const ZoomIn = ({ size = 15 }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
  </Icon>
);

export const ZoomOut = ({ size = 15 }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3M8 11h6" />
  </Icon>
);
