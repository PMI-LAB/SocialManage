// server.js — Entry point do PMI Social Manager
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const db = require('./lib/db');
const scheduler = require('./lib/scheduler');

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── VALIDAÇÃO DE ENV ──────────────────────────────────────
const required = ['JWT_SECRET', 'ENCRYPTION_KEY'];
const missing = required.filter(k => !process.env[k] || process.env[k].includes('troque'));
if (missing.length) {
  console.error('\n❌ Variáveis de ambiente faltando ou não configuradas:');
  missing.forEach(k => console.error(`   - ${k}`));
  console.error('\nCopie .env.example para .env e configure os valores.\n');
  console.error('Gere chaves com:');
  console.error('  JWT_SECRET:     node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  console.error('  ENCRYPTION_KEY: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
  process.exit(1);
}

if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('❌ ENCRYPTION_KEY deve ter exatamente 64 caracteres hex (32 bytes)');
  process.exit(1);
}

// ─── MIDDLEWARES GLOBAIS ───────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // desativado pois usamos CDNs (Chart.js, FontAwesome, Google Fonts)
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: NODE_ENV === 'production' ? false : true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.set('trust proxy', 1);

// ─── ROTAS API ─────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/instagram',  require('./routes/instagram'));
app.use('/api/posts',      require('./routes/posts'));
app.use('/api/insights',   require('./routes/insights'));
app.use('/api/inbox',      require('./routes/inbox'));
app.use('/api/ai',         require('./routes/ai'));
app.use('/api/users',      require('./routes/users'));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: '1.0.0',
    env: NODE_ENV,
    time: new Date().toISOString(),
    ai_enabled: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ─── FRONTEND ──────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (!fs.existsSync(PUBLIC_DIR)) {
  console.warn(`⚠️  Pasta public/ não encontrada em ${PUBLIC_DIR}`);
} else {
  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: NODE_ENV === 'production' ? '1d' : 0,
  }));

  app.get('/',           (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get('/login',      (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get('/signup',     (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));
  app.get('/onboarding', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'onboarding.html')));
  app.get('/app',        (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app', 'index.html')));
  app.get('/app/*',      (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app', 'index.html')));
}

// ─── ERROR HANDLERS ────────────────────────────────────────
app.use((req, res, _next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint não encontrado' });
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    error: NODE_ENV === 'production' ? 'Erro interno' : err.message,
  });
});

// ─── INICIAR ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   🚀  PMI SOCIAL MANAGER                          ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`   Ambiente:    ${NODE_ENV}`);
  console.log(`   Servidor:    http://localhost:${PORT}`);
  console.log(`   API:         http://localhost:${PORT}/api/health`);
  console.log(`   IA:          ${process.env.ANTHROPIC_API_KEY ? '✓ habilitada' : '✗ desabilitada'}`);
  console.log(`   DB:          ${process.env.DB_PATH || './db/pmi.sqlite'}`);
  console.log('');

  scheduler.start(60_000);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => { console.log('\n👋 Encerrando...'); server.close(() => process.exit(0)); });
