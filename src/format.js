const intFormat = new Intl.NumberFormat('en-US');

export function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return intFormat.format(Math.round(n));
}

export function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return intFormat.format(Math.round(n));
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 100 * 1024 ? 0 : 1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtDimension(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0.000';
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  if (n >= 10) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}

export function fmtLoadTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '—';
  if (n < 1) return `${Math.round(n * 1000)} MS`;
  return `${n.toFixed(2)} S`;
}

export function fmtDuration(seconds) {
  const n = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(n / 60);
  const secs = n - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
}

export function fileNameFromURL(url) {
  try {
    const parsed = new URL(url, window.location.href);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'untitled.glb';
  } catch {
    const clean = String(url).split(/[?#]/)[0];
    return clean.split('/').filter(Boolean).pop() || 'untitled.glb';
  }
}

export function truncateMiddle(name, max = 28) {
  const value = String(name || 'Untitled');
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
