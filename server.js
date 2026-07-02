/**
 * AMAT-CI — Serveur cloud (Render.com)
 * Variables d'environnement :
 *   ANTHROPIC_API_KEY = votre clé sk-ant-api03-...  (Claude)
 *   GEMINI_API_KEY    = votre clé AIza...            (Gemini, gratuit — format AIza uniquement)
 *   GROQ_API_KEY      = votre clé gsk_...            (Groq/Llama, gratuit)
 *
 * Priorité auto : Claude → Groq → Gemini
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────
function loadConfigFile() {
  const f = path.join(__dirname, 'config.txt');
  if (!fs.existsSync(f)) return {};
  const cfg = {};
  fs.readFileSync(f, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) cfg[m[1].trim()] = m[2].trim();
  });
  return cfg;
}

const config = loadConfigFile();
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || config.ANTHROPIC_API_KEY || '';
let GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || config.GEMINI_API_KEY    || '';
let GROQ_API_KEY      = process.env.GROQ_API_KEY      || config.GROQ_API_KEY      || '';
const PORT = parseInt(process.env.PORT || config.PORT) || 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

// ─── Appel Anthropic (Claude) ─────────────────────────────────────────────────
function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) return reject(new Error('Clé Claude non configurée'));
    const bodyStr = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, resp => {
      let data = '';
      resp.on('data', c => (data += c));
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('Réponse Anthropic invalide')); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Appel Google Gemini ──────────────────────────────────────────────────────
function claudeMessagesToGeminiParts(messages) {
  // Convertit le format Claude → format Gemini
  const parts = [];
  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ text: part.text });
      } else if (part.type === 'image' && part.source?.type === 'base64') {
        parts.push({ inline_data: { mime_type: part.source.media_type, data: part.source.data } });
      } else if (part.type === 'document' && part.source?.type === 'base64') {
        parts.push({ inline_data: { mime_type: 'application/pdf', data: part.source.data } });
      }
    }
  }
  return parts;
}

function callGemini(messages, geminiKey) {
  return new Promise((resolve, reject) => {
    const key = geminiKey || GEMINI_API_KEY;
    if (!key) return reject(new Error('Clé Gemini non configurée — définissez GEMINI_API_KEY ou entrez-la dans la plateforme'));

    const parts = claudeMessagesToGeminiParts(messages);
    const payload = {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.1 }
    };
    const bodyStr = JSON.stringify(payload);
    const apiPath = `/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, resp => {
      let data = '';
      resp.on('data', c => (data += c));
      resp.on('end', () => {
        try {
          const geminiResp = JSON.parse(data);
          if (resp.statusCode !== 200) {
            const errMsg = geminiResp.error?.message || JSON.stringify(geminiResp).substring(0, 200);
            return resolve({ status: resp.statusCode, body: { error: { message: 'Gemini: ' + errMsg } } });
          }
          // Normaliser en format Claude pour que le frontend n'ait pas à changer
          const text = geminiResp.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
          const claudeFormat = {
            id: 'gemini-' + Date.now(),
            type: 'message',
            role: 'assistant',
            model: 'gemini-2.0-flash',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            _provider: 'gemini'
          };
          resolve({ status: 200, body: claudeFormat });
        } catch (e) {
          reject(new Error('Réponse Gemini invalide: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Appel Groq (Llama vision) ───────────────────────────────────────────────
function claudeMessagesToGroqMessages(messages) {
  return messages.map(msg => {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    const groqContent = content.map(part => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image' && part.source?.type === 'base64') {
        return { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } };
      }
      if (part.type === 'document' && part.source?.type === 'base64') {
        return { type: 'text', text: '[Document PDF joint — extraire les données de facturation]' };
      }
      return null;
    }).filter(Boolean);
    // Si un seul élément texte, renvoyer directement la string
    const simplified = groqContent.length === 1 && groqContent[0].type === 'text'
      ? groqContent[0].text
      : groqContent;
    return { role: msg.role, content: simplified };
  });
}

function callGroq(messages, groqKey) {
  return new Promise((resolve, reject) => {
    const key = groqKey || GROQ_API_KEY;
    if (!key) return reject(new Error('Clé Groq non configurée — inscrivez-vous sur groq.com et entrez votre clé gsk_...'));

    const groqMessages = claudeMessagesToGroqMessages(messages);
    const payload = {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: groqMessages,
      max_tokens: 8192,
      temperature: 0.1
    };
    const bodyStr = JSON.stringify(payload);

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, resp => {
      let data = '';
      resp.on('data', c => (data += c));
      resp.on('end', () => {
        try {
          const groqResp = JSON.parse(data);
          if (resp.statusCode !== 200) {
            const errMsg = groqResp.error?.message || JSON.stringify(groqResp).substring(0, 200);
            return resolve({ status: resp.statusCode, body: { error: { message: 'Groq: ' + errMsg } } });
          }
          const text = groqResp.choices?.[0]?.message?.content || '';
          const claudeFormat = {
            id: 'groq-' + Date.now(),
            type: 'message',
            role: 'assistant',
            model: 'llama-4-scout',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            _provider: 'groq'
          };
          resolve({ status: 200, body: claudeFormat });
        } catch (e) {
          reject(new Error('Réponse Groq invalide: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Sélection automatique du fournisseur ────────────────────────────────────
async function callAI(messages, provider, geminiKey, groqKey) {
  // provider = 'auto' | 'claude' | 'gemini' | 'groq'
  const hasAnthropic = !!ANTHROPIC_API_KEY;
  const hasGemini    = !!(geminiKey || GEMINI_API_KEY);
  const hasGroq      = !!(groqKey || GROQ_API_KEY);

  if (provider === 'gemini') return callGemini(messages, geminiKey);
  if (provider === 'claude') return callAnthropic({ model: 'claude-sonnet-4-6', max_tokens: 8096, messages });
  if (provider === 'groq')   return callGroq(messages, groqKey);

  // Auto : Claude → Groq → Gemini
  if (hasAnthropic) {
    try { return await callAnthropic({ model: 'claude-sonnet-4-6', max_tokens: 8096, messages }); }
    catch (e) {
      if (hasGroq) {
        console.log('[Auto] Claude échoué, bascule Groq:', e.message);
        return callGroq(messages, groqKey);
      }
      if (hasGemini) {
        console.log('[Auto] Claude échoué, bascule Gemini:', e.message);
        return callGemini(messages, geminiKey);
      }
      throw e;
    }
  }
  if (hasGroq)   return callGroq(messages, groqKey);
  if (hasGemini) return callGemini(messages, geminiKey);
  throw new Error('Aucune clé API configurée — ajoutez GROQ_API_KEY (gratuit sur groq.com) dans les variables Render');
}

// ─── Serveur ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Santé
  if (req.method === 'GET' && req.url === '/health') {
    const hasC = !!ANTHROPIC_API_KEY, hasG = !!GEMINI_API_KEY, hasGr = !!GROQ_API_KEY;
    const provider = hasC ? 'claude' : hasGr ? 'groq' : hasG ? 'gemini' : 'none';
    return sendJSON(res, 200, {
      status: 'ok',
      apiKeyConfigured: !!(hasC || hasG || hasGr),
      claudeKey: hasC,
      geminiKey: hasG,
      groqKey: hasGr,
      provider
    });
  }

  // Plateforme HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/plateforme.html')) {
    const htmlPath = path.join(__dirname, 'plateforme.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
    return sendJSON(res, 404, { error: 'plateforme.html introuvable' });
  }

  // Base bénéficiaires
  if (req.method === 'GET' && req.url === '/beneficiaires.js') {
    const bPath = path.join(__dirname, 'beneficiaires.js');
    if (fs.existsSync(bPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(fs.readFileSync(bPath));
    }
    return sendJSON(res, 404, { error: 'beneficiaires.js introuvable' });
  }

  // Proxy IA (Claude ou Gemini)
  if (req.method === 'POST' && req.url === '/analyser') {
    try {
      const body = await readBody(req);
      if (!body.messages || !Array.isArray(body.messages))
        return sendJSON(res, 400, { error: "Champ 'messages' requis" });

      const provider  = body.provider   || 'auto';
      const geminiKey = body.gemini_key  || '';
      const groqKey   = body.groq_key    || '';

      const providerLabel = provider === 'auto'
        ? (ANTHROPIC_API_KEY ? 'Claude (auto)' : GROQ_API_KEY ? 'Groq (auto)' : 'Gemini (auto)')
        : provider;
      console.log(`[${new Date().toLocaleTimeString('fr-FR')}] Analyse — ${providerLabel}`);

      const result = await callAI(body.messages, provider, geminiKey, groqKey);
      if (result.status !== 200)
        console.error('[IA] Erreur', result.status, JSON.stringify(result.body).substring(0, 200));
      return sendJSON(res, result.status, result.body);
    } catch (err) {
      console.error('Erreur:', err.message);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // Enregistrer clé API (session)
  if (req.method === 'POST' && req.url === '/set-key') {
    try {
      const body = await readBody(req);
      if (body.key)    { ANTHROPIC_API_KEY = body.key.trim(); }
      if (body.gemini) { GEMINI_API_KEY    = body.gemini.trim(); }
      if (body.groq)   { GROQ_API_KEY      = body.groq.trim(); }
      return sendJSON(res, 200, { ok: true, note: 'Clé(s) active(s) pour cette session.' });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  sendJSON(res, 404, { error: 'Route inconnue' });
});

server.listen(PORT, '0.0.0.0', () => {
  const hasC = !!ANTHROPIC_API_KEY, hasG = !!GEMINI_API_KEY, hasGr = !!GROQ_API_KEY;
  const modeStr = hasC && hasGr ? 'Claude → Groq (fallback)' : hasC ? 'Claude uniquement' : hasGr ? 'Groq uniquement' : hasG ? 'Gemini uniquement' : '⚠ AUCUNE CLÉ';
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║              AMAT-CI — Plateforme active                 ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Port           : ${String(PORT).padEnd(40)}║`);
  console.log(`║  Claude (Ant.)  : ${(hasC  ? '✅ configuré' : '❌ ANTHROPIC_API_KEY manquante').padEnd(40)}║`);
  console.log(`║  Groq  (Llama)  : ${(hasGr ? '✅ configuré' : '❌ GROQ_API_KEY manquante').padEnd(40)}║`);
  console.log(`║  Gemini (Google): ${(hasG  ? '✅ configuré' : '❌ GEMINI_API_KEY manquante').padEnd(40)}║`);
  console.log(`║  Mode           : ${modeStr.padEnd(40)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
