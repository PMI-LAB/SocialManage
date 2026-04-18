PMI Social Manager
Plataforma multi-tenant de gestão de Instagram para agências e profissionais de marketing. Backend Node.js + SQLite + frontend vanilla, integração direta com Meta Graph API.
Features
Multi-tenant: cada cliente em seu workspace isolado, permissões por papel (admin/manager/client)
Auth seguro: bcrypt + JWT em httpOnly cookie, tokens revogáveis
Tokens Meta criptografados: AES-256-GCM no banco, nunca expostos ao frontend
Agendamento: worker em background publica posts no horário marcado
IA: integração com Claude para gerar legendas e hashtags
Analytics: dados oficiais da Meta Graph API com cache inteligente
Inbox unificado: DMs, comentários e menções num só lugar
Aprovação: cliente revisa e aprova posts antes da publicação
---
Requisitos
Node.js 18+
npm
(opcional) Conta na Anthropic para usar IA
---
Instalação rápida
```bash
# 1. Entrar no backend e instalar dependências
cd backend
npm install

# 2. Copiar .env.example para .env e configurar
cp .env.example .env

# 3. Gerar as chaves criptográficas obrigatórias
echo "JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")" >> .env.tmp
echo "ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env.tmp
# (cole esses valores no .env, substituindo os placeholders "troque_...")

# 4. Inicializar banco e criar admin padrão
npm run init-db

# 5. Iniciar servidor
npm start
```
Acesse: http://localhost:3000
Login do admin padrão
Email: `admin@pmi.com`
Senha: `TrocarNoPrimeiroLogin123!`
⚠️ Troque a senha imediatamente após o primeiro login (Configurações → Segurança).
---
Configuração do `.env`
Variável	Obrigatório	Descrição
`PORT`	não	Porta do servidor (padrão: 3000)
`NODE_ENV`	não	`development` ou `production`
`JWT_SECRET`	sim	64+ chars aleatórios para assinar tokens
`ENCRYPTION_KEY`	sim	Exatamente 64 chars hex (32 bytes) para AES-256
`DB_PATH`	não	Caminho do SQLite (padrão: `./db/pmi.sqlite`)
`ANTHROPIC_API_KEY`	não	Chave da Anthropic (habilita IA)
`DEFAULT_ADMIN_EMAIL`	não	Email do admin criado no init-db
`DEFAULT_ADMIN_PASSWORD`	não	Senha do admin
Gerar as chaves
```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY (deve ter EXATAMENTE 64 chars hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
> **IMPORTANTE:** se você perder a `ENCRYPTION_KEY` depois de conectar contas Instagram, **não conseguirá descriptografar os tokens** e precisará reconectá-las. Faça backup.
---
Estrutura de URLs
Rota	O que faz
`/`	Landing page pública
`/login`	Tela de login
`/signup?plan=pro`	Cadastro (aceita `?plan=starter|pro|agency`)
`/onboarding`	Conectar conta Instagram (após signup)
`/app`	App autenticado (dashboard, calendário, etc.)
`/api/*`	Endpoints REST do backend
`/api/health`	Healthcheck
---
Conectar uma conta Instagram
A plataforma usa tokens de Página do Facebook gerados manualmente (sem fluxo OAuth). Veja o tutorial em `/onboarding` ou siga estes passos:
Acesse o Graph API Explorer da Meta
Crie uma App em developers.facebook.com (caso não tenha)
Em User or Page → Get Page Access Token → escolha sua Página
Adicione as permissões:
`instagram_basic`
`instagram_content_publish`
`instagram_manage_comments`
`instagram_manage_insights`
`instagram_manage_messages`
`pages_show_list`
`pages_read_engagement`
Copie o token gerado e cole na tela de onboarding
> **Nota:** a conta Instagram precisa estar configurada como **Business** ou **Creator** (não funciona com conta pessoal).
---
Deploy em produção
Opção 1 — PM2 + Nginx (recomendado)
```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar com PM2
cd backend
NODE_ENV=production pm2 start server.js --name pmi
pm2 save
pm2 startup
```
Configuração Nginx (`/etc/nginx/sites-available/pmi`):
```nginx
server {
    listen 80;
    server_name pmi.suaempresa.com.br;

    client_max_body_size 5M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Habilitar HTTPS com Certbot:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d pmi.suaempresa.com.br
```
Opção 2 — Docker (em breve)
Um `Dockerfile` pode ser adicionado conforme necessidade.
---
Migrar SQLite → PostgreSQL
O sistema usa `better-sqlite3`. Para migrar para Postgres:
Substitua `better-sqlite3` por `pg` no `package.json`
Atualize `lib/db.js` para usar `pg.Pool`
Adapte as queries (a maioria é SQL padrão e funciona; ajuste apenas `INSERT OR IGNORE`, `datetime('now')` e tipos `BOOLEAN`)
Migre os dados com `pgloader` ou script customizado
---
Backup
Como o SQLite é um único arquivo, basta copiar `backend/db/pmi.sqlite`:
```bash
# Backup diário via cron
0 3 * * * cp /caminho/backend/db/pmi.sqlite /backups/pmi-$(date +\%Y\%m\%d).sqlite
```
---
Troubleshooting
"ENCRYPTION_KEY deve ter exatamente 64 caracteres hex"
Execute: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` e cole no `.env`.
"Não foi possível localizar conta Instagram"
Verifique se a conta IG é Business/Creator
Verifique se a Página do Facebook está vinculada à conta IG
Verifique se o token tem todas as permissões listadas acima
Posts agendados não publicam
Confirme que o servidor está rodando (o scheduler roda a cada 60s)
Veja logs: `pm2 logs pmi`
Teste manualmente: na tela de Posts, edite o post agendado e use "Publicar agora"
IA não funciona
Configure `ANTHROPIC_API_KEY` no `.env`
Reinicie o servidor: `pm2 restart pmi`
---
Estrutura do projeto
```
pmi-social-manager/
├── backend/
│   ├── server.js              # Entry point Express
│   ├── package.json
│   ├── .env.example
│   ├── db/
│   │   ├── schema.sql         # Schema SQLite
│   │   └── pmi.sqlite         # (gerado em runtime)
│   ├── lib/
│   │   ├── db.js              # Conexão SQLite
│   │   ├── crypto.js          # AES-256-GCM
│   │   ├── meta.js            # Wrapper Meta Graph API
│   │   ├── auth.js            # JWT middleware
│   │   ├── scheduler.js       # Worker de posts agendados
│   │   └── init-db.js         # Setup inicial
│   └── routes/
│       ├── auth.js            # /api/auth/*
│       ├── instagram.js       # /api/instagram/*
│       ├── posts.js           # /api/posts/*
│       ├── insights.js        # /api/insights/*
│       ├── inbox.js           # /api/inbox/*
│       ├── ai.js              # /api/ai/*
│       └── users.js           # /api/users/*
└── public/
    ├── index.html             # Landing page
    ├── login.html
    ├── signup.html
    ├── onboarding.html
    ├── app/index.html         # App autenticado
    └── assets/js/api.js       # Cliente HTTP
```
---
Segurança
Senhas com bcrypt (cost 11)
JWT em httpOnly cookie (não acessível via JS, protege contra XSS)
Tokens Meta criptografados com AES-256-GCM antes de ir ao banco
Rate limiting nas rotas de auth
Helmet para headers de segurança
CORS bloqueado em produção (mesmo origin apenas)
Validação rigorosa de input em todas as rotas
---
Licença
Proprietário — © 2026 PMI Marketing Integrado. Não afiliado à Meta Platforms, Inc.
---
Suporte
Para reportar bugs ou solicitar features, abra uma issue interna ou contate a equipe de desenvolvimento.
