/**
 * AMAT-CI — Serveur cloud (Render.com)
 * Variables d'environnement requises sur Render :
 *   ANTHROPIC_API_KEY = votre clé sk-ant-api03-...
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────
// Sur Render : variables d'environnement
// En local   : config.txt (fallback)
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

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) return reject(new Error('Clé API non configurée — définissez ANTHROPIC_API_KEY dans les variables d\'environnement Render'));
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

// ─── Serveur ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Santé
  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { status: 'ok', apiKeyConfigured: !!ANTHROPIC_API_KEY });
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

  // Proxy Anthropic
  if (req.method === 'POST' && req.url === '/analyser') {
    try {
      const body = await readBody(req);
      if (!body.messages || !Array.isArray(body.messages))
        return sendJSON(res, 400, { error: "Champ 'messages' requis" });

      const payload = {
        model: 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 8096,
        messages: body.messages,
      };

      console.log(`[${new Date().toLocaleTimeString('fr-FR')}] Analyse reçue`);
      const result = await callAnthropic(payload);
      if (result.status !== 200)
        console.error('[Anthropic] Erreur', result.status, JSON.stringify(result.body).substring(0, 200));
      return sendJSON(res, result.status, result.body);
    } catch (err) {
      console.error('Erreur:', err.message);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // Clé API (lecture seule sur cloud — la clé vient des variables d'environnement)
  if (req.method === 'POST' && req.url === '/set-key') {
    try {
      const body = await readBody(req);
      if (body.key) {
        ANTHROPIC_API_KEY = body.key.trim();
        // Sur cloud : on ne peut pas écrire config.txt (filesystem éphémère)
        // La clé est active pour cette session uniquement
        return sendJSON(res, 200, { ok: true, note: 'Clé active pour cette session. Sur Render, configurez ANTHROPIC_API_KEY dans Environment.' });
      }
      return sendJSON(res, 400, { error: 'Clé manquante' });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  sendJSON(res, 404, { error: 'Route inconnue' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║              AMAT-CI — Plateforme active                 ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Port           : ${String(PORT).padEnd(40)}║`);
  console.log(`║  Clé API        : ${(ANTHROPIC_API_KEY ? '✅ configurée' : '❌ manquante — ajoutez ANTHROPIC_API_KEY').padEnd(40)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
