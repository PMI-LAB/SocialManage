// routes/inbox.js — DMs, comentários, menções
const express = require('express');
const db = require('../lib/db');
const { mfGet, mfPost } = require('../lib/meta');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

function getPrimaryAccount(userId) {
  return db.prepare(`
    SELECT id, ig_user_id, page_id, username
    FROM instagram_accounts WHERE user_id = ?
    ORDER BY is_primary DESC LIMIT 1
  `).get(userId);
}

router.get('/', requireAuth, async (req, res) => {
  const account = getPrimaryAccount(req.user.id);
  if (!account) return res.json({ messages: [], warning: 'Nenhuma conta Instagram conectada' });

  const messages = [];
  let dmError = null;

  // 1. DMs (precisa de page_id + instagram_manage_messages)
  if (account.page_id) {
    try {
      const conv = await mfGet(`/${account.page_id}/conversations`, {
        platform: 'instagram',
        fields: 'id,participants,messages{id,message,from,created_time}',
        limit: 20,
      }, account.id);
      for (const c of (conv.data || [])) {
        const msgs = (c.messages?.data || []).slice().reverse();
        const last = msgs[msgs.length - 1];
        if (!last) continue;
        const other = c.participants?.data?.find(p => p.id !== account.ig_user_id);
        messages.push({
          id: c.id,
          type: 'dm',
          from: other?.name || last.from?.username || 'Usuário',
          preview: last.message || '[mídia]',
          timestamp: last.created_time,
          thread: msgs,
        });
      }
    } catch (e) {
      dmError = e.message;
    }
  }

  // 2. Menções
  try {
    const mentions = await mfGet(`/${account.ig_user_id}/tags`, {
      fields: 'id,caption,media_type,timestamp,username,media_url,permalink',
      limit: 20,
    }, account.id);
    for (const m of (mentions.data || [])) {
      messages.push({
        id: `mention_${m.id}`,
        type: 'mention',
        from: m.username || 'Usuário',
        preview: `Mencionou você: "${(m.caption || '').substring(0, 90)}"`,
        timestamp: m.timestamp,
        media_url: m.media_url,
        permalink: m.permalink,
      });
    }
  } catch { /* silencioso */ }

  // 3. Comentários dos últimos 8 posts
  try {
    const media = await mfGet(`/${account.ig_user_id}/media`, { fields: 'id,caption', limit: 8 }, account.id);
    for (const m of (media.data || [])) {
      try {
        const coms = await mfGet(`/${m.id}/comments`, {
          fields: 'id,text,username,timestamp,replies{id}',
          limit: 10,
        }, account.id);
        for (const c of (coms.data || [])) {
          messages.push({
            id: c.id,
            type: 'comment',
            from: c.username || 'Usuário',
            preview: c.text,
            timestamp: c.timestamp,
            post_id: m.id,
            post_caption: (m.caption || '').substring(0, 40),
            has_reply: !!(c.replies?.data?.length),
          });
        }
      } catch { /* pula */ }
    }
  } catch { /* silencioso */ }

  messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ messages, dm_error: dmError });
});

// Responder DM
router.post('/reply-dm', requireAuth, async (req, res) => {
  const { recipientId, message } = req.body || {};
  if (!recipientId || !message) return res.status(400).json({ error: 'Campos obrigatórios' });
  const account = getPrimaryAccount(req.user.id);
  if (!account?.page_id) return res.status(400).json({ error: 'Sem conta IG com Page' });
  try {
    const r = await mfPost(`/${account.page_id}/messages`, {
      recipient: JSON.stringify({ id: recipientId }),
      message: JSON.stringify({ text: message }),
      messaging_type: 'RESPONSE',
    }, account.id);
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
