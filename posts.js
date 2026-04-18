// routes/posts.js — Posts: CRUD, agendar, publicar, aprovar
const express = require('express');
const db = require('../lib/db');
const { mfGet, publishPost } = require('../lib/meta');
const { requireAuth, auditLog } = require('../lib/auth');

const router = express.Router();

function getUserAccount(userId, accountId) {
  return db.prepare(`
    SELECT id, ig_user_id, username FROM instagram_accounts
    WHERE id = ? AND user_id = ?
  `).get(accountId, userId);
}

function getPrimaryAccount(userId) {
  return db.prepare(`
    SELECT id, ig_user_id, username FROM instagram_accounts
    WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1
  `).get(userId);
}

// ─── LISTAR POSTS ─────────────────────────────────────────
// Mescla posts locais (rascunhos/agendados) + Instagram (publicados)
router.get('/', requireAuth, async (req, res) => {
  const { status, from, to, accountId, limit = 50, source = 'all' } = req.query;

  // Conta IG alvo
  let account;
  if (accountId) account = getUserAccount(req.user.id, parseInt(accountId));
  else account = getPrimaryAccount(req.user.id);

  const localPosts = [];
  const remotePosts = [];

  // 1. Posts locais (rascunhos, agendados, pendentes)
  if (source === 'all' || source === 'local') {
    let sql = 'SELECT * FROM posts WHERE user_id = ?';
    const params = [req.user.id];
    if (account) { sql += ' AND ig_account_id = ?'; params.push(account.id); }
    if (status)  { sql += ' AND status = ?'; params.push(status); }
    if (from)    { sql += ' AND (scheduled_for >= ? OR published_at >= ? OR created_at >= ?)'; params.push(from, from, from); }
    if (to)      { sql += ' AND (scheduled_for <= ? OR published_at <= ? OR created_at <= ?)'; params.push(to, to, to); }
    sql += ' ORDER BY COALESCE(scheduled_for, published_at, created_at) DESC LIMIT ?';
    params.push(Math.min(parseInt(limit), 200));
    localPosts.push(...db.prepare(sql).all(...params));
  }

  // 2. Posts publicados do Instagram
  if (account && (source === 'all' || source === 'remote')) {
    try {
      const fields = 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink';
      const allData = [];
      let after = null;
      for (let i = 0; i < 4; i++) {
        const params = { fields, limit: 50 };
        if (after) params.after = after;
        const media = await mfGet(`/${account.ig_user_id}/media`, params, account.id);
        if (!media?.data?.length) break;
        allData.push(...media.data);
        if (from) {
          const lastTs = new Date(media.data[media.data.length - 1].timestamp).getTime();
          if (lastTs < new Date(from).getTime()) break;
        }
        after = media.paging?.cursors?.after;
        if (!after) break;
      }

      for (const m of allData) {
        const imgUrl = (m.media_type === 'VIDEO' || m.media_type === 'REEL') ? (m.thumbnail_url || m.media_url) : m.media_url;
        remotePosts.push({
          id: `ig_${m.id}`,
          ig_media_id: m.id,
          caption: m.caption || '',
          media_type: m.media_type,
          media_url: imgUrl,
          status: 'published',
          published_at: m.timestamp,
          permalink: m.permalink,
          like_count: m.like_count || 0,
          comments_count: m.comments_count || 0,
        });
      }
    } catch (e) {
      // não quebra; só log
      console.warn('[posts] Erro ao buscar Instagram:', e.message);
    }
  }

  // Filtro por data aplicado aos remotos também
  let combined = [...localPosts, ...remotePosts];
  if (from) combined = combined.filter(p => {
    const d = p.published_at || p.scheduled_for || p.created_at;
    return d >= from;
  });
  if (to) combined = combined.filter(p => {
    const d = p.published_at || p.scheduled_for || p.created_at;
    return d <= to + 'T23:59:59';
  });

  // Ordenar
  combined.sort((a, b) => {
    const da = new Date(a.published_at || a.scheduled_for || a.created_at).getTime();
    const db_ = new Date(b.published_at || b.scheduled_for || b.created_at).getTime();
    return db_ - da;
  });

  res.json({ posts: combined, account });
});

// ─── CRIAR RASCUNHO / AGENDAMENTO / APROVAÇÃO ─────────────
router.post('/', requireAuth, (req, res) => {
  const { accountId, caption, hashtags, mediaUrl, mediaType = 'IMAGE', status = 'draft', scheduledFor } = req.body || {};

  if (!['draft', 'pending', 'scheduled'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido para criação' });
  }
  if (!caption && !mediaUrl) {
    return res.status(400).json({ error: 'Legenda ou mídia obrigatória' });
  }

  const account = accountId ? getUserAccount(req.user.id, parseInt(accountId)) : getPrimaryAccount(req.user.id);
  if (!account) return res.status(400).json({ error: 'Nenhuma conta Instagram conectada' });

  if (status === 'scheduled' && !scheduledFor) {
    return res.status(400).json({ error: 'Data de agendamento obrigatória' });
  }

  const result = db.prepare(`
    INSERT INTO posts (user_id, ig_account_id, caption, hashtags, media_url, media_type, status, scheduled_for, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, account.id,
    caption || '', hashtags || '', mediaUrl || null, mediaType,
    status, scheduledFor || null, req.user.id
  );

  auditLog(req.user.id, `post.create.${status}`, { entityId: String(result.lastInsertRowid) });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(result.lastInsertRowid);
  res.json({ post });
});

// ─── ATUALIZAR POST ───────────────────────────────────────
router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!post) return res.status(404).json({ error: 'Post não encontrado' });
  if (post.status === 'published') return res.status(400).json({ error: 'Post já publicado não pode ser editado' });

  const { caption, hashtags, mediaUrl, mediaType, scheduledFor, status } = req.body || {};
  const fields = [];
  const values = [];
  if (caption !== undefined)      { fields.push('caption = ?');       values.push(caption); }
  if (hashtags !== undefined)     { fields.push('hashtags = ?');      values.push(hashtags); }
  if (mediaUrl !== undefined)     { fields.push('media_url = ?');     values.push(mediaUrl); }
  if (mediaType !== undefined)    { fields.push('media_type = ?');    values.push(mediaType); }
  if (scheduledFor !== undefined) { fields.push('scheduled_for = ?'); values.push(scheduledFor); }
  if (status !== undefined && ['draft', 'pending', 'scheduled', 'approved', 'rejected'].includes(status)) {
    fields.push('status = ?'); values.push(status);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  db.prepare(`UPDATE posts SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  res.json({ post: db.prepare('SELECT * FROM posts WHERE id = ?').get(id) });
});

// ─── EXCLUIR ──────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const result = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ? AND status != ?')
    .run(id, req.user.id, 'published');
  if (!result.changes) return res.status(404).json({ error: 'Post não encontrado ou já publicado' });
  auditLog(req.user.id, 'post.delete', { entityId: String(id) });
  res.json({ ok: true });
});

// ─── APROVAR ──────────────────────────────────────────────
router.post('/:id/approve', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!post) return res.status(404).json({ error: 'Não encontrado' });
  if (post.status !== 'pending') return res.status(400).json({ error: 'Post não está pendente' });

  db.prepare(`
    UPDATE posts SET status = ?, approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(post.scheduled_for ? 'scheduled' : 'approved', req.user.id, id);
  auditLog(req.user.id, 'post.approve', { entityId: String(id) });
  res.json({ ok: true });
});

router.post('/:id/reject', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { reason } = req.body || {};
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!post) return res.status(404).json({ error: 'Não encontrado' });
  db.prepare(`
    UPDATE posts SET status = 'rejected', rejected_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(reason || null, id);
  auditLog(req.user.id, 'post.reject', { entityId: String(id) });
  res.json({ ok: true });
});

// ─── PUBLICAR AGORA ───────────────────────────────────────
router.post('/publish', requireAuth, async (req, res) => {
  const { postId, accountId, caption, mediaUrl, mediaType = 'IMAGE' } = req.body || {};

  let post = null;
  let account = null;
  let finalCaption = caption;
  let finalMediaUrl = mediaUrl;
  let finalMediaType = mediaType;

  if (postId) {
    post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(parseInt(postId), req.user.id);
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    account = getUserAccount(req.user.id, post.ig_account_id);
    finalCaption = post.caption + (post.hashtags ? '\n\n' + post.hashtags : '');
    finalMediaUrl = post.media_url;
    finalMediaType = post.media_type;
  } else {
    account = accountId ? getUserAccount(req.user.id, parseInt(accountId)) : getPrimaryAccount(req.user.id);
  }

  if (!account) return res.status(400).json({ error: 'Conta Instagram não encontrada' });
  if (!finalMediaUrl) return res.status(400).json({ error: 'URL da mídia obrigatória' });

  try {
    if (post) {
      db.prepare('UPDATE posts SET status = ? WHERE id = ?').run('publishing', post.id);
    }

    const result = await publishPost({
      igUserId: account.ig_user_id,
      igAccountId: account.id,
      mediaUrl: finalMediaUrl,
      caption: finalCaption,
      mediaType: finalMediaType,
    });

    if (post) {
      db.prepare(`
        UPDATE posts SET status = 'published', ig_media_id = ?, published_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(result.mediaId, post.id);
    }

    auditLog(req.user.id, 'post.publish', { entityId: result.mediaId });
    res.json({ ok: true, mediaId: result.mediaId });
  } catch (e) {
    if (post) {
      db.prepare('UPDATE posts SET status = ?, error_message = ? WHERE id = ?')
        .run('failed', e.message, post.id);
    }
    res.status(502).json({ error: `Erro Meta: ${e.message}`, code: e.code, metaError: e.metaError });
  }
});

// ─── COMENTÁRIOS DE UM POST IG ────────────────────────────
router.get('/:mediaId/comments', requireAuth, async (req, res) => {
  const mediaId = req.params.mediaId.replace(/^ig_/, '');
  const primary = getPrimaryAccount(req.user.id);
  if (!primary) return res.status(400).json({ error: 'Sem conta IG' });
  try {
    const data = await mfGet(`/${mediaId}/comments`, {
      fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}',
      limit: 30,
    }, primary.id);
    res.json({ comments: data.data || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── RESPONDER COMENTÁRIO ─────────────────────────────────
router.post('/comments/:commentId/reply', requireAuth, async (req, res) => {
  const commentId = req.params.commentId;
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
  const primary = getPrimaryAccount(req.user.id);
  if (!primary) return res.status(400).json({ error: 'Sem conta IG' });
  try {
    const { mfPost } = require('../lib/meta');
    const r = await mfPost(`/${commentId}/replies`, { message }, primary.id);
    auditLog(req.user.id, 'comment.reply', { entityId: commentId });
    res.json({ ok: true, id: r.id });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
