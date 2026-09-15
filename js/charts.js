// charts.js — self-contained inline-SVG chart rendering. No external libraries,
// no CDN, no DOM dependency for the pure helpers (safe to import in node).
//
// Charts are responsive: an intrinsic coordinate system is defined via viewBox
// and the <svg> is set to width:100% so it scales to its container. Callers pass
// an array of points [{date, value}] plus options.
//
// Two chart builders are exported:
//   lineChartSvg(points, opts)  — line chart with axis labels + point markers,
//                                 optional shaded target band (for running pace).
//   barChartSvg(points, opts)   — bar chart variant (used for total volume).
//
// Plus small pure helpers used by the charts and unit-testable in node:
//   niceExtent, scaleLinear, trendDirection.

// --- Pure math helpers -------------------------------------------------------

// Given a numeric min/max (and optional forced-include bounds e.g. a target
// band), return a slightly padded [lo, hi] extent so points/bands don't touch
// the chart edges. Guards against a zero-height range.
export function niceExtent(min, max, opts = {}) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (Number.isFinite(opts.includeMin)) lo = Math.min(lo, opts.includeMin);
  if (Number.isFinite(opts.includeMax)) hi = Math.max(hi, opts.includeMax);
  if (lo === hi) {
    // Flat data: open up a symmetric window around the value.
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    return [lo - pad, hi + pad];
  }
  const span = hi - lo;
  const pad = span * (Number.isFinite(opts.padRatio) ? opts.padRatio : 0.1);
  return [lo - pad, hi + pad];
}

// Map a value from a domain [d0,d1] to a range [r0,r1] (linear). When the
// domain is degenerate, returns the range midpoint.
export function scaleLinear(value, d0, d1, r0, r1) {
  if (d1 === d0) return (r0 + r1) / 2;
  const t = (value - d0) / (d1 - d0);
  return r0 + t * (r1 - r0);
}

// Compare the latest value to the previous one. Returns 'up' | 'down' | 'flat'.
// `lowerIsBetter` only affects nothing here (pure direction); callers decide
// how to phrase good/bad. epsilon absorbs tiny float noise.
export function trendDirection(values, epsilon = 1e-9) {
  if (!Array.isArray(values) || values.length < 2) return 'flat';
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  if (!Number.isFinite(last) || !Number.isFinite(prev)) return 'flat';
  if (last - prev > epsilon) return 'up';
  if (prev - last > epsilon) return 'down';
  return 'flat';
}

// --- SVG string helpers ------------------------------------------------------

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '';
  // Trim trailing zeros: 12.0 -> 12, 12.50 -> 12.5
  return String(Math.round(n * 100) / 100);
}

// Shorten an ISO date (YYYY-MM-DD) to MM/DD for compact x-axis labels.
function shortDate(date) {
  const s = String(date || '');
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return s;
}

// Shared chart geometry (intrinsic coordinates; scaled responsively via viewBox).
const VIEW_W = 320;
const VIEW_H = 180;
const PAD = { top: 12, right: 12, bottom: 26, left: 34 };

function plotArea() {
  return {
    x0: PAD.left,
    x1: VIEW_W - PAD.right,
    y0: VIEW_H - PAD.bottom, // bottom (min value)
    y1: PAD.top, // top (max value)
  };
}

// A friendly empty-state block (not an SVG) when there is too little data.
export const EMPTY_STATE_TEXT = '기록이 쌓이면 추이가 표시됩니다';

export function emptyStateHtml(text) {
  return `<p class="chart-empty muted">${esc(text || EMPTY_STATE_TEXT)}</p>`;
}

// Build gridline + y-axis label markup for a value domain.
function yAxisMarkup(area, dMin, dMax, formatValue) {
  const ticks = 3;
  let out = '';
  for (let i = 0; i <= ticks; i += 1) {
    const val = dMin + ((dMax - dMin) * i) / ticks;
    const y = scaleLinear(val, dMin, dMax, area.y0, area.y1);
    out += `<line class="chart-grid" x1="${area.x0}" y1="${fmtNum(y)}" x2="${area.x1}" y2="${fmtNum(y)}" />`;
    out += `<text class="chart-axis-label" x="${area.x0 - 4}" y="${fmtNum(y + 3)}" text-anchor="end">${esc(formatValue ? formatValue(val) : fmtNum(val))}</text>`;
  }
  return out;
}

// Build sparse x-axis (first / middle / last) date labels.
function xAxisMarkup(area, points) {
  if (points.length === 0) return '';
  const idxs = points.length === 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const seen = new Set();
  let out = '';
  idxs.forEach((idx) => {
    if (seen.has(idx)) return;
    seen.add(idx);
    const x = points.length === 1
      ? (area.x0 + area.x1) / 2
      : scaleLinear(idx, 0, points.length - 1, area.x0, area.x1);
    const anchor = idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle';
    out += `<text class="chart-axis-label" x="${fmtNum(x)}" y="${VIEW_H - 8}" text-anchor="${anchor}">${esc(shortDate(points[idx].date))}</text>`;
  });
  return out;
}

// Wrap chart body in a responsive <svg> element string.
function svgWrap(body, title) {
  return `<svg class="chart-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="${esc(title || '추이 차트')}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

// --- Line chart --------------------------------------------------------------
// points: [{date, value}]. opts:
//   title       — accessible label
//   band        — { min, max } drawn as a shaded region (e.g. running target)
//   formatValue — fn(value) -> label for the y-axis / markers
export function lineChartSvg(points, opts = {}) {
  const pts = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.value)) : [];
  if (pts.length < 2) return emptyStateHtml(opts.emptyText);

  const area = plotArea();
  const values = pts.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const band = opts.band && Number.isFinite(opts.band.min) && Number.isFinite(opts.band.max)
    ? opts.band
    : null;

  const [dMin, dMax] = niceExtent(rawMin, rawMax, {
    includeMin: band ? band.min : undefined,
    includeMax: band ? band.max : undefined,
  });

  const xFor = (i) => scaleLinear(i, 0, pts.length - 1, area.x0, area.x1);
  const yFor = (v) => scaleLinear(v, dMin, dMax, area.y0, area.y1);

  let body = '';

  // Shaded target band.
  if (band) {
    const yTop = yFor(band.max);
    const yBot = yFor(band.min);
    const h = Math.abs(yBot - yTop);
    body += `<rect class="chart-band" x="${area.x0}" y="${fmtNum(Math.min(yTop, yBot))}" width="${area.x1 - area.x0}" height="${fmtNum(h)}" />`;
  }

  body += yAxisMarkup(area, dMin, dMax, opts.formatValue);

  // Polyline path.
  const path = pts.map((p, i) => `${fmtNum(xFor(i))},${fmtNum(yFor(p.value))}`).join(' ');
  body += `<polyline class="chart-line" points="${path}" fill="none" />`;

  // Point markers with titles for hover.
  pts.forEach((p, i) => {
    const cx = xFor(i);
    const cy = yFor(p.value);
    const label = opts.formatValue ? opts.formatValue(p.value) : fmtNum(p.value);
    body += `<circle class="chart-dot" cx="${fmtNum(cx)}" cy="${fmtNum(cy)}" r="3"><title>${esc(p.date)} · ${esc(label)}</title></circle>`;
  });

  body += xAxisMarkup(area, pts);

  return svgWrap(body, opts.title);
}

// --- Bar chart ---------------------------------------------------------------
// points: [{date, value}]. opts: title, formatValue.
export function barChartSvg(points, opts = {}) {
  const pts = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.value)) : [];
  if (pts.length < 2) return emptyStateHtml(opts.emptyText);

  const area = plotArea();
  const values = pts.map((p) => p.value);
  const rawMax = Math.max(...values);
  // Bars are anchored at zero; extend the top a little for headroom.
  const dMin = 0;
  const [, dMax] = niceExtent(0, rawMax, { padRatio: 0.12 });

  const yFor = (v) => scaleLinear(v, dMin, dMax, area.y0, area.y1);

  let body = yAxisMarkup(area, dMin, dMax, opts.formatValue);

  const n = pts.length;
  const slot = (area.x1 - area.x0) / n;
  const barW = Math.max(2, slot * 0.6);

  pts.forEach((p, i) => {
    const cx = area.x0 + slot * (i + 0.5);
    const x = cx - barW / 2;
    const y = yFor(p.value);
    const h = area.y0 - y;
    const label = opts.formatValue ? opts.formatValue(p.value) : fmtNum(p.value);
    body += `<rect class="chart-bar" x="${fmtNum(x)}" y="${fmtNum(y)}" width="${fmtNum(barW)}" height="${fmtNum(Math.max(0, h))}"><title>${esc(p.date)} · ${esc(label)}</title></rect>`;
  });

  body += xAxisMarkup(area, pts);

  return svgWrap(body, opts.title);
}
