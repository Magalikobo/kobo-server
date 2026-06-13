/**
 * KOBO CARDS — Serveur Multijoueur
 * Node.js + Socket.io
 *
 * Installation :
 *   npm install express socket.io
 *
 * Démarrage :
 *   node kobo-server.js
 *
 * Hébergement (Railway / Render / Fly.io) :
 *   - Créer un compte sur https://railway.app (gratuit)
 *   - Nouveau projet → "Deploy from GitHub" ou "Empty Project"
 *   - Uploader ce fichier + package.json
 *   - Variable d'environnement PORT sera définie automatiquement
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════
// ÉTAT SERVEUR
// ═══════════════════════════════════════════════════════════

// salons[code] = { code, hote, joueurs[], etat, partie }
const salons = {};

// joueurs[socketId] = { id, pseudo, codeAmi, salonCode }
const joueurs = {};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function genererCode(longueur = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < longueur; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function genererDeck() {
  const couleurs = ['coeur','carreau','trefle','pique'];
  const valeurs  = ['AS','2','3','4','5','6','7','8','9','10','V','D','R'];
  const deck = [];
  for (const c of couleurs) for (const v of valeurs) deck.push(`${v}_${c}`);
  // Mélanger (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function pointsCarte(code) {
  if (!code) return 0;
  const [v, c] = code.split('_');
  if (v === 'AS') return 1;
  if (v === 'R') return (c === 'coeur' || c === 'carreau') ? 0 : 40;
  if (v === 'D') return 30;
  if (v === 'V') return 20;
  return parseInt(v) || 0;
}

function calculerPoints(slots) {
  return slots.reduce((s, c) => s + (c ? pointsCarte(c) : 0), 0);
}

function getSalonPublic(code) {
  const s = salons[code];
  if (!s) return null;
  return {
    code: s.code,
    hote: s.hote,
    nbJoueurs: s.joueurs.length,
    maxJoueurs: s.maxJoueurs,
    etat: s.etat,
    joueurs: s.joueurs.map(j => ({ pseudo: j.pseudo, pret: j.pret }))
  };
}

// ═══════════════════════════════════════════════════════════
// LOGIQUE DE PARTIE
// ═══════════════════════════════════════════════════════════

function demarrerPartie(salonCode) {
  const salon = salons[salonCode];
  if (!salon) return;

  const deck = genererDeck();
  salon.etat = 'en_cours';

  // Distribuer 4 cartes par joueur
  salon.partie = {
    deck,
    defausse: [],
    tourIdx: 0,          // index dans salon.joueurs
    mancheNum: 1,
    koboDeclarant: null, // socketId du déclarant
    dernierTour: false,  // true = dernier tour en cours
    dernierTourJoue: new Set(), // socketIds ayant joué leur dernier tour
  };

  for (const j of salon.joueurs) {
    j.slots = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
    j.score = j.score || 0;
    j.slotsVus = new Set([2, 3]); // connaît les 2 cartes du bas
  }

  // Carte initiale en défausse
  salon.partie.defausse.push(salon.partie.deck.pop());

  // Envoyer l'état initial à chaque joueur
  for (const j of salon.joueurs) {
    const socket = io.sockets.sockets.get(j.id);
    if (!socket) continue;

    socket.emit('partie_start', {
      slots: j.slots,            // ses propres cartes
      slotsVus: [...j.slotsVus], // indices visibles au départ
      defausseTop: salon.partie.defausse[salon.partie.defausse.length - 1],
      nbCartesPioche: salon.partie.deck.length,
      joueurs: salon.joueurs.map(jj => ({
        id: jj.id,
        pseudo: jj.pseudo,
        score: jj.score,
        nbSlots: jj.slots.filter(c => c !== null).length,
        vous: jj.id === j.id,
      })),
      tourDe: salon.joueurs[salon.partie.tourIdx].id,
      mancheNum: salon.partie.mancheNum,
    });
  }

  console.log(`[${salonCode}] Partie démarrée — ${salon.joueurs.length} joueurs`);
}

function prochainTour(salonCode) {
  const salon = salons[salonCode];
  if (!salon || !salon.partie) return;
  const p = salon.partie;

  // Passer au joueur suivant (actif)
  let next = (p.tourIdx + 1) % salon.joueurs.length;
  // Sauter les joueurs éliminés
  let count = 0;
  while (salon.joueurs[next].eliminee && count < salon.joueurs.length) {
    next = (next + 1) % salon.joueurs.length;
    count++;
  }
  p.tourIdx = next;

  // Si dernier tour en cours, vérifier si tout le monde a joué
  if (p.dernierTour) {
    const joueurActuel = salon.joueurs[p.tourIdx];
    if (p.dernierTourJoue.has(joueurActuel.id) || joueurActuel.id === salon.partie.koboDeclarant) {
      // Tout le monde a joué → fin de manche
      finManche(salonCode);
      return;
    }
  }

  io.to(salonCode).emit('tour_change', {
    tourDe: salon.joueurs[p.tourIdx].id,
    defausseTop: p.defausse[p.defausse.length - 1] || null,
    nbCartesPioche: p.deck.length,
  });
}

function finManche(salonCode) {
  const salon = salons[salonCode];
  if (!salon || !salon.partie) return;
  const p = salon.partie;

  // Calculer les scores
  const scores = {};
  const pointsParJoueur = {};

  for (const j of salon.joueurs) {
    pointsParJoueur[j.id] = calculerPoints(j.slots.filter(c => c !== null));
  }

  // Règle Kobo
  if (p.koboDeclarant) {
    const ptsDeclarant = pointsParJoueur[p.koboDeclarant];
    const minAutres = Math.min(...Object.entries(pointsParJoueur)
      .filter(([id]) => id !== p.koboDeclarant)
      .map(([, pts]) => pts));

    for (const j of salon.joueurs) {
      if (j.id === p.koboDeclarant) {
        if (ptsDeclarant < minAutres) {
          scores[j.id] = 0; // Kobo réussi
        } else if (ptsDeclarant === minAutres) {
          scores[j.id] = ptsDeclarant; // Égalité
        } else {
          scores[j.id] = ptsDeclarant * 2; // Kobo raté → double
        }
      } else {
        scores[j.id] = pointsParJoueur[j.id];
      }
    }
  } else {
    for (const j of salon.joueurs) scores[j.id] = pointsParJoueur[j.id];
  }

  // Appliquer les scores
  for (const j of salon.joueurs) {
    j.score = (j.score || 0) + (scores[j.id] || 0);
    if (j.score >= 200) j.eliminee = true;
  }

  // Révéler toutes les cartes
  const revelation = {};
  for (const j of salon.joueurs) revelation[j.id] = j.slots;

  io.to(salonCode).emit('fin_manche', {
    scores,
    pointsCetteManche: pointsParJoueur,
    scoresTotal: Object.fromEntries(salon.joueurs.map(j => [j.id, j.score])),
    revelation,
    koboDeclarant: p.koboDeclarant,
    mancheNum: p.mancheNum,
  });

  // Vérifier fin de partie
  const actifs = salon.joueurs.filter(j => !j.eliminee);
  if (actifs.length <= 1) {
    const gagnant = salon.joueurs.reduce((min, j) => j.score < min.score ? j : min);
    io.to(salonCode).emit('fin_partie', {
      gagnant: { id: gagnant.id, pseudo: gagnant.pseudo, score: gagnant.score },
      scores: Object.fromEntries(salon.joueurs.map(j => [j.id, { pseudo: j.pseudo, score: j.score }])),
    });
    salon.etat = 'terminee';
    return;
  }

  console.log(`[${salonCode}] Manche ${p.mancheNum} terminée`);
}

function nouvelleManche(salonCode) {
  const salon = salons[salonCode];
  if (!salon) return;

  const deck = genererDeck();
  const p = salon.partie;
  p.deck = deck;
  p.defausse = [];
  p.mancheNum++;
  p.koboDeclarant = null;
  p.dernierTour = false;
  p.dernierTourJoue = new Set();

  // Réinitialiser les slots
  for (const j of salon.joueurs) {
    if (!j.eliminee) {
      j.slots = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
      j.slotsVus = new Set([2, 3]);
    }
  }
  p.defausse.push(p.deck.pop());

  // Trouver le joueur qui a le plus de points pour commencer
  const joueurMax = salon.joueurs
    .filter(j => !j.eliminee)
    .reduce((max, j) => j.score > max.score ? j : max);
  p.tourIdx = salon.joueurs.findIndex(j => j.id === joueurMax.id);

  // Envoyer nouvel état
  for (const j of salon.joueurs) {
    if (j.eliminee) continue;
    const socket = io.sockets.sockets.get(j.id);
    if (!socket) continue;
    socket.emit('nouvelle_manche', {
      slots: j.slots,
      slotsVus: [...j.slotsVus],
      defausseTop: p.defausse[p.defausse.length - 1],
      nbCartesPioche: p.deck.length,
      tourDe: salon.joueurs[p.tourIdx].id,
      mancheNum: p.mancheNum,
      scores: Object.fromEntries(salon.joueurs.map(jj => [jj.id, { pseudo: jj.pseudo, score: jj.score, eliminee: jj.eliminee }])),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO — ÉVÉNEMENTS
// ═══════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[+] Connexion : ${socket.id}`);

  // ── INSCRIPTION ──────────────────────────────────────────
  socket.on('s_inscrire', ({ pseudo, codeAmi }) => {
    joueurs[socket.id] = { id: socket.id, pseudo, codeAmi };
    socket.emit('inscrit', { id: socket.id });
    console.log(`[inscrit] ${pseudo} (${codeAmi})`);
  });

  // ── CRÉER UN SALON ────────────────────────────────────────
  socket.on('s_creer_salon', ({ pseudo, maxJoueurs = 4 }) => {
    const code = genererCode(6);
    const joueur = joueurs[socket.id] || { id: socket.id, pseudo };
    joueur.pseudo = pseudo;
    joueurs[socket.id] = joueur;

    salons[code] = {
      code,
      hote: socket.id,
      maxJoueurs: Math.min(6, Math.max(2, maxJoueurs)),
      etat: 'attente',
      joueurs: [{
        id: socket.id,
        pseudo,
        pret: false,
        score: 0,
        slots: [],
        slotsVus: new Set(),
      }],
      partie: null,
    };

    joueur.salonCode = code;
    socket.join(code);
    socket.emit('salon_cree', { code, salon: getSalonPublic(code) });
    console.log(`[salon] Créé : ${code} par ${pseudo}`);
  });

  // ── REJOINDRE UN SALON ────────────────────────────────────
  socket.on('s_rejoindre_salon', ({ code, pseudo }) => {
    const salon = salons[code];
    if (!salon) { socket.emit('erreur', { msg: 'Salon introuvable.' }); return; }
    if (salon.etat !== 'attente') { socket.emit('erreur', { msg: 'Partie déjà en cours.' }); return; }
    if (salon.joueurs.length >= salon.maxJoueurs) { socket.emit('erreur', { msg: 'Salon complet.' }); return; }

    const joueur = joueurs[socket.id] || { id: socket.id, pseudo };
    joueur.pseudo = pseudo;
    joueur.salonCode = code;
    joueurs[socket.id] = joueur;

    salon.joueurs.push({ id: socket.id, pseudo, pret: false, score: 0, slots: [], slotsVus: new Set() });
    socket.join(code);

    socket.emit('salon_rejoint', { code, salon: getSalonPublic(code) });
    io.to(code).emit('joueur_rejoint', { salon: getSalonPublic(code), nouveau: pseudo });
    console.log(`[salon] ${pseudo} a rejoint ${code}`);
  });

  // ── PRÊT ──────────────────────────────────────────────────
  socket.on('s_pret', () => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon) return;

    const joueurSalon = salon.joueurs.find(jj => jj.id === socket.id);
    if (joueurSalon) joueurSalon.pret = true;

    io.to(j.salonCode).emit('joueur_pret', { id: socket.id, pseudo: j.pseudo });

    // Démarrer si tous prêts et au moins 2 joueurs
    const tousPrets = salon.joueurs.every(jj => jj.pret);
    if (tousPrets && salon.joueurs.length >= 2) {
      demarrerPartie(j.salonCode);
    }
  });

  // ── LANCER LA PARTIE (hôte seulement) ────────────────────
  socket.on('s_lancer_partie', () => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || salon.hote !== socket.id) return;
    if (salon.joueurs.length < 2) { socket.emit('erreur', { msg: 'Il faut au moins 2 joueurs.' }); return; }
    demarrerPartie(j.salonCode);
  });

  // ── PIOCHER ───────────────────────────────────────────────
  socket.on('s_piocher', () => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    // Vérifier que c'est bien son tour
    if (salon.joueurs[p.tourIdx].id !== socket.id) {
      socket.emit('erreur', { msg: "Ce n'est pas votre tour." }); return;
    }

    if (p.deck.length === 0) {
      // Recycler la défausse
      const top = p.defausse.pop();
      p.deck = [...p.defausse].reverse();
      p.defausse = top ? [top] : [];
      for (let i = p.deck.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [p.deck[i], p.deck[k]] = [p.deck[k], p.deck[i]];
      }
    }

    const carte = p.deck.pop();
    socket.emit('carte_piochee', {
      carte,
      nbCartesPioche: p.deck.length,
    });
    // Les autres voient qu'une carte a été piochée (face cachée)
    socket.to(j.salonCode).emit('adversaire_pioche', {
      joueurId: socket.id,
      nbCartesPioche: p.deck.length,
    });
  });

  // ── PIOCHER DANS LA DÉFAUSSE ──────────────────────────────
  socket.on('s_piocher_defausse', () => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) {
      socket.emit('erreur', { msg: "Ce n'est pas votre tour." }); return;
    }
    if (p.defausse.length === 0) {
      socket.emit('erreur', { msg: 'La défausse est vide.' }); return;
    }

    const carte = p.defausse.pop();
    socket.emit('carte_defausse_piochee', {
      carte,
      nouvelleDefausse: p.defausse[p.defausse.length - 1] || null,
    });
    io.to(j.salonCode).emit('defausse_changee', {
      top: p.defausse[p.defausse.length - 1] || null,
      joueurId: socket.id,
    });
  });

  // ── REMPLACER UNE CARTE ───────────────────────────────────
  socket.on('s_remplacer', ({ cartePiochee, slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) {
      socket.emit('erreur', { msg: "Ce n'est pas votre tour." }); return;
    }

    const joueurSalon = salon.joueurs.find(jj => jj.id === socket.id);
    const ancienneCarte = joueurSalon.slots[slotIndex];
    joueurSalon.slots[slotIndex] = cartePiochee;
    joueurSalon.slotsVus.add(slotIndex);
    p.defausse.push(ancienneCarte);

    socket.emit('remplacement_ok', {
      slotIndex,
      nouvelleCarte: cartePiochee,
      ancienneCarte,
      defausseTop: p.defausse[p.defausse.length - 1],
    });

    socket.to(j.salonCode).emit('adversaire_remplace', {
      joueurId: socket.id,
      slotIndex,
      ancienneCarte, // la carte défaussée (visible)
      defausseTop: p.defausse[p.defausse.length - 1],
    });

    if (p.dernierTour) {
      p.dernierTourJoue.add(socket.id);
    }
    prochainTour(j.salonCode);
  });

  // ── DÉFAUSSER LA CARTE PIOCHÉE ────────────────────────────
  socket.on('s_defausser', ({ cartePiochee }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) return;

    p.defausse.push(cartePiochee);
    io.to(j.salonCode).emit('carte_defaussee', {
      joueurId: socket.id,
      carte: cartePiochee,
      defausseTop: cartePiochee,
    });

    if (p.dernierTour) {
      p.dernierTourJoue.add(socket.id);
    }
    prochainTour(j.salonCode);
  });

  // ── SUPPRIMER UNE PAIRE ───────────────────────────────────
  socket.on('s_supprimer_paire', ({ cartePiochee, slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) return;

    const joueurSalon = salon.joueurs.find(jj => jj.id === socket.id);
    const cartePaire = joueurSalon.slots[slotIndex];
    joueurSalon.slots[slotIndex] = null;
    joueurSalon.slotsVus.delete(slotIndex);
    p.defausse.push(cartePiochee);
    p.defausse.push(cartePaire);

    socket.emit('paire_supprimee_ok', {
      slotIndex,
      cartePiochee,
      cartePaire,
      defausseTop: p.defausse[p.defausse.length - 1],
    });
    socket.to(j.salonCode).emit('adversaire_supprime_paire', {
      joueurId: socket.id,
      slotIndex,
      cartePaire,
    });

    if (p.dernierTour) {
      p.dernierTourJoue.add(socket.id);
    }
    prochainTour(j.salonCode);
  });

  // ── DÉCLARER KOBO ────────────────────────────────────────
  socket.on('s_kobo', () => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) {
      socket.emit('erreur', { msg: "Vous pouvez déclarer Kobo seulement pendant votre tour." }); return;
    }
    if (p.dernierTour) {
      socket.emit('erreur', { msg: 'Kobo déjà déclaré.' }); return;
    }

    p.koboDeclarant = socket.id;
    p.dernierTour = true;
    p.dernierTourJoue.add(socket.id); // Le déclarant n'a plus de tour

    io.to(j.salonCode).emit('kobo_declare', {
      joueurId: socket.id,
      pseudo: j.pseudo,
    });

    // Passer au joueur suivant pour le dernier tour
    prochainTour(j.salonCode);
  });

  // ── POUVOIR 9 (regarder sa propre carte) ─────────────────
  socket.on('s_pouvoir_9', ({ slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;

    const joueurSalon = salon.joueurs.find(jj => jj.id === socket.id);
    const carte = joueurSalon.slots[slotIndex];
    joueurSalon.slotsVus.add(slotIndex);

    socket.emit('pouvoir_9_ok', { slotIndex, carte });
    socket.to(j.salonCode).emit('adversaire_pouvoir_9', {
      joueurId: socket.id, slotIndex,
    });
  });

  // ── POUVOIR 10 (regarder carte adverse) ──────────────────
  socket.on('s_pouvoir_10', ({ cibleId, slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;

    const cible = salon.joueurs.find(jj => jj.id === cibleId);
    if (!cible) return;

    const carte = cible.slots[slotIndex];
    // Seul le joueur qui a utilisé le 10 voit la carte
    socket.emit('pouvoir_10_ok', { cibleId, slotIndex, carte });
    socket.to(j.salonCode).emit('adversaire_pouvoir_10', {
      joueurId: socket.id, cibleId, slotIndex,
    });
  });

  // ── POUVOIR VALET (échanger) ──────────────────────────────
  socket.on('s_pouvoir_valet', ({ monSlot, cibleId, slotCible }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;

    const moi = salon.joueurs.find(jj => jj.id === socket.id);
    const cible = salon.joueurs.find(jj => jj.id === cibleId);
    if (!moi || !cible) return;

    // Échanger les cartes
    const maCarte = moi.slots[monSlot];
    const carteCible = cible.slots[slotCible];
    moi.slots[monSlot] = carteCible;   // Reçue face CACHÉE (on ne la connaît pas)
    cible.slots[slotCible] = maCarte;

    // Mettre à jour la mémoire
    moi.slotsVus.delete(monSlot); // La nouvelle carte est inconnue
    cible.slotsVus.delete(slotCible);

    io.to(j.salonCode).emit('valet_echange', {
      joueurId: socket.id,
      monSlot,
      cibleId,
      slotCible,
      // On ne révèle pas les cartes échangées
    });
    // Informer la cible que sa carte a changé (face cachée)
    const socketCible = io.sockets.sockets.get(cibleId);
    if (socketCible) {
      socketCible.emit('votre_carte_echangee', { slotIndex: slotCible });
    }
  });

  // ── NOUVELLE MANCHE (tous les joueurs doivent confirmer) ──
  socket.on('s_nouvelle_manche', () => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || salon.hote !== socket.id) return;
    nouvelleManche(j.salonCode);
  });

  // ── QUITTER ───────────────────────────────────────────────
  socket.on('s_quitter_salon', () => {
    quitterSalon(socket);
  });

  socket.on('disconnect', () => {
    quitterSalon(socket);
    delete joueurs[socket.id];
    console.log(`[-] Déconnexion : ${socket.id}`);
  });

  function quitterSalon(sock) {
    const j = joueurs[sock.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon) return;

    salon.joueurs = salon.joueurs.filter(jj => jj.id !== sock.id);
    sock.leave(j.salonCode);

    if (salon.joueurs.length === 0) {
      // Supprimer le salon vide
      delete salons[j.salonCode];
      console.log(`[salon] ${j.salonCode} supprimé (vide)`);
    } else {
      // Passer l'hôte si nécessaire
      if (salon.hote === sock.id) {
        salon.hote = salon.joueurs[0].id;
      }
      io.to(j.salonCode).emit('joueur_quitte', {
        joueurId: sock.id,
        pseudo: j.pseudo,
        nouvelHote: salon.hote,
        salon: getSalonPublic(j.salonCode),
      });

      // Si partie en cours et un seul joueur restant
      if (salon.etat === 'en_cours' && salon.joueurs.filter(jj => !jj.eliminee).length <= 1) {
        const gagnant = salon.joueurs[0];
        io.to(j.salonCode).emit('fin_partie', {
          gagnant: { id: gagnant.id, pseudo: gagnant.pseudo, score: gagnant.score },
          raison: 'abandon',
        });
        salon.etat = 'terminee';
      }
    }
    delete j.salonCode;
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTES HTTP
// ═══════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    salons: Object.keys(salons).length,
    joueurs: Object.keys(joueurs).length,
  });
});

// Liste des salons publics
app.get('/salons', (req, res) => {
  const publics = Object.values(salons)
    .filter(s => s.etat === 'attente')
    .map(s => getSalonPublic(s.code));
  res.json(publics);
});

// ═══════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════

httpServer.listen(PORT, () => {
  console.log(`\n🃏 Kobo Cards — Serveur multijoueur`);
  console.log(`   Port : ${PORT}`);
  console.log(`   Prêt !\n`);
});
