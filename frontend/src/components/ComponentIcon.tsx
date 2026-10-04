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
 * field is empty or every fallback below also fails to load.
 */
export function ComponentIcon({ icon, size = 16, title, className = '' }: ComponentIconProps) {
  // 'primary': the manifest's own si:/favicon:/lucide value, color intact
  // where the source has it. 'mono': the colored source 404'd -- the
  // upstream simple-icons npm package still has the shape for some of
  // these, just without baked-in brand color. 'favicon': nothing si:
  // worked, try a guessed-domain favicon (color, but may be a generic
  // site icon rather than the actual brand mark). 'broken': give up,
  // show the generic icon.
  //
  // si: used to resolve ONLY through cdn.simpleicons.org, a third-party
  // proxy that turned out to be stale/dead for ~65 of the 186 brand slugs
  // this catalog references (Slack, Salesforce, Oracle, OpenAI, Tableau,
  // Azure, IBM, ...) -- confirmed directly, and NOT transient (Cloudflare's
  // own cache showed those 404s were weeks old). cdn.simpleicons.org bakes
  // the real brand hex color into each SVG's fill (e.g. Snowflake's
  // `fill="#29B5E8"`); the raw upstream package has no fill at all (relies
  // on `currentColor`, which an <img> can't see), so it can't just replace
  // the proxy outright -- that would turn ~120 currently-colored icons
  // flat black to recover only ~23. Kept as a colorless middle tier
  // instead: better than the generic Package icon, worse than real color.
  // The guessed-domain favicon fallback covers most of what's left after
  // that: brands genuinely outside Simple Icons' ~3,000-icon set
  // (Amplitude, Segment, Fivetran, Monday, ...), not a removal/proxy issue.
  const [stage, setStage] = useState<'primary' | 'mono' | 'favicon' | 'broken'>('primary');
  useEffect(() => setStage('primary'), [icon]);

  if (!icon?.trim() || stage === 'broken') {
    return <Package className={className} width={size} height={size} aria-hidden />;
  }

  if (icon.startsWith('si:')) {
    const slug = icon.slice(3).toLowerCase();
    if (stage === 'favicon') {
      return (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(`${slug}.com`)}&sz=64`}
          width={size}
          height={size}
          alt=""
          title={title ?? slug}
          loading="lazy"
          decoding="async"
          className={className}
          onError={() => setStage('broken')}
        />
      );
    }
    if (stage === 'mono') {
      return (
        <img
          src={`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`}
          width={size}
          height={size}
          alt=""
          title={title ?? slug}
          loading="lazy"
          decoding="async"
          // Same dark-mode-invert treatment as the lucide branch below --
          // this SVG is colorless for the same underlying reason (no
          // `fill`, relies on `currentColor` an <img> can't apply).
          className={`component-icon-lucide ${className}`}
          onError={() => setStage('favicon')}
        />
      );
    }
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
        onError={() => setStage('mono')}
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
        onError={() => setStage('broken')}
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
      onError={() => setStage('broken')}
    />
  );
}
