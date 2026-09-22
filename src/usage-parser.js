'use strict';

const KNOWN_LIMITS = [
  ['five_hour', '5-Stunden-Limit'],
  ['seven_day', 'Wochenlimit'],
  ['seven_day_sonnet', 'Sonnet · Woche'],
  ['seven_day_opus', 'Opus · Woche'],
  ['seven_day_oauth_apps', 'OAuth Apps · Woche'],
  ['seven_day_cowork', 'Cowork · Woche']
];

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resetSeconds(iso, now = Date.now()) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - now) / 1000));
}

function normalizePercent(item) {
  if (!item || typeof item !== 'object') return null;
  for (const key of ['utilization', 'percent_used', 'percentage_used', 'used_percent']) {
    const n = numberOrNull(item[key]);
    if (n !== null) return Math.max(0, Math.min(100, n));
  }
  return null;
}

function normalizeLimit(key, label, item, now) {
  if (!item || typeof item !== 'object') return null;
  const percent = normalizePercent(item);
  if (percent === null) return null;
  const resetsAt = item.resets_at ?? item.reset_at ?? item.resetsAt ?? null;
  return {
    key,
    label,
    percent_used: percent,
    percent_free: Math.max(0, 100 - percent),
    resets_at: resetsAt,
    reset_in_seconds: resetSeconds(resetsAt, now)
  };
}

function prettifyKey(key) {
  return String(key)
    .replace(/^seven_day_/, '')
    .replace(/^five_hour_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function parseFlexibleLimits(raw, now, seen) {
  const out = [];
  const list = Array.isArray(raw?.limits) ? raw.limits : [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key ?? item.id ?? item.name ?? `limit_${i}`);
    if (seen.has(key)) continue;
    const label = String(item.label ?? item.display_name ?? item.name ?? prettifyKey(key));
    const normalized = normalizeLimit(key, label, item, now);
    if (normalized) {
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

function parseCredits(raw) {
  const c = raw?.extra_usage ?? raw?.extraUsage ?? raw?.credits ?? null;
  if (!c || typeof c !== 'object') return null;
  const enabled = Boolean(c.is_enabled ?? c.enabled ?? true);
  const used = numberOrNull(c.used_credits ?? c.used ?? c.spend);
  const limit = numberOrNull(c.monthly_limit ?? c.limit ?? c.budget);
  const balance = numberOrNull(c.balance ?? c.remaining);
  const percent = numberOrNull(c.utilization ?? c.percent ?? c.percent_used);
  return {
    enabled,
    used,
    limit,
    balance,
    currency: String(c.currency ?? 'USD'),
    percent
  };
}

function normalizeUsage(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new Error('Usage-Antwort ist kein JSON-Objekt.');
  const limits = [];
  const seen = new Set();

  for (const [key, label] of KNOWN_LIMITS) {
    const normalized = normalizeLimit(key, label, raw[key], now);
    if (normalized) {
      seen.add(key);
      limits.push(normalized);
    }
  }

  limits.push(...parseFlexibleLimits(raw, now, seen));

  return {
    fetched_at: new Date(now).toISOString(),
    source_shape: Array.isArray(raw.limits) ? 'limits[] + web fields' : 'claude.ai web usage',
    limits,
    credits: parseCredits(raw),
    note: 'Live-Daten aus der eigenen isolierten Claude-WebSession. Der Claude.ai-Usage-Endpunkt ist nicht öffentlich dokumentiert.'
  };
}

module.exports = { normalizeUsage, resetSeconds };
