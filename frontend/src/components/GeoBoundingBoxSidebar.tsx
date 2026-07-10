import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Map as MapIcon, Locate } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface GeoBoundingBoxSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
}

/**
 * Specialized sidebar for `bounding_box_filter` (and any future
 * geo-bbox-shaped component). Shows an interactive Leaflet map with a
 * draggable / resizable rectangle representing (min_lat, min_lng) →
 * (max_lat, max_lng). Editing the rectangle updates the schema values;
 * editing the numeric inputs re-draws the rectangle. Also plots the
 * upstream asset's actual points on the map when we have that data
 * cached — makes it clear which points the filter is keeping.
 *
 * Leaflet + OpenStreetMap tiles — free, no API key needed.
 */

// Sensible default frame for the map when no bbox has been picked yet
// — covers CONUS-ish so US-centric demos start with something familiar.
const DEFAULT_VIEW = { center: [39.5, -98.5] as [number, number], zoom: 3 };

export function GeoBoundingBoxSidebar({ attributes, onChange, onOpenAdvanced }: GeoBoundingBoxSidebarProps) {
  const { currentProject } = useProjectStore();

  const [previewRows, setPreviewRows] = useState<Array<Record<string, any>>>([]);
  const [schemas, setSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});
  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  const upstreamKey = (attributes.upstream_asset_key as string) || '';
  const latCol = (attributes.lat_column as string) || 'lat';
  const lngCol = (attributes.lng_column as string) || 'lng';
  const keepOutside = !!attributes.keep_outside;

  const columns = schemas[upstreamKey]?.columns ?? [];
  // Best-effort column defaults: pick anything that looks like lat/lng
  // if the config still has the hard-coded defaults.
  useEffect(() => {
    if (!columns.length) return;
    if (attributes.lat_column) return;
    const guess = columns.find((c) => /^(lat|latitude|y)$/i.test(c));
    if (guess) onChange('lat_column', guess);
  }, [columns.join('|')]);
  useEffect(() => {
    if (!columns.length) return;
    if (attributes.lng_column) return;
    const guess = columns.find((c) => /^(lng|long|longitude|lon|x)$/i.test(c));
    if (guess) onChange('lng_column', guess);
  }, [columns.join('|')]);

  // Fetch a preview of the upstream so we can plot actual points on
  // the map. Only fetch if we have a real upstream key. Non-fatal.
  useEffect(() => {
    if (!currentProject || !upstreamKey) return;
    let cancelled = false;
    assetsApi.previewData(currentProject.id, upstreamKey, { sampleLimit: 500 }).then((r) => {
      if (!cancelled && r?.success && r?.data) setPreviewRows(r.data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id, upstreamKey]);

  const bbox = useMemo(() => ({
    minLat: numeric(attributes.min_lat, 34.0),
    maxLat: numeric(attributes.max_lat, 42.0),
    minLng: numeric(attributes.min_lng, -125.0),
    maxLng: numeric(attributes.max_lng, -114.0),
  }), [attributes.min_lat, attributes.max_lat, attributes.min_lng, attributes.max_lng]);

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const rectRef = useRef<L.Rectangle | null>(null);
  const pointsLayerRef = useRef<L.LayerGroup | null>(null);
  // Track whether the current bbox change originated from a map drag —
  // avoids feedback loop when the numeric inputs re-render the rect.
  const isMapEdit = useRef(false);

  // One-shot map init.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, {
      center: DEFAULT_VIEW.center,
      zoom: DEFAULT_VIEW.zoom,
      zoomControl: true,
      attributionControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    pointsLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync the rectangle whenever the bbox values change. Recreate the
  // Rectangle rather than mutate its bounds so drag handles stay clean.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isMapEdit.current) {
      isMapEdit.current = false;
      return;
    }
    if (rectRef.current) {
      rectRef.current.remove();
      rectRef.current = null;
    }
    const bounds = L.latLngBounds(
      [bbox.minLat, bbox.minLng],
      [bbox.maxLat, bbox.maxLng],
    );
    const rect = L.rectangle(bounds, {
      color: keepOutside ? '#ef4444' : '#3b82f6',
      weight: 2,
      fillOpacity: 0.15,
    }).addTo(map);
    // Drag handles: 4 corner markers.
    addResizeHandles(map, rect, (b) => {
      isMapEdit.current = true;
      onChange('min_lat', roundCoord(b.getSouth()));
      onChange('max_lat', roundCoord(b.getNorth()));
      onChange('min_lng', roundCoord(b.getWest()));
      onChange('max_lng', roundCoord(b.getEast()));
    });
    rectRef.current = rect;
  }, [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, keepOutside]);

  // Fit the map view to the bbox on first meaningful change.
  const fittedOnce = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedOnce.current) return;
    if (bbox.maxLat - bbox.minLat > 0.1 && bbox.maxLng - bbox.minLng > 0.1) {
      map.fitBounds([[bbox.minLat, bbox.minLng], [bbox.maxLat, bbox.maxLng]], { padding: [20, 20] });
      fittedOnce.current = true;
    }
  }, [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng]);

  // Plot upstream data points if columns are known + previewed.
  useEffect(() => {
    const layer = pointsLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!previewRows.length || !latCol || !lngCol) return;
    let insideCount = 0;
    let outsideCount = 0;
    for (const row of previewRows) {
      const lat = Number(row[latCol]);
      const lng = Number(row[lngCol]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const inside = lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
      const kept = keepOutside ? !inside : inside;
      inside ? insideCount++ : outsideCount++;
      L.circleMarker([lat, lng], {
        radius: 3,
        color: kept ? '#10b981' : '#94a3b8',
        weight: 1,
        fillColor: kept ? '#10b981' : '#e2e8f0',
        fillOpacity: 0.7,
      }).addTo(layer);
    }
    void insideCount; void outsideCount;
  }, [previewRows, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, latCol, lngCol, keepOutside]);

  const stats = useMemo(() => {
    let kept = 0;
    let dropped = 0;
    let missing = 0;
    for (const row of previewRows) {
      const lat = Number(row[latCol]);
      const lng = Number(row[lngCol]);
      if (!isFinite(lat) || !isFinite(lng)) { missing++; continue; }
      const inside = lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
      if (keepOutside ? !inside : inside) kept++; else dropped++;
    }
    return { kept, dropped, missing, total: previewRows.length };
  }, [previewRows, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, latCol, lngCol, keepOutside]);

  const setCoord = (name: 'min_lat' | 'max_lat' | 'min_lng' | 'max_lng', v: string) => {
    const n = v === '' ? null : Number(v);
    onChange(name, n);
  };

  const zoomToFit = () => {
    const map = mapRef.current;
    if (!map) return;
    if (previewRows.length && latCol && lngCol) {
      const lats: number[] = [];
      const lngs: number[] = [];
      for (const r of previewRows) {
        const la = Number(r[latCol]);
        const ln = Number(r[lngCol]);
        if (isFinite(la) && isFinite(ln)) { lats.push(la); lngs.push(ln); }
      }
      if (lats.length) {
        const pad = 0.5;
        map.fitBounds([
          [Math.min(...lats) - pad, Math.min(...lngs) - pad],
          [Math.max(...lats) + pad, Math.max(...lngs) + pad],
        ]);
        return;
      }
    }
    map.fitBounds([[bbox.minLat, bbox.minLng], [bbox.maxLat, bbox.maxLng]], { padding: [20, 20] });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <MapIcon className="w-4 h-4 text-primary" /> Bounding box filter
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Drag the rectangle on the map to define the geographic area — the filter keeps points {keepOutside ? 'OUTSIDE' : 'inside'} it.
        </p>
      </div>

      {/* Column pickers — which columns hold lat/lng. */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Latitude column</label>
          {columns.length > 0 ? (
            <select
              value={latCol}
              onChange={(e) => onChange('lat_column', e.target.value)}
              className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">— pick column —</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              value={latCol}
              onChange={(e) => onChange('lat_column', e.target.value)}
              className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Longitude column</label>
          {columns.length > 0 ? (
            <select
              value={lngCol}
              onChange={(e) => onChange('lng_column', e.target.value)}
              className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">— pick column —</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              value={lngCol}
              onChange={(e) => onChange('lng_column', e.target.value)}
              className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>
      </section>

      {/* Map viewer. Drag the blue rectangle to reshape the bbox. */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Bounding box</label>
          <button
            type="button"
            onClick={zoomToFit}
            className="text-[10px] text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
          >
            <Locate className="w-3 h-3" /> Fit to data
          </button>
        </div>
        <div
          ref={mapEl}
          className="w-full h-64 rounded-md overflow-hidden border border-gray-200"
        />
        <p className="mt-1 text-[10px] text-gray-500">
          Drag the corner handles to resize. Tiles © OpenStreetMap contributors.
        </p>
      </section>

      {/* Numeric coord inputs — kept small under the map for precise entry. */}
      <section className="grid grid-cols-2 gap-2">
        <CoordInput label="Min latitude"  value={bbox.minLat}  onChange={(v) => setCoord('min_lat', v)} />
        <CoordInput label="Max latitude"  value={bbox.maxLat}  onChange={(v) => setCoord('max_lat', v)} />
        <CoordInput label="Min longitude" value={bbox.minLng}  onChange={(v) => setCoord('min_lng', v)} />
        <CoordInput label="Max longitude" value={bbox.maxLng}  onChange={(v) => setCoord('max_lng', v)} />
      </section>

      {/* Keep-inside vs keep-outside toggle. */}
      <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          checked={keepOutside}
          onChange={(e) => onChange('keep_outside', e.target.checked)}
          className="w-3.5 h-3.5"
        />
        <span>Invert — keep points OUTSIDE the box</span>
      </label>

      {/* Live impact strip — how many points from the previewed sample
          this filter would keep vs drop. Requires the upstream to have
          been previewed at least once. */}
      {previewRows.length > 0 && (
        <div className="p-3 rounded-md bg-emerald-50 border border-emerald-200">
          <div className="flex items-center justify-between text-xs">
            <div>
              <div className="text-emerald-900 font-semibold">
                {stats.kept.toLocaleString()} of {stats.total.toLocaleString()} points kept
              </div>
              <div className="text-emerald-700 text-[11px] mt-0.5">
                {stats.dropped} dropped
                {stats.missing > 0 && ` · ${stats.missing} missing coords`}
              </div>
            </div>
            <div className="text-3xl font-bold text-emerald-600 tabular-nums">
              {stats.total > 0 ? Math.round((stats.kept / stats.total) * 100) : 0}%
            </div>
          </div>
          <p className="text-[10px] text-emerald-700 mt-2">
            Based on the last preview of <span className="font-mono">{upstreamKey}</span> ({stats.total} rows).
          </p>
        </div>
      )}
      {previewRows.length === 0 && upstreamKey && (
        <div className="p-2 rounded-md bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
          Preview <span className="font-mono">{upstreamKey}</span> once to see live counts and points on the map.
        </div>
      )}

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (partition, freshness, tags, retry policy, …)
        </button>
      )}
    </div>
  );
}

// --- Helpers -------------------------------------------------------

function CoordInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">{label}</label>
      <input
        type="number"
        step="0.0001"
        value={isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function numeric(v: any, fallback: number): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function roundCoord(n: number): number {
  return Math.round(n * 100000) / 100000; // 5 decimals ~= 1 meter
}

// Attach four corner + four edge midpoint drag handles to the rectangle
// so users can grab either. We use small circleMarkers so the handles
// stay visible even at low zoom levels.
function addResizeHandles(
  map: L.Map,
  rect: L.Rectangle,
  onChangeBounds: (b: L.LatLngBounds) => void,
) {
  const layer = L.layerGroup().addTo(map);
  const drawHandles = () => {
    layer.clearLayers();
    const b = rect.getBounds();
    const s = b.getSouth();
    const n = b.getNorth();
    const w = b.getWest();
    const e = b.getEast();
    const corners: Array<[[number, number], (lat: number, lng: number) => L.LatLngBounds]> = [
      [[n, w], (lat, lng) => L.latLngBounds([s, lng], [lat, e])],   // NW
      [[n, e], (lat, lng) => L.latLngBounds([s, w], [lat, lng])],   // NE
      [[s, w], (lat, lng) => L.latLngBounds([lat, lng], [n, e])],   // SW
      [[s, e], (lat, lng) => L.latLngBounds([lat, w], [n, lng])],   // SE
    ];
    for (const [pos, mkBounds] of corners) {
      const handle = L.marker(pos, {
        draggable: true,
        icon: L.divIcon({
          className: '',
          html: '<div style="width:12px;height:12px;background:#3b82f6;border:2px solid white;border-radius:2px;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>',
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      }).addTo(layer);
      handle.on('drag', () => {
        const ll = handle.getLatLng();
        const nb = mkBounds(ll.lat, ll.lng);
        rect.setBounds(nb);
      });
      handle.on('dragend', () => onChangeBounds(rect.getBounds()));
    }
  };
  drawHandles();
  rect.on('editable-updated', drawHandles);
}
