// routes/ai.js — Geração de legendas e hashtags via Anthropic (server-side)
const express = require('express');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

async function callClaude(prompt, maxTokens = 500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('IA desabilitada: configure ANTHROPIC_API_KEY no .env');
    err.status = 503;
    throw err;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  return data?.content?.[0]?.text || '';
}

// ─── GERAR LEGENDA ────────────────────────────────────────
router.post('/caption', requireAuth, async (req, res) => {
  const { description, tone = 'profissional', niche = 'marketing digital', username = '' } = req.body || {};
  if (!description) return res.status(400).json({ error: 'Descrição obrigatória' });

  const prompt = `Você é um especialista em copywriting para Instagram.
Crie UMA legenda completa e profissional para um post do Instagram sobre: "${description}"

Perfil: ${username || 'marca'}
Segmento: ${niche}
Tom de voz: ${tone}

A legenda deve ter:
- Gancho forte na primeira linha (stopping the scroll)
- Texto envolvente e conversacional (2-4 parágrafos curtos)
- Chamada para ação clara no final
- Emojis estratégicos (não exagerar)

IMPORTANTE: Responda APENAS a legenda final, sem explicações, sem aspas, sem prefixos tipo "Legenda:".`;

  try {
    const text = await callClaude(prompt, 500);
    res.json({ caption: text.trim() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── GERAR HASHTAGS ───────────────────────────────────────
router.post('/hashtags', requireAuth, async (req, res) => {
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'Tópico obrigatório' });

  const prompt = `Gere exatamente 12 hashtags relevantes em português para este post do Instagram:

"${topic.substring(0, 300)}"

Regras:
- Misture 3 hashtags de alta competitividade (1M+ posts) com 6 de média (100K-1M) e 3 de nicho específico (<100K)
- Use apenas hashtags válidas (sem acentos, sem espaços, sem caracteres especiais)
- Todas em lowercase

Responda APENAS as 12 hashtags separadas por espaço, em uma única linha, sem numeração ou explicação.`;

  try {
    const text = await callClaude(prompt, 200);
    res.json({ hashtags: text.trim() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
