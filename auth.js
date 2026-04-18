// routes/auth.js — Cadastro, login, logout
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const { signToken, requireAuth, revokeToken, auditLog } = require('../lib/auth');

const router = express.Router();

// Rate limiting nas rotas sensíveis
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
});

function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    path: '/',
  };
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// ─── CADASTRO ─────────────────────────────────────────────
router.post('/signup', authLimiter, async (req, res) => {
  const { email, password, name, company, phone, plan } = req.body || {};

  if (!validEmail(email)) return res.status(400).json({ error: 'Email inválido' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });
  }
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Nome inválido' });
  }
  const validPlans = ['starter', 'pro', 'agency'];
  const chosenPlan = validPlans.includes(plan) ? plan : 'starter';

  // Email já existe?
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email já cadastrado' });

  const hash = await bcrypt.hash(password, 11);
  const result = db.prepare(`
    INSERT INTO users (email, name, password_hash, role, plan, company, phone)
    VALUES (?, ?, ?, 'client', ?, ?, ?)
  `).run(email.toLowerCase(), name.trim(), hash, chosenPlan, company || null, phone || null);

  const user = db.prepare('SELECT id, email, name, role, plan, status FROM users WHERE id = ?').get(result.lastInsertRowid);
  const { token } = signToken(user);
  res.cookie('auth', token, cookieOpts());

  auditLog(user.id, 'user.signup', { ip: req.ip, ua: req.get('user-agent') });

  res.json({ user, token });
});

// ─── LOGIN ────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

  const user = db.prepare(`
    SELECT id, email, name, password_hash, role, plan, status FROM users WHERE email = ?
  `).get(email.toLowerCase());

  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Credenciais inválidas' });

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, status: user.status };
  const { token } = signToken(publicUser);
  res.cookie('auth', token, cookieOpts());

  auditLog(user.id, 'user.login', { ip: req.ip, ua: req.get('user-agent') });

  res.json({ user: publicUser, token });
});

// ─── LOGOUT ───────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  try {
    const payload = req.tokenPayload;
    const exp = new Date(payload.exp * 1000).toISOString();
    revokeToken(payload.jti, req.user.id, exp);
  } catch { /* não bloquear */ }
  res.clearCookie('auth', { path: '/' });
  res.json({ ok: true });
});

// ─── ME (usuário atual) ───────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  // Contar contas IG conectadas
  const igCount = db.prepare('SELECT COUNT(*) as c FROM instagram_accounts WHERE user_id = ?').get(req.user.id).c;
  res.json({ user: { ...req.user, ig_accounts_count: igCount } });
});

// ─── ALTERAR SENHA ────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Nova senha deve ter 8+ caracteres' });

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Senha atual incorreta' });

  const hash = await bcrypt.hash(newPassword, 11);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);

  auditLog(req.user.id, 'user.password_change', { ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
