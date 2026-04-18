// routes/users.js — Admin: gerenciar usuários
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { requireAuth, requireRole, auditLog } = require('../lib/auth');

const router = express.Router();

// Todas as rotas aqui exigem admin ou manager
router.use(requireAuth);
router.use(requireRole('admin', 'manager'));

// ─── LISTAR ───────────────────────────────────────────────
router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.plan, u.status, u.company, u.phone,
           u.created_at, u.last_login_at,
           (SELECT COUNT(*) FROM instagram_accounts WHERE user_id = u.id) as ig_accounts_count,
           (SELECT COUNT(*) FROM posts WHERE user_id = u.id AND status = 'published') as posts_count
    FROM users u
    WHERE u.status != 'deleted'
    ORDER BY u.created_at DESC
  `).all();
  res.json({ users });
});

// ─── CRIAR ────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { email, name, password, role = 'client', plan = 'starter', company } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (password.length < 8) return res.status(400).json({ error: 'Senha mínimo 8 caracteres' });
  if (!['admin', 'manager', 'client'].includes(role)) return res.status(400).json({ error: 'Role inválido' });
  if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Somente admins criam admins' });

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email já cadastrado' });

  const hash = await bcrypt.hash(password, 11);
  const result = db.prepare(`
    INSERT INTO users (email, name, password_hash, role, plan, company)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email.toLowerCase(), name.trim(), hash, role, plan, company || null);

  auditLog(req.user.id, 'admin.user.create', { entityId: String(result.lastInsertRowid) });
  res.json({ id: result.lastInsertRowid, email, name, role, plan });
});

// ─── ATUALIZAR ────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });

  const { name, role, plan, status, company, phone, password } = req.body || {};
  const fields = [];
  const values = [];

  if (name)    { fields.push('name = ?');    values.push(name.trim()); }
  if (role && ['admin', 'manager', 'client'].includes(role)) {
    if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Somente admin pode criar admin' });
    fields.push('role = ?'); values.push(role);
  }
  if (plan)    { fields.push('plan = ?');    values.push(plan); }
  if (status && ['active', 'suspended'].includes(status)) { fields.push('status = ?'); values.push(status); }
  if (company !== undefined) { fields.push('company = ?'); values.push(company); }
  if (phone !== undefined)   { fields.push('phone = ?');   values.push(phone); }
  if (password && password.length >= 8) {
    const hash = await bcrypt.hash(password, 11);
    fields.push('password_hash = ?'); values.push(hash);
  }

  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  auditLog(req.user.id, 'admin.user.update', { entityId: String(id) });
  res.json({ ok: true });
});

// ─── DELETAR (soft delete) ────────────────────────────────
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  db.prepare("UPDATE users SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  auditLog(req.user.id, 'admin.user.delete', { entityId: String(id) });
  res.json({ ok: true });
});

module.exports = router;
