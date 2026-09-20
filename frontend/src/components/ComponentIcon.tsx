import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';

const LUCIDE_STATIC_VER = '0.460.0';

/** Convert a Lucide React component name (e.g. "BarChart2") to its static
 *  icon file stem ("bar-chart-2"). */
function lucideNameToKebab(icon: string): string {
  const parts = icon.match(/[A-Z][a-z0-9]*|[0-9]+/g);
  if (!parts?.length) return icon.toLowerCase();
  return parts.map((p) => p.toLowerCase()).join('-');
}

interface ComponentIconProps {
  /** A manifest `icon` value: "si:slug" (Simple Icons brand logo),
   *  "favicon:domain.com" (that site's favicon), or a bare Lucide icon
   *  name (e.g. "BarChart2"). */
  icon?: string | null;
  size?: number;
  title?: string;
  className?: string;
}

/**
 * Renders the community component catalog's `icon` field. Same resolution
 * as https://dagster-component-ui.vercel.app/ (the reference site these
 * icons were curated on) so a component looks the same there and in the
 * Add Component picker here. Falls back to a generic Package icon if the
 * field is empty or the image 404s.
 */
export function ComponentIcon({ icon, size = 16, title, className = '' }: ComponentIconProps) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [icon]);

  if (!icon?.trim() || broken) {
    return <Package className={className} width={size} height={size} aria-hidden />;
  }

  if (icon.startsWith('si:')) {
    const slug = icon.slice(3).toLowerCase();
    return (
      <img
        src={`https://cdn.simpleicons.org/${slug}`}
        width={size}
        height={size}
        alt=""
        title={title ?? slug}
        loading="lazy"
        decoding="async"
        className={className}
        onError={() => setBroken(true)}
      />
    );
  }

  if (icon.startsWith('favicon:')) {
    const domain = icon.slice('favicon:'.length);
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
        width={size}
        height={size}
        alt=""
        title={title ?? domain}
        loading="lazy"
        decoding="async"
        className={className}
        onError={() => setBroken(true)}
      />
    );
  }

  // Unlike the si:/favicon: cases (real brand logos, which should keep
  // their actual colors in both themes), lucide-static SVGs are plain
  // black strokes with no theme-awareness of their own -- loaded as a
  // plain <img>, `currentColor` inside them can't see the page's text
  // color, so they'd render as invisible near-black on our dark cards.
  // The "component-icon-lucide" class picks up a dark-mode invert in
  // index.css to fix that.
  const kebab = lucideNameToKebab(icon);
  return (
    <img
      src={`https://cdn.jsdelivr.net/npm/lucide-static@${LUCIDE_STATIC_VER}/icons/${kebab}.svg`}
      width={size}
      height={size}
      alt=""
      title={title ?? icon}
      loading="lazy"
      decoding="async"
      className={`component-icon-lucide ${className}`}
      onError={() => setBroken(true)}
    />
  );
}
