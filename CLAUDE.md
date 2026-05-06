# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Produção
npm run dev        # Dev com hot-reload (--watch)
npm run init-db    # Inicializa o banco SQLite e cria admin padrão
npm run create-admin  # Cria um usuário admin manualmente
```

Não há test runner configurado. Valide manualmente via `GET /api/health` após subir o servidor.

## Variáveis de ambiente obrigatórias

Copie `.env.example` → `.env` e configure:

| Variável | Requisito |
|---|---|
| `JWT_SECRET` | 64+ chars aleatórios |
| `ENCRYPTION_KEY` | Exatamente 64 chars hex (32 bytes) |
| `ANTHROPIC_API_KEY` | Opcional — habilita IA |

Gerar chaves:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
```

## Arquitetura

Monorepo flat: backend Node.js e frontend vanilla no mesmo repositório.

```
server.js          ← entry point Express; valida ENV, monta rotas, inicia scheduler
routes/            ← um arquivo por domínio (auth, instagram, posts, insights, inbox, ai, users)
lib/
  db.js            ← singleton better-sqlite3
  auth.js          ← signToken / requireAuth / requireRole / revokeToken / auditLog
  crypto.js        ← encrypt/decrypt AES-256-GCM (tokens Meta)
  meta.js          ← wrapper Meta Graph API
  scheduler.js     ← worker que publica posts agendados a cada 60s
  init-db.js       ← cria schema + admin padrão (rodado uma vez)
public/            ← frontend estático servido pelo Express
  assets/js/api.js ← cliente HTTP (window.PMIApi); usa fetch + credentials:'include'
  app/index.html   ← SPA autenticada
```

### Fluxo de autenticação

JWT assinado é armazenado em httpOnly cookie (`auth`). O middleware `requireAuth` (lib/auth.js) valida o JWT e verifica se o `jti` foi revogado (tabela `revoked_tokens`). Papéis: `admin > manager > client`.

### Tokens Meta

Tokens da Meta Graph API são criptografados com AES-256-GCM antes de persistir no SQLite (`instagram_accounts`). A `ENCRYPTION_KEY` do `.env` é usada. Se a chave for perdida após contas conectadas, os tokens se tornam irrecuperáveis.

### Conexão Instagram

Não usa OAuth — o usuário cola manualmente um Page Access Token gerado no Graph API Explorer. O backend valida o token, descobre a conta IG Business vinculada e armazena o token criptografado.

### Deploy VPS

Credenciais SSH de deploy estão em `.claude-credentials` (gitignore).

Opção recomendada: PM2 + Nginx (ver README.md para config completa).

```bash
npm install -g pm2
NODE_ENV=production pm2 start server.js --name pmi
pm2 save && pm2 startup
```
