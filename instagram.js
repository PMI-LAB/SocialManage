// routes/instagram.js — Conectar IG, listar contas, perfil
const express = require('express');
const db = require('../lib/db');
const { encrypt } = require('../lib/crypto');
const { discoverIgAccount, validateToken, mfGet } = require('../lib/meta');
const { requireAuth, auditLog } = require('../lib/auth');

const router = express.Router();

// ─── CONECTAR CONTA IG (via token pasted) ──────────────────
router.post('/connect', requireAuth, async (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken || accessToken.length < 20) {
    return res.status(400).json({ error: 'Token inválido' });
  }

  // Validar token
  const check = await validateToken(accessToken);
  if (!check.valid) {
    return res.status(400).json({ error: `Token inválido: ${check.error}` });
  }

  // Descobrir conta IG
  const discovered = await discoverIgAccount(accessToken);
  if (!discovered) {
    return res.status(400).json({
      error: 'Não foi possível localizar uma conta Instagram Business vinculada a este token. ' +
             'Verifique se o token tem as permissões: instagram_basic, pages_show_list, instagram_manage_insights.'
    });
  }

  const { igUserId, pageId, profile } = discovered;

  // Criptografar token
  const { ciphertext, iv, tag } = encrypt(accessToken);

  // Conta já existe para este usuário?
  const existing = db.prepare(`
    SELECT id FROM instagram_accounts WHERE user_id = ? AND ig_user_id = ?
  `).get(req.user.id, igUserId);

  if (existing) {
    // Atualizar token
    db.prepare(`
      UPDATE instagram_accounts SET
        encrypted_token = ?, token_iv = ?, token_tag = ?,
        page_id = ?, username = ?, display_name = ?, profile_picture_url = ?,
        followers_count = ?, follows_count = ?, media_count = ?,
        biography = ?, website = ?,
        last_synced_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      ciphertext, iv, tag,
      pageId, profile.username, profile.name || '',
      profile.profile_picture_url || null,
      profile.followers_count || 0, profile.follows_count || 0, profile.media_count || 0,
      profile.biography || null, profile.website || null,
      existing.id
    );
    auditLog(req.user.id, 'ig.reconnect', { entityId: String(existing.id) });
    return res.json({ ok: true, accountId: existing.id, username: profile.username, reconnected: true });
  }

  // Se é a primeira conta, marcar como primária
  const hasAny = db.prepare('SELECT COUNT(*) as c FROM instagram_accounts WHERE user_id = ?').get(req.user.id).c;
  const isPrimary = hasAny === 0 ? 1 : 0;

  const result = db.prepare(`
    INSERT INTO instagram_accounts
    (user_id, ig_user_id, page_id, username, display_name, profile_picture_url,
     followers_count, follows_count, media_count, biography, website,
     encrypted_token, token_iv, token_tag, is_primary, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    req.user.id, igUserId, pageId,
    profile.username, profile.name || '', profile.profile_picture_url || null,
    profile.followers_count || 0, profile.follows_count || 0, profile.media_count || 0,
    profile.biography || null, profile.website || null,
    ciphertext, iv, tag, isPrimary
  );

  auditLog(req.user.id, 'ig.connect', { entityId: String(result.lastInsertRowid), metadata: { username: profile.username } });
  res.json({ ok: true, accountId: result.lastInsertRowid, username: profile.username });
});

// ─── LISTAR CONTAS IG DO USUÁRIO ──────────────────────────
router.get('/accounts', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, ig_user_id, username, display_name, profile_picture_url,
           followers_count, follows_count, media_count, biography, website,
           is_primary, last_synced_at, created_at
    FROM instagram_accounts
    WHERE user_id = ?
    ORDER BY is_primary DESC, created_at ASC
  `).all(req.user.id);
  res.json({ accounts: rows });
});

// ─── DESCONECTAR CONTA ────────────────────────────────────
router.delete('/accounts/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT id FROM instagram_accounts WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Conta não encontrada' });
  db.prepare('DELETE FROM instagram_accounts WHERE id = ?').run(id);
  auditLog(req.user.id, 'ig.disconnect', { entityId: String(id) });
  res.json({ ok: true });
});

// ─── DEFINIR CONTA PRIMÁRIA ───────────────────────────────
router.post('/accounts/:id/primary', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT id FROM instagram_accounts WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Conta não encontrada' });
  db.prepare('UPDATE instagram_accounts SET is_primary = 0 WHERE user_id = ?').run(req.user.id);
  db.prepare('UPDATE instagram_accounts SET is_primary = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── SYNC PERFIL (re-busca dados na Meta) ─────────────────
router.post('/accounts/:id/sync', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const acc = db.prepare(`
    SELECT id, ig_user_id FROM instagram_accounts WHERE id = ? AND user_id = ?
  `).get(id, req.user.id);
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });

  try {
    const profile = await mfGet(`/${acc.ig_user_id}`, {
      fields: 'id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website'
    }, id);

    db.prepare(`
      UPDATE instagram_accounts SET
        username = ?, display_name = ?, profile_picture_url = ?,
        followers_count = ?, follows_count = ?, media_count = ?,
        biography = ?, website = ?, last_synced_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      profile.username, profile.name || '',
      profile.profile_picture_url || null,
      profile.followers_count || 0, profile.follows_count || 0, profile.media_count || 0,
      profile.biography || null, profile.website || null, id
    );

    res.json({ ok: true, profile });
  } catch (e) {
    res.status(502).json({ error: `Erro Meta: ${e.message}` });
  }
});

module.exports = router;
