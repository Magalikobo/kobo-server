/**
 * KOBO CARDS — Serveur Multijoueur
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');

async function demarrerServeur() {
    
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'] }
    });

// FILTRAGE DES PSEUDOS
// ═══════════════════════════════════════════════════════════

// Pseudos réservés à l'équipe Kobo Studio
const PSEUDOS_RESERVES = [
  'kobomaster','koboadmin','kobo_staff','kobostaff','koboteam','kobo_team',
  'admin','administrateur','administrator','moderateur','modérateur','moderator',
  'support','kobo_support','kobosupport','staff','equipe_kobo','equipekobo',
  'kobo_officiel','koboofficiel','officiel','official',
];

const TEAM_CODE_HASH = '008b2a988275d3e85f5d965ee1310579fe9a82a34fe72db0b53d4227a8fa0a4c';

function normaliserPseudo(str) {
  return (str || '').toLowerCase()
    .replace(/[@àáâä]/g, 'a').replace(/[0òóôö]/g, 'o').replace(/[3èéêë]/g, 'e')
    .replace(/[1!ìíîï]/g, 'i').replace(/[5]/g, 's').replace(/[7]/g, 't')
    .replace(/[._\-\s]/g, '').replace(/[*#]/g, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Fonction marquée async pour permettre l'utilisation de await
async function validerPseudoServeur(saisie) {
  saisie = (saisie || '').trim();
  const parties    = saisie.split('#');
  const pseudoBrut = parties[0].trim();
  const codeSecret = parties.length > 1 ? parties.slice(1).join('#').trim() : null;

  if (pseudoBrut.length < 3)  return { ok: false, erreur: 'Pseudo trop court (3 caractères min).' };
  if (pseudoBrut.length > 16) return { ok: false, erreur: 'Pseudo trop long (16 caractères max).' };
  if (!/^[a-zA-Z0-9_\-àâéèêëîïôùûüç]+$/.test(pseudoBrut))
    return { ok: false, erreur: 'Caractères non autorisés.' };

  // Vérification via l'API externe (sans aucune bibliothèque à installer)
  try {
    const response = await fetch(`https://www.purgomalum.com/service/json?text=${encodeURIComponent(pseudoBrut)}`);
    const data = await response.json();

    if (data.result !== pseudoBrut) {
        return { ok: false, erreur: 'Ce pseudo n\'est pas autorisé.' };
    }
  } catch (err) {
    console.error("Erreur filtre :", err);
    // On continue par sécurité si l'API est injoignable
  }

  const pseudoNorm = normaliserPseudo(pseudoBrut);
  const estReserve = PSEUDOS_RESERVES.some(r => normaliserPseudo(r) === pseudoNorm);
  if (estReserve) {
    if (!codeSecret)
      return { ok: false, erreur: 'Ce pseudo est réservé à l\'équipe Kobo Studio.' };
    if (sha256(codeSecret) !== TEAM_CODE_HASH)
      return { ok: false, erreur: 'Code d\'équipe incorrect.' };
  }

  return { ok: true, pseudoFinal: pseudoBrut };
}
// ═══════════════════════════════════════════════════════════
// ÉTAT SERVEUR
// ═══════════════════════════════════════════════════════════

// salons[code] = { code, hote, joueurs[], etat, partie }
const salons = {};

// joueurs[socketId] = { id, pseudo, codeAmi, salonCode }
const joueurs = {};

// Index codeAmi → socketId (pour invitations et présence)
const codeAmiIndex = {};

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
    joueurs: s.joueurs.map(j => ({
      id: j.id,
      pseudo: j.pseudo,
      avatar: j.avatar || (joueurs[j.id] && joueurs[j.id].avatar) || 'chien',
      pret: j.pret
    }))
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

  // Pas de carte initiale en défausse — commence vide

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
        avatar: jj.avatar || (joueurs[jj.id] && joueurs[jj.id].avatar) || 'chien',
        score: jj.score,
        nbSlots: jj.slots.filter(c => c !== null).length,
        vous: jj.id === j.id,
      })),
      tourDe: salon.joueurs[salon.partie.tourIdx].id,
      mancheNum: salon.partie.mancheNum,
    });
  }

  console.log(`[${salonCode}] Partie démarrée — ${salon.joueurs.length} joueurs`);
  // Log des slots initiaux pour debug
  salon.joueurs.forEach(j => console.log(`  [slots] ${j.pseudo}:`, j.slots));
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
  // Défausse vide au début de chaque manche
  // (pas de carte initiale — le premier joueur commence à piocher)

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
      scores: Object.fromEntries(salon.joueurs.map(jj => [jj.id, { pseudo: jj.pseudo, avatar: jj.avatar||'chien', score: jj.score, eliminee: jj.eliminee }])),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO — ÉVÉNEMENTS
// ═══════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[+] Connexion : ${socket.id}`);

  // ── INSCRIPTION ──────────────────────────────────────────
  socket.on('s_inscrire', async ({ pseudo, codeAmi, avatar }) => {
    const res = await validerPseudoServeur(pseudo);
    if (!res.ok) { socket.emit('erreur', { msg: res.erreur }); return; }
    const av = avatar || 'chien';
    joueurs[socket.id] = { id: socket.id, pseudo: res.pseudoFinal, codeAmi, avatar: av };
    if (codeAmi) codeAmiIndex[codeAmi] = { socketId: socket.id, pseudo: res.pseudoFinal, avatar: av };

    // Récupération après reconnexion : mettre à jour l'id dans salon.joueurs
    // (le socketId change après chaque reconnexion Railway)
    if (codeAmi) {
      for (const [code, salon] of Object.entries(salons)) {
        const jInSalon = salon.joueurs.find(jj => jj.codeAmi === codeAmi);
        if (jInSalon) {
          console.log(`[reconnexion] ${res.pseudoFinal} : ${jInSalon.id} → ${socket.id}`);
          jInSalon.id = socket.id; // mettre à jour le socketId
          joueurs[socket.id].salonCode = code;
          socket.join(code); // rejoindre la room Socket.io
        }
      }
    }
    socket.emit('inscrit', { id: socket.id });
    console.log(`[inscrit] ${res.pseudoFinal} (${codeAmi})`);
  });

  // Recherche d'un joueur par son code ami
  socket.on('s_chercher_ami', ({ codeAmi }) => {
    const info = codeAmiIndex[codeAmi];
    if (!info) {
      socket.emit('ami_introuvable', { codeAmi }); return;
    }
    socket.emit('ami_trouve', {
      codeAmi,
      pseudo: info.pseudo,
      avatar: info.avatar,
    });
  });

  // ── CRÉER UN SALON ────────────────────────────────────────
  socket.on('s_creer_salon', async ({ pseudo, maxJoueurs = 4, avatar }) => {
    const res = await validerPseudoServeur(pseudo);
    if (!res.ok) { socket.emit('erreur', { msg: res.erreur }); return; }
    const code = genererCode(6);
    const joueur = joueurs[socket.id] || { id: socket.id, pseudo: res.pseudoFinal };
    joueur.pseudo = res.pseudoFinal;
    // Mettre à jour l'avatar depuis s_creer_salon si fourni
    if(avatar) joueur.avatar = avatar;
    joueurs[socket.id] = joueur;

    const avatarHote = avatar || joueur.avatar || 'chien';
    salons[code] = {
      code,
      hote: socket.id,
      maxJoueurs: Math.min(6, Math.max(2, maxJoueurs)),
      etat: 'attente',
      joueurs: [{
        id: socket.id,
        codeAmi: joueur.codeAmi || '',
        pseudo: res.pseudoFinal,
        avatar: avatarHote,
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
  socket.on('s_rejoindre_salon', async ({ code, pseudo, avatar }) => {
    const res = await validerPseudoServeur(pseudo);
    if (!res.ok) { socket.emit('erreur', { msg: res.erreur }); return; }
    const salon = salons[code];
    if (!salon) { socket.emit('erreur', { msg: 'Salon introuvable.' }); return; }
    if (salon.etat !== 'attente') { socket.emit('erreur', { msg: 'Partie déjà en cours.' }); return; }
    if (salon.joueurs.length >= salon.maxJoueurs) { socket.emit('erreur', { msg: 'Salon complet.' }); return; }

    const joueur = joueurs[socket.id] || { id: socket.id, pseudo: res.pseudoFinal };
    joueur.pseudo = res.pseudoFinal;
    joueur.salonCode = code;
    joueurs[socket.id] = joueur;

    // Priorité : avatar reçu dans s_rejoindre_salon, sinon depuis s_inscrire
    const avatarInvite = avatar || (joueurs[socket.id] && joueurs[socket.id].avatar) || 'chien';
    // Mettre à jour joueurs avec cet avatar
    if(joueurs[socket.id]) joueurs[socket.id].avatar = avatarInvite;
    const codeAmiInvite = (joueurs[socket.id] && joueurs[socket.id].codeAmi) || '';
    salon.joueurs.push({ id: socket.id, codeAmi: codeAmiInvite, pseudo: res.pseudoFinal, avatar: avatarInvite, pret: false, score: 0, slots: [], slotsVus: new Set() });
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
    if (!salon) return;
    // Seul l'hôte peut lancer, mais on envoie un message clair si c'est l'invité
    if (salon.hote !== socket.id) {
      socket.emit('erreur', { msg: "Seul l'hôte peut lancer la partie." }); return;
    }
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
    const defausseRestante = p.defausse[p.defausse.length - 1] || null;
    // Envoyer au joueur qui pioche
    socket.emit('carte_defausse_piochee', {
      carte,
      defausseRestante,
    });
    // Informer les autres joueurs que la défausse a changé
    socket.to(j.salonCode).emit('adversaire_pioche_defausse', {
      joueurId: socket.id,
      defausseRestante,
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

    console.log(`[s_defausser] ${j.pseudo}: défausse ${cartePiochee}`);
    p.defausse.push(cartePiochee);
    const nouveauTop = p.defausse[p.defausse.length - 1];
    io.to(j.salonCode).emit('carte_defaussee', {
      joueurId: socket.id,
      carte: cartePiochee,
      defausseTop: nouveauTop, // toujours le vrai top de la pile
    });

    if (p.dernierTour) {
      p.dernierTourJoue.add(socket.id);
    }
    prochainTour(j.salonCode);
  });

  // ── SUPPRIMER UNE PAIRE ───────────────────────────────────
  // ── AJOUTER CARTE (mauvaise suppr. paire) ─────────────────────────────
  socket.on('s_ajouter_carte', ({ carte }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const jSlots = salon.joueurs.find(jj => jj.id === socket.id);
    if (!jSlots) return;
    // Ajouter la carte dans un slot vide ou en 5ème position
    const slotVide = jSlots.slots.indexOf(null);
    if(slotVide >= 0){
      jSlots.slots[slotVide] = carte;
    } else {
      jSlots.slots.push(carte);
    }
    socket.emit('carte_ajoutee', { slots: jSlots.slots });
    // Ne pas passer le tour — le joueur doit encore jouer (remplacer/défausser)
    // Informer aussi les adversaires qu'une carte a été ajoutée
    socket.to(j.salonCode).emit('adversaire_carte_ajoutee', {
      joueurId: socket.id,
      nbSlots: jSlots.slots.filter(c => c !== null).length,
    });
  });

  socket.on('s_supprimer_paire', ({ cartePiochee, slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) return;

    const joueurSalon = salon.joueurs.find(jj => jj.id === socket.id);
    const cartePaire = joueurSalon.slots[slotIndex];

    // Validation côté serveur : les deux cartes doivent avoir la même valeur
    const valPiochee = cartePiochee ? cartePiochee.split('_')[0] : null;
    const valPaire = cartePaire ? cartePaire.split('_')[0] : null;
    if (!valPiochee || !valPaire || valPiochee !== valPaire) {
      // Mauvaise paire — ajouter la carte piochée dans le jeu du joueur
      const slotVide = joueurSalon.slots.indexOf(null);
      if (slotVide >= 0) {
        joueurSalon.slots[slotVide] = cartePiochee;
      } else {
        joueurSalon.slots.push(cartePiochee);
      }
      socket.emit('carte_ajoutee', { slots: joueurSalon.slots });
      socket.to(j.salonCode).emit('adversaire_carte_ajoutee', {
        joueurId: socket.id,
        nbSlots: joueurSalon.slots.filter(c => c !== null).length,
      });
      console.log(`[s_supprimer_paire] Mauvaise paire: piochée=${cartePiochee}, slot=${cartePaire}`);
      return; // Ne pas passer le tour
    }

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
      defausseTop: p.defausse[p.defausse.length - 1],
    });

    if (p.dernierTour) {
      p.dernierTourJoue.add(socket.id);
    }
    prochainTour(j.salonCode);
  });

  // ── DÉCLARER KOBO ────────────────────────────────────────
  socket.on('s_kobo', () => {
    const j = joueurs[socket.id];
    console.log(`[s_kobo] reçu de ${j?.pseudo}, salon=${j?.salonCode}`);
    if (!j || !j.salonCode) { console.log('[s_kobo] pas de salon!'); return; }
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) { console.log('[s_kobo] pas de partie!'); return; }
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
    if (!salon) return;
    // Seul l'hôte peut lancer, mais on envoie un message clair si c'est l'invité
    if (salon.hote !== socket.id) {
      socket.emit('erreur', { msg: "Seul l'hôte peut lancer la partie." }); return;
    }
    nouvelleManche(j.salonCode);
  });

  // ── QUITTER ───────────────────────────────────────────────
  // ── INVITATION PAR CODE AMI ─────────────────────────────
  socket.on('s_inviter', ({ codeAmiCible, salonCode }) => {
    const expediteur = joueurs[socket.id];
    if (!expediteur) return;
    // Trouver le socket de la cible par son code ami
    const cibleInfo = codeAmiIndex[codeAmiCible];
    console.log(`[invitation] codeAmiCible=${codeAmiCible}, cibleInfo=`, cibleInfo);
    console.log(`[invitation] codeAmiIndex keys=`, Object.keys(codeAmiIndex));
    const cibleSocketId = cibleInfo ? cibleInfo.socketId : null;
    if (!cibleSocketId) {
      socket.emit('erreur', { msg: 'Ami introuvable ou hors ligne. Demandez-lui de rouvrir la page multi.' }); return;
    }
    const socketCible = io.sockets.sockets.get(cibleSocketId);
    if (!socketCible) {
      socket.emit('erreur', { msg: 'Ami déconnecté. Demandez-lui de rouvrir la page multi.' }); return;
    }
    socketCible.emit('invitation_recue', {
      de: expediteur.pseudo,
      codeAmi: expediteur.codeAmi,
      salonCode,
    });
    socket.emit('invitation_envoyee', { codeAmiCible });
    console.log(`[invitation] ${expediteur.pseudo} → ${codeAmiCible} (salon ${salonCode})`);
  });

  socket.on('s_quitter_salon', () => {
    quitterSalon(socket);
  });

  socket.on('ping_keepalive', () => {
    socket.emit('pong_keepalive');
  });

  // ── PRÉSENCE : vérifier quels amis sont en ligne ─────────────────────
  socket.on('s_verifier_presence', ({ codesAmis }) => {
    if (!Array.isArray(codesAmis)) return;
    const enLigne = codesAmis.filter(code => {
      const info = codeAmiIndex[code];
      if (!info) return false;
      // Vérifier que le socket est toujours connecté
      const sock = io.sockets.sockets.get(info.socketId);
      return !!sock;
    });
    socket.emit('presence_amis', { enLigne });
  });

  // ── POUVOIR 9 : regarder sa propre carte ──────────────────────────────
  socket.on('s_regarder_carte_propre', ({ slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const jSlots = salon.joueurs.find(jj => jj.id === socket.id);
    if (!jSlots) return;
    const carte = jSlots.slots[slotIndex];
    // Envoyer la vraie carte au joueur
    socket.emit('carte_revelee_propre', { slotIndex, carte });
    // Informer les adversaires qu'une carte se retourne (sans révéler laquelle)
    socket.to(j.salonCode).emit('adversaire_regarde_carte', {
      joueurId: socket.id,
      slotIndex,
      appartient: 'joueur', // c'est la carte du joueur qui se retourne
    });
  });

  // ── POUVOIR 10 : regarder une carte adverse ───────────────────────────
  socket.on('s_regarder_carte_adverse', ({ adversaireId, slotIndex }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const adversaire = salon.joueurs.find(jj => jj.id === adversaireId);
    if (!adversaire) return;
    const carte = adversaire.slots[slotIndex];
    // Envoyer la vraie carte au joueur qui regarde
    socket.emit('carte_revelee_adverse', { adversaireId, slotIndex, carte });
    // Informer l'adversaire que sa carte est regardée (retournement visible)
    const socketAdv = io.sockets.sockets.get(adversaireId);
    if (socketAdv) {
      socketAdv.emit('adversaire_regarde_carte', {
        joueurId: socket.id,
        slotIndex,
        appartient: 'adverse', // c'est la carte de l'adversaire qui se retourne
      });
    }
  });

  // ── VALET (échange de cartes) ──────────────────────────────
  socket.on('s_valet', ({ cartePiochee, slotJoueur, slotAdversaire, adversaireId }) => {
    const j = joueurs[socket.id];
    if (!j || !j.salonCode) return;
    const salon = salons[j.salonCode];
    if (!salon || !salon.partie) return;
    const p = salon.partie;

    if (salon.joueurs[p.tourIdx].id !== socket.id) return;

    // Trouver les deux joueurs dans le salon
    const jSlots = salon.joueurs.find(jj => jj.id === socket.id);
    const adversaire = salon.joueurs.find(jj => jj.id === adversaireId);
    if (!jSlots || !adversaire) return;

    // Effectuer l'échange
    const carteJoueur = jSlots.slots[slotJoueur];
    const carteAdv = adversaire.slots[slotAdversaire];

    jSlots.slots[slotJoueur] = carteAdv || null;
    if (adversaire.slots[slotAdversaire] !== undefined) {
      adversaire.slots[slotAdversaire] = carteJoueur || null;
    }

    // Défausser la carte piochée
    p.defausse.push(cartePiochee);
    const defausseTop = p.defausse[p.defausse.length - 1];

    // Confirmer au joueur qui a joué le Valet
    socket.emit('valet_ok', {
      slotJoueur,
      nouvelleCarteJoueur: carteAdv || null,
      defausseTop,
    });

    // Informer l'adversaire que sa carte a changé
    const socketAdv = io.sockets.sockets.get(adversaireId);
    if (socketAdv) {
      socketAdv.emit('valet_subi', {
        slotJoueur: slotAdversaire,
        nouvelleCarteJoueur: carteJoueur || null,
        defausseTop,
      });
    }

    // Informer les autres joueurs de la défausse
    io.to(j.salonCode).emit('carte_defaussee', {
      joueurId: socket.id,
      carte: cartePiochee,
      defausseTop,
    });

    if (p.dernierTour) {
      p.dernierTourJoue.add(socket.id);
    }
    prochainTour(j.salonCode);
  });

  socket.on('disconnect', () => {
    // Nettoyer l'index codeAmi
    const j = joueurs[socket.id];
    if (j && j.codeAmi && codeAmiIndex[j.codeAmi]) delete codeAmiIndex[j.codeAmi];
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
        // Supprimer le salon après un délai pour laisser le message arriver
        setTimeout(() => { delete salons[j.salonCode]; }, 3000);
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

const port = process.env.PORT || 3000;

httpServer.listen(port, () => {
  console.log(`\n🃏 Kobo Cards — Serveur multijoueur`);
  console.log(`   Port : ${port}`);
  console.log(`   Prêt !\n`);
});
}
demarrerServeur().catch(err => console.error("Erreur critique :", err));