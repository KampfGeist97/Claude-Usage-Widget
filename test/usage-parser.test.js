'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsage } = require('../src/usage-parser');

test('normalizes current claude.ai usage shape', () => {
  const now = Date.parse('2026-09-22T10:00:00Z');
  const result = normalizeUsage({
    five_hour: { utilization: 17, resets_at: '2026-09-22T12:00:00Z' },
    seven_day: { utilization: 42, resets_at: '2026-09-29T10:00:00Z' },
    seven_day_sonnet: { utilization: 3, resets_at: null },
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 25, utilization: 25, currency: 'USD' }
  }, now);

  assert.equal(result.limits[0].key, 'five_hour');
  assert.equal(result.limits[0].percent_used, 17);
  assert.equal(result.limits[0].reset_in_seconds, 7200);
  assert.equal(result.limits[1].percent_used, 42);
  assert.equal(result.credits.enabled, true);
  assert.equal(result.credits.used, 25);
});

test('accepts flexible limits array', () => {
  const result = normalizeUsage({ limits: [{ key: 'custom_window', label: 'Custom', utilization: 55 }] });
  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].label, 'Custom');
  assert.equal(result.limits[0].percent_used, 55);
});
