// Steeze draws its glyphs instead of typing them (⚙ × ▾ render differently in every font).
// Line icons follow Lucide's geometry at a 1.5px stroke, single ink (currentColor).
import type { ReactNode } from 'react';

const G = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg className="glyph" viewBox="0 0 24 24" aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
    {children}
  </svg>
);

export const Gear = () => (
  <G>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </G>
);
export const Back = () => (
  <G>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </G>
);
export const Camera = () => (
  <G>
    <path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5z" />
    <circle cx="12" cy="13" r="3" />
  </G>
);
export const ImageIcon = () => (
  <G>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </G>
);
export const Download = () => (
  <G>
    <path d="M12 15V3M7 10l5 5 5-5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </G>
);
export const More = () => (
  <G>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </G>
);
export const Close = () => <i className="x" aria-hidden="true" />;
export const Chev = ({ open }: { open?: boolean }) => <i className={`chev${open ? '' : ' right'}`} aria-hidden="true" />;

/** The wordless Steeze mark: one hexagon outline. Splat's version adds the cube edges inside it. */
export const HexMark = ({ cube = true }: { cube?: boolean }) => (
  <svg className="hexmark" viewBox="0 0 24 24" aria-hidden="true">
    <polygon points="12,1.5 21.1,6.75 21.1,17.25 12,22.5 2.9,17.25 2.9,6.75" />
    {cube && <path d="M12 12 21.1 6.75M12 12 2.9 6.75M12 12v10.5" strokeOpacity="0.55" />}
  </svg>
);

/** Two words, white then red: SPL AT. */
export const Wordmark = () => (
  <span className="wordmark">
    Spl<b>at</b>
  </span>
);
