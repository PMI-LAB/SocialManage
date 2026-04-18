// routes/insights.js — Analytics da conta (alcance, impressões, audiência)
const express = require('express');
const db = require('../lib/db');
const { mfGet } = require('../lib/meta');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

function getAccount(userId, accountId) {
  if (accountId) {
    return db.prepare('SELECT id, ig_user_id FROM instagram_accounts WHERE id = ? AND user_id = ?')
      .get(parseInt(accountId), userId);
  }
  return db.prepare(`
    SELECT id, ig_user_id FROM instagram_accounts
    WHERE user_id = ? ORDER BY is_primary DESC LIMIT 1
  `).get(userId);
}

// Cache simples (5 min)
function getCached(accountId, key) {
  const row = db.prepare(`
    SELECT data_json FROM insights_cache
    WHERE ig_account_id = ? AND cache_key = ? AND expires_at > datetime('now')
  `).get(accountId, key);
  return row ? JSON.parse(row.data_json) : null;
}

function setCache(accountId, key, data, ttlSeconds = 300) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare(`
    INSERT INTO insights_cache (ig_account_id, cache_key, data_json, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ig_account_id, cache_key) DO UPDATE SET
      data_json = excluded.data_json, expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP
  `).run(accountId, key, JSON.stringify(data), expiresAt);
}

/**
 * Extrai valor da métrica da Graph API (v19+ tem total_value, antigas têm values array)
 */
function extractMetric(d) {
  if (!d) return null;
  if (d.total_value?.value != null) return d.total_value.value;
  if (Array.isArray(d.values) && d.values.length) return d.values;
  return null;
}

function sumValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.reduce((s, x) => s + (Number(x.value) || 0), 0);
  return null;
}

// ─── INSIGHTS GERAIS ──────────────────────────────────────
router.get('/overview', requireAuth, async (req, res) => {
  const { accountId, from, to } = req.query;
  const account = getAccount(req.user.id, accountId);
  if (!account) return res.status(400).json({ error: 'Sem conta IG' });

  const fromDate = from ? new Date(from + 'T00:00:00') : new Date(Date.now() - 29 * 86400000);
  const toDate   = to   ? new Date(to   + 'T23:59:59') : new Date();
  const since = Math.floor(fromDate.getTime() / 1000);
  const until = Math.floor(toDate.getTime() / 1000);

  const cacheKey = `overview:${since}:${until}`;
  const cached = getCached(account.id, cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  async function fetchOne(metric, period = 'day') {
    try {
      const r = await mfGet(`/${account.ig_user_id}/insights`, { metric, period, since, until }, account.id);
      if (!r?.data) return null;
      const item = r.data.find(d => d.name === metric) || r.data[0];
      return extractMetric(item);
    } catch { return null; }
  }

  const [reach, impressions, profileViews, websiteClicks, accountsEngaged, followerCount] =
    await Promise.all([
      fetchOne('reach'),
      fetchOne('impressions'),
      fetchOne('profile_views'),
      fetchOne('website_clicks'),
      fetchOne('accounts_engaged'),
      fetchOne('follower_count'),
    ]);

  const result = {
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    reach: sumValue(reach) || 0,
    impressions: sumValue(impressions) || 0,
    profile_views: sumValue(profileViews) || 0,
    website_clicks: sumValue(websiteClicks) || 0,
    accounts_engaged: sumValue(accountsEngaged) || 0,
    follower_count_delta: sumValue(followerCount) || 0,
    daily_reach: Array.isArray(reach) ? reach : [],
    daily_followers: Array.isArray(followerCount) ? followerCount : [],
  };

  setCache(account.id, cacheKey, result, 300);
  res.json(result);
});

// ─── AUDIÊNCIA (demografia) ───────────────────────────────
router.get('/audience', requireAuth, async (req, res) => {
  const { accountId } = req.query;
  const account = getAccount(req.user.id, accountId);
  if (!account) return res.status(400).json({ error: 'Sem conta IG' });

  const cacheKey = 'audience';
  const cached = getCached(account.id, cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  async function fetchLifetime(metric) {
    try {
      const r = await mfGet(`/${account.ig_user_id}/insights`, { metric, period: 'lifetime' }, account.id);
      return r?.data?.[0]?.values?.[0]?.value || null;
    } catch { return null; }
  }

  const [gender, country, city] = await Promise.all([
    fetchLifetime('audience_gender_age'),
    fetchLifetime('audience_country'),
    fetchLifetime('audience_city'),
  ]);

  const result = { gender_age: gender, country, city };
  setCache(account.id, cacheKey, result, 3600); // 1h
  res.json(result);
});

// ─── INSIGHTS DE UM POST ──────────────────────────────────
router.get('/post/:mediaId', requireAuth, async (req, res) => {
  const { accountId } = req.query;
  const mediaId = req.params.mediaId.replace(/^ig_/, '');
  const account = getAccount(req.user.id, accountId);
  if (!account) return res.status(400).json({ error: 'Sem conta IG' });

  try {
    const metrics = 'reach,impressions,saved,shares';
    const r = await mfGet(`/${mediaId}/insights`, { metric: metrics }, account.id);
    const out = {};
    for (const item of (r.data || [])) {
      out[item.name] = item.total_value?.value ?? item.values?.[0]?.value ?? 0;
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
