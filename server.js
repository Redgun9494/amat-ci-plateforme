/**
 * AMAT-CI — Serveur cloud (Render.com)
 * Variables d'environnement :
 *   ANTHROPIC_API_KEY    = votre clé sk-ant-api03-...  (Claude)
 *   GEMINI_API_KEY       = votre clé AIza...            (Gemini, gratuit)
 *   GROQ_API_KEY         = votre clé gsk_...            (Groq/Llama, gratuit)
 *   MISTRAL_API_KEY      = votre clé sur console.mistral.ai  (Mistral, gratuit)
 *   OPENROUTER_API_KEY   = votre clé sk-or-...          (OpenRouter, modèles gratuits)
 *
 * Priorité auto : Gemini → Groq → Mistral → OpenRouter → Claude
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// pdf-parse : extraction texte PDF (fallback si non installé)
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch(e) { console.warn('[PDF] pdf-parse non disponible — install avec npm install pdf-parse'); }

async function extractPdfText(base64Data) {
  if (!pdfParse) return '[PDF joint — installez pdf-parse pour extraction automatique]';
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const data = await pdfParse(buffer);
    const text = (data.text || '').replace(/\s{3,}/g, '\n').trim().substring(0, 20000);
    return text || '[PDF vide ou non lisible]';
  } catch(e) {
    return '[PDF illisible : ' + e.message.substring(0, 80) + ']';
  }
}

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
let ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || config.ANTHROPIC_API_KEY  || '';
let GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || config.GEMINI_API_KEY     || '';
let GROQ_API_KEY       = process.env.GROQ_API_KEY       || config.GROQ_API_KEY       || '';
let MISTRAL_API_KEY    = process.env.MISTRAL_API_KEY    || config.MISTRAL_API_KEY    || '';
let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || config.OPENROUTER_API_KEY || '';
const PORT = parseInt(process.env.PORT || config.PORT) || 3000;

function isValidGeminiKey(key) {
  return /^(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,})$/.test(String(key || '').trim());
}
function isValidGroqKey(key) {
  return /^gsk_[0-9A-Za-z_-]{20,}$/.test(String(key || '').trim());
}
function isValidMistralKey(key) {
  return String(key || '').trim().length >= 20;
}
function isValidOpenRouterKey(key) {
  return /^sk-or-[0-9A-Za-z_-]{20,}$/.test(String(key || '').trim());
}

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
    const key = String(geminiKey || GEMINI_API_KEY || '').trim();
    if (!key) return reject(new Error('Clé Gemini non configurée — définissez GEMINI_API_KEY ou entrez-la dans la plateforme'));
    if (!isValidGeminiKey(key)) return reject(new Error('Clé Gemini invalide — créez/copiez une clé depuis Google AI Studio'));

    const parts = claudeMessagesToGeminiParts(messages);
    const payload = {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.1 }
    };
    const bodyStr = JSON.stringify(payload);
    const geminiModel = process.env.GEMINI_MODEL || config.GEMINI_MODEL || 'gemini-2.0-flash-lite';
    const apiPath = `/v1beta/models/${geminiModel}:generateContent`;

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
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
            const quotaHint = resp.statusCode === 429 ? 'Quota gratuit Gemini atteint ou non disponible pour ce projet. Essayez plus tard, utilisez un autre projet Google AI Studio, activez la facturation, ou basculez sur Groq.' : '';
            return resolve({ status: resp.statusCode, body: { error: { message: ('Gemini: ' + errMsg + (quotaHint ? ' — ' + quotaHint : '')).trim() } } });
          }
          // Normaliser en format Claude pour que le frontend n'ait pas à changer
          const text = geminiResp.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
          const claudeFormat = {
            id: 'gemini-' + Date.now(),
            type: 'message',
            role: 'assistant',
            model: geminiModel,
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
async function claudeMessagesToGroqMessages(messages) {
  const result = [];
  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    const groqContent = [];
    for (const part of content) {
      if (part.type === 'text') {
        groqContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image' && part.source?.type === 'base64') {
        groqContent.push({ type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
      } else if (part.type === 'document' && part.source?.type === 'base64') {
        // Extraction texte PDF réelle pour Groq
        const pdfText = await extractPdfText(part.source.data);
        groqContent.push({ type: 'text', text: `[Contenu PDF extrait automatiquement]\n${pdfText}` });
      }
    }
    // Si un seul élément texte, renvoyer directement la string
    const simplified = groqContent.length === 1 && groqContent[0].type === 'text'
      ? groqContent[0].text
      : groqContent;
    result.push({ role: msg.role, content: simplified });
  }
  return result;
}

function callGroq(messages, groqKey) {
  return new Promise((resolve, reject) => {
    const key = String(groqKey || GROQ_API_KEY || '').trim();
    if (!key) return reject(new Error('Clé Groq non configurée — inscrivez-vous sur groq.com et entrez votre clé gsk_...'));
    if (!isValidGroqKey(key)) return reject(new Error('Clé Groq invalide — elle doit commencer par gsk_ et provenir de console.groq.com'));

    const groqMessages = await claudeMessagesToGroqMessages(messages);
    if (!JSON.stringify(groqMessages).toLowerCase().includes('json')) {
      groqMessages.unshift({
        role: 'system',
        content: 'Reponds uniquement avec un objet JSON valide.'
      });
    }
    const payload = {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: groqMessages,
      max_tokens: 8192,
      temperature: 0.1,
      response_format: { type: 'json_object' }
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

// ─── Appel Mistral AI ─────────────────────────────────────────────────────────
async function claudeMessagesToOpenAIMessages(messages) {
  const result = [];
  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    const parts = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'document' && part.source?.type === 'base64') {
        // Extraction texte PDF pour Mistral/OpenRouter
        const pdfText = await extractPdfText(part.source.data);
        parts.push(`[Contenu PDF extrait]\n${pdfText}`);
      } else if (part.type === 'image') {
        parts.push('[Image jointe — modèle texte uniquement]');
      }
    }
    result.push({ role: msg.role, content: parts.join('\n') });
  }
  return result;
}

function callMistral(messages, mistralKey) {
  return new Promise((resolve, reject) => {
    const key = String(mistralKey || MISTRAL_API_KEY || '').trim();
    if (!key) return reject(new Error('Clé Mistral non configurée — inscrivez-vous sur console.mistral.ai'));
    if (!isValidMistralKey(key)) return reject(new Error('Clé Mistral invalide'));

    const mistralMessages = await claudeMessagesToOpenAIMessages(messages);
    if (!JSON.stringify(mistralMessages).toLowerCase().includes('json')) {
      mistralMessages.unshift({ role: 'system', content: 'Réponds uniquement avec un objet JSON valide.' });
    }
    const payload = {
      model: 'mistral-small-latest',
      messages: mistralMessages,
      max_tokens: 8192,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    };
    const bodyStr = JSON.stringify(payload);

    const req = https.request({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
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
          const r = JSON.parse(data);
          if (resp.statusCode !== 200) {
            const errMsg = r.message || r.error?.message || JSON.stringify(r).substring(0, 200);
            return resolve({ status: resp.statusCode, body: { error: { message: 'Mistral: ' + errMsg } } });
          }
          const text = r.choices?.[0]?.message?.content || '';
          resolve({ status: 200, body: { id: 'mistral-' + Date.now(), type: 'message', role: 'assistant',
            model: 'mistral-small-latest', content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'mistral' } });
        } catch (e) { reject(new Error('Réponse Mistral invalide: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Appel OpenRouter (modèles gratuits) ─────────────────────────────────────
function callOpenRouter(messages, openRouterKey) {
  return new Promise((resolve, reject) => {
    const key = String(openRouterKey || OPENROUTER_API_KEY || '').trim();
    if (!key) return reject(new Error('Clé OpenRouter non configurée — inscrivez-vous sur openrouter.ai'));
    if (!isValidOpenRouterKey(key)) return reject(new Error('Clé OpenRouter invalide (doit commencer par sk-or-)'));

    const orMessages = await claudeMessagesToOpenAIMessages(messages);
    if (!JSON.stringify(orMessages).toLowerCase().includes('json')) {
      orMessages.unshift({ role: 'system', content: 'Réponds uniquement avec un objet JSON valide.' });
    }
    const payload = {
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: orMessages,
      max_tokens: 8192,
      temperature: 0.1,
    };
    const bodyStr = JSON.stringify(payload);

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': 'https://amat-ci-plateforme.onrender.com',
        'X-Title': 'AMAT-CI',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, resp => {
      let data = '';
      resp.on('data', c => (data += c));
      resp.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (resp.statusCode !== 200) {
            const errMsg = r.error?.message || JSON.stringify(r).substring(0, 200);
            return resolve({ status: resp.statusCode, body: { error: { message: 'OpenRouter: ' + errMsg } } });
          }
          const text = r.choices?.[0]?.message?.content || '';
          resolve({ status: 200, body: { id: 'openrouter-' + Date.now(), type: 'message', role: 'assistant',
            model: 'llama-3.1-8b', content: [{ type: 'text', text }], stop_reason: 'end_turn', _provider: 'openrouter' } });
        } catch (e) { reject(new Error('Réponse OpenRouter invalide: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Sélection automatique du fournisseur ────────────────────────────────────
async function callAI(messages, provider, geminiKey, groqKey, mistralKey, openRouterKey) {
  const hasAnthropic   = !!ANTHROPIC_API_KEY;
  const hasGemini      = isValidGeminiKey(geminiKey || GEMINI_API_KEY);
  const hasGroq        = isValidGroqKey(groqKey || GROQ_API_KEY);
  const hasMistral     = isValidMistralKey(mistralKey || MISTRAL_API_KEY);
  const hasOpenRouter  = isValidOpenRouterKey(openRouterKey || OPENROUTER_API_KEY);

  if (provider === 'gemini')     return callGemini(messages, geminiKey);
  if (provider === 'claude')     return callAnthropic({ model: 'claude-sonnet-4-6', max_tokens: 8096, messages });
  if (provider === 'groq')       return callGroq(messages, groqKey);
  if (provider === 'mistral')    return callMistral(messages, mistralKey);
  if (provider === 'openrouter') return callOpenRouter(messages, openRouterKey);

  // Auto : Gemini → Groq → Mistral → OpenRouter → Claude
  const freeProviders = [
    hasGemini     && (() => callGemini(messages, geminiKey)),
    hasGroq       && (() => callGroq(messages, groqKey)),
    hasMistral    && (() => callMistral(messages, mistralKey)),
    hasOpenRouter && (() => callOpenRouter(messages, openRouterKey)),
    hasAnthropic  && (() => callAnthropic({ model: 'claude-sonnet-4-6', max_tokens: 8096, messages })),
  ].filter(Boolean);

  if (freeProviders.length === 0)
    throw new Error('Aucune clé API configurée — ajoutez GEMINI_API_KEY (gratuit sur aistudio.google.com/apikey) dans Render ou dans la plateforme');

  let lastError;
  for (const callFn of freeProviders) {
    try {
      const result = await callFn();
      if (result.status === 200) return result;
      // Erreur HTTP non fatale : essayer le suivant
      lastError = new Error(result.body?.error?.message || 'Erreur HTTP ' + result.status);
      console.log('[Auto] Fournisseur échoué, bascule suivant:', lastError.message);
    } catch (e) {
      lastError = e;
      console.log('[Auto] Fournisseur erreur, bascule suivant:', e.message);
    }
  }
  throw lastError;
}

// ─── Serveur ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Santé
  if (req.method === 'GET' && req.url === '/health') {
    const hasC  = !!ANTHROPIC_API_KEY;
    const hasG  = isValidGeminiKey(GEMINI_API_KEY);
    const hasGr = isValidGroqKey(GROQ_API_KEY);
    const hasM  = isValidMistralKey(MISTRAL_API_KEY);
    const hasOR = isValidOpenRouterKey(OPENROUTER_API_KEY);
    const provider = hasG ? 'gemini' : hasGr ? 'groq' : hasM ? 'mistral' : hasOR ? 'openrouter' : hasC ? 'claude' : 'none';
    return sendJSON(res, 200, {
      status: 'ok',
      apiKeyConfigured: !!(hasC || hasG || hasGr || hasM || hasOR),
      claudeKey: hasC, geminiKey: hasG, groqKey: hasGr, mistralKey: hasM, openRouterKey: hasOR,
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

      const provider       = body.provider        || 'auto';
      const geminiKey      = body.gemini_key       || '';
      const groqKey        = body.groq_key         || '';
      const mistralKey     = body.mistral_key      || '';
      const openRouterKey  = body.openrouter_key   || '';

      const providerLabel = provider === 'auto'
        ? (isValidGeminiKey(geminiKey || GEMINI_API_KEY) ? 'Gemini (auto)'
          : isValidGroqKey(groqKey || GROQ_API_KEY)      ? 'Groq (auto)'
          : isValidMistralKey(mistralKey || MISTRAL_API_KEY) ? 'Mistral (auto)'
          : isValidOpenRouterKey(openRouterKey || OPENROUTER_API_KEY) ? 'OpenRouter (auto)'
          : ANTHROPIC_API_KEY ? 'Claude (auto)' : 'Aucune clé')
        : provider;
      console.log(`[${new Date().toLocaleTimeString('fr-FR')}] Analyse — ${providerLabel}`);

      const result = await callAI(body.messages, provider, geminiKey, groqKey, mistralKey, openRouterKey);
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
      if (body.key)        { ANTHROPIC_API_KEY  = body.key.trim(); }
      if (body.gemini)     { GEMINI_API_KEY     = body.gemini.trim(); }
      if (body.groq)       { GROQ_API_KEY       = body.groq.trim(); }
      if (body.mistral)    { MISTRAL_API_KEY    = body.mistral.trim(); }
      if (body.openrouter) { OPENROUTER_API_KEY = body.openrouter.trim(); }
      return sendJSON(res, 200, { ok: true, note: 'Clé(s) active(s) pour cette session.' });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  sendJSON(res, 404, { error: 'Route inconnue' });
});

server.listen(PORT, '0.0.0.0', () => {
  const hasC  = !!ANTHROPIC_API_KEY;
  const hasG  = isValidGeminiKey(GEMINI_API_KEY);
  const hasGr = isValidGroqKey(GROQ_API_KEY);
  const hasM  = isValidMistralKey(MISTRAL_API_KEY);
  const hasOR = isValidOpenRouterKey(OPENROUTER_API_KEY);
  const nbFree = [hasG, hasGr, hasM, hasOR].filter(Boolean).length;
  const modeStr = nbFree > 1 ? `Auto (${nbFree} APIs gratuites disponibles)` : hasG ? 'Gemini gratuit' : hasGr ? 'Groq gratuit' : hasM ? 'Mistral gratuit' : hasOR ? 'OpenRouter gratuit' : hasC ? 'Claude uniquement' : '⚠ AUCUNE CLÉ';
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║              AMAT-CI — Plateforme active                 ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Port              : ${String(PORT).padEnd(37)}║`);
  console.log(`║  Gemini (Google)   : ${(hasG  ? '✅ configuré' : '❌ manquant').padEnd(37)}║`);
  console.log(`║  Groq  (Llama)     : ${(hasGr ? '✅ configuré' : '❌ manquant').padEnd(37)}║`);
  console.log(`║  Mistral AI        : ${(hasM  ? '✅ configuré' : '❌ manquant').padEnd(37)}║`);
  console.log(`║  OpenRouter        : ${(hasOR ? '✅ configuré' : '❌ manquant').padEnd(37)}║`);
  console.log(`║  Claude (Ant.)     : ${(hasC  ? '✅ configuré' : '❌ manquant').padEnd(37)}║`);
  console.log(`║  Mode              : ${modeStr.padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
