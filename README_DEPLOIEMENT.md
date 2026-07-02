# AMAT-CI Cloud - Deploiement

Ce dossier est le projet principal a publier sur GitHub/Render.

## Fichiers importants

- `server.js` : serveur Node.js et proxy IA.
- `plateforme.html` : interface web.
- `package.json` : commande de demarrage pour Render.
- `beneficiaires.js` : base beneficiaires. Attention, ce fichier contient des donnees nominatives.

## Depot Git

Depot actuel :

```text
https://github.com/Enok8/AMAT-CI-Plateforme.git
```

Branche actuelle :

```text
main
```

## Variables Render

Configurer en priorite la cle gratuite Gemini dans Render :

```text
GEMINI_API_KEY=...
```

Optionnellement, ajouter aussi Claude ou Groq comme secours :

```text
ANTHROPIC_API_KEY=...
GROQ_API_KEY=...
```

Le serveur choisit automatiquement dans cet ordre :

```text
Gemini -> Claude -> Groq
```

## Commandes utiles

Tester la syntaxe du serveur :

```bat
node --check server.js
```

Demarrer en local :

```bat
npm start
```

Publier sans forcer l'historique :

```bat
git status
git add server.js plateforme.html package.json README_DEPLOIEMENT.md .gitignore
git commit -m "chore: prepare cloud deployment"
git push origin main
```

## Note securite

Ne pas commiter `.env`, `config.txt`, les logs, ni une vraie cle API.
Avant d'ajouter `beneficiaires.js` au depot, verifier que le depot GitHub est prive et que la publication de ces donnees est autorisee.

