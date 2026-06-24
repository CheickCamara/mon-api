require('dotenv').config()
const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { createClient } = require('@supabase/supabase-js')
const { Resend } = require('resend')
const multer = require('multer')

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const app = express()
const PORT = 3001
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

async function geocodeAdresse(adresse) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(adresse)}&limit=1`
    const res = await fetch(url, { headers: { 'User-Agent': 'PopFluence/1.0 (camaracheick1998@gmail.com)' } })
    const data = await res.json()
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
    }
  } catch { /* géocodage optionnel, échec silencieux */ }
  return { lat: null, lng: null }
}
const JWT_SECRET = process.env.JWT_SECRET

app.use(cors({
  origin: [
    'https://mon-site-omega-two.vercel.app',
    'https://popfluence.io',
    'https://www.popfluence.io',
    'http://localhost:5173',
  ],
  credentials: true,
}))
app.use(express.json())

// Middleware protection admin via token JWT
function adminAuth(req, res, next) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' })
  }
  try {
    jwt.verify(auth.slice(7), JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' })
  }
}

// Middleware protection utilisateur connecté (influenceur ou restaurateur)
function userAuth(req, res, next) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Tu dois être connecté' })
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Session expirée, reconnecte-toi' })
  }
}

// ─── ROUTES PUBLIQUES ─────────────────────────────────────────────────────────

// Tous les restaurants
app.get('/restaurants', async (req, res) => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, nom, adresse, description, telephone, statut, info, lat, lng, image, siret')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Géocode tous les restaurants sans coordonnées (à appeler une fois)
app.post('/admin/geocode-restaurants', adminAuth, async (req, res) => {

  const { data: restos } = await supabase.from('restaurants').select('id, nom, adresse, lat').is('lat', null)
  if (!restos || restos.length === 0) return res.json({ message: 'Aucun restaurant à géocoder', count: 0 })

  let count = 0
  for (const r of restos) {
    if (!r.adresse) continue
    await new Promise(resolve => setTimeout(resolve, 1100)) // respect rate limit Nominatim
    const coords = await geocodeAdresse(r.adresse)
    if (coords.lat) {
      await supabase.from('restaurants').update({ lat: coords.lat, lng: coords.lng }).eq('id', r.id)
      count++
    }
  }
  res.json({ message: `${count} restaurant(s) géocodés`, count })
})

// Un restaurant par id
app.get('/restaurants/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, nom, adresse, description, telephone, statut, info, lat, lng, image')
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: 'Restaurant non trouvé' })
  res.json(data)
})

// Toutes les offres actives (avec infos du restaurant)
app.get('/offres', async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select(`
      id, titre, description, menu, valeur_indicative,
      contrepartie, nombre_places, places_restantes,
      tranche_min, tranche_max, statut, conditions, date_creation,
      restaurants (id, nom, adresse, lat, lng, image)
    `)
    .eq('statut', 'active')
    .gt('places_restantes', 0)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Une offre par id
app.get('/offres/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select(`
      id, titre, description, menu, valeur_indicative,
      contrepartie, nombre_places, places_restantes,
      tranche_min, tranche_max, statut, conditions, date_creation,
      restaurants (id, nom, adresse, lat, lng, image)
    `)
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: 'Offre non trouvée' })
  res.json(data)
})

// Inscription influenceur
app.post('/inscription', async (req, res) => {
  const { nom, email, mot_de_passe, reseau, abonnes } = req.body
  if (!nom || !email || !mot_de_passe || !reseau || !abonnes) {
    return res.status(400).json({ error: 'Tous les champs sont requis' })
  }
  if (!['instagram', 'tiktok'].includes(reseau)) {
    return res.status(400).json({ error: 'Réseau invalide (instagram ou tiktok)' })
  }
  if (Number(abonnes) < 1000) {
    return res.status(400).json({ error: 'Minimum 1 000 abonnés requis' })
  }
  const { data, error } = await supabase
    .from('influenceurs')
    .insert({ nom, email, mot_de_passe, reseau, abonnes: Number(abonnes) })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' })
    return res.status(500).json({ error: error.message })
  }
  res.json({ id: data.id, message: 'Inscription enregistrée' })
})

// Candidature d'un influenceur à une offre
app.post('/candidatures', userAuth, async (req, res) => {
  const { offre_id } = req.body
  const influenceur_id = req.user.id
  if (!offre_id) return res.status(400).json({ error: 'Champs manquants' })
  if (req.user.role !== 'influenceur') return res.status(403).json({ error: 'Seuls les influenceurs peuvent candidater' })

  // Vérifier que l'offre est active et a des places
  const { data: offre, error: offreError } = await supabase
    .from('offres')
    .select('id, places_restantes, tranche_min, tranche_max, restaurant_id')
    .eq('id', offre_id)
    .single()
  if (offreError || !offre) return res.status(404).json({ error: 'Offre non trouvée' })
  if (offre.places_restantes <= 0) return res.status(400).json({ error: 'Plus de places disponibles' })

  // Vérifier l'éligibilité de l'influenceur
  const { data: influenceur } = await supabase
    .from('influenceurs')
    .select('abonnes, statut')
    .eq('id', influenceur_id)
    .single()
  if (!influenceur) return res.status(404).json({ error: 'Influenceur non trouvé' })
  if (influenceur.statut !== 'valide') {
    return res.status(403).json({ error: 'Ton compte doit être validé par notre équipe avant de pouvoir candidater' })
  }
  if (influenceur.abonnes < offre.tranche_min) {
    return res.status(400).json({ error: `Minimum ${offre.tranche_min} abonnés requis pour cette offre` })
  }
  if (offre.tranche_max && influenceur.abonnes > offre.tranche_max) {
    return res.status(400).json({ error: 'Ton audience dépasse le ciblage de cette offre' })
  }

  // Vérifier qu'il n'a pas déjà candidaté
  const { data: dejaCandidat } = await supabase
    .from('candidatures')
    .select('id')
    .eq('influenceur_id', influenceur_id)
    .eq('offre_id', offre_id)
    .single()
  if (dejaCandidat) return res.status(400).json({ error: 'Tu as déjà candidaté à cette offre' })

  const { data, error } = await supabase
    .from('candidatures')
    .insert({ influenceur_id, offre_id, restaurant_id: offre.restaurant_id })
    .select('id')
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // Notifier le restaurateur par e-mail
  const { data: restaurateurData } = await supabase
    .from('restaurateurs')
    .select('email, nom')
    .eq('restaurant_id', offre.restaurant_id)
    .single()

  const { data: offreDetails } = await supabase
    .from('offres')
    .select('titre')
    .eq('id', offre_id)
    .single()

  if (restaurateurData?.email && resend) {
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: restaurateurData.email,
      subject: '🎉 Nouvelle candidature reçue !',
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
          <h2 style="color: #7c3aed;">Nouvelle candidature sur Pop Fluence</h2>
          <p>Bonjour ${restaurateurData.nom},</p>
          <p>Un influenceur vient de candidater à votre offre <strong>${offreDetails?.titre ?? ''}</strong>.</p>
          <p>Connectez-vous à votre espace pour consulter son profil et accepter ou refuser sa candidature.</p>
          <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
            Voir la candidature
          </a>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  // Confirmer la candidature à l'influenceur
  const { data: influenceurData } = await supabase
    .from('influenceurs')
    .select('nom, email')
    .eq('id', influenceur_id)
    .single()

  if (influenceurData?.email && resend) {
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: influenceurData.email,
      subject: '📩 Ta candidature a bien été envoyée !',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#7c3aed;">📩 Candidature reçue !</h2>
          <p>Bonjour ${influenceurData.nom},</p>
          <p>Ta candidature pour l'offre <strong>${offreDetails?.titre ?? ''}</strong> a bien été envoyée au restaurant.</p>
          <p>Le restaurant a <strong>48h</strong> pour consulter ton profil et te répondre. Tu recevras un email dès qu'une décision est prise.</p>
          <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
            Voir mes candidatures
          </a>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  res.json({ id: data.id, message: 'Candidature envoyée' })
})

// Mon profil
app.get('/mon-espace/profil', userAuth, async (req, res) => {
  const [{ data, error }, { count }] = await Promise.all([
    supabase.from('influenceurs').select('id, nom, email, reseau, abonnes, statut, date_inscription, pseudo').eq('id', req.user.id).single(),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }).eq('influenceur_id', req.user.id).eq('statut', 'honoree'),
  ])
  if (error || !data) return res.status(404).json({ error: 'Profil introuvable' })
  res.json({ ...data, collaborations_honorees: count ?? 0 })
})

// Modifier mon profil
app.put('/mon-espace/profil', userAuth, async (req, res) => {
  const { nom, reseau, abonnes, mot_de_passe, pseudo } = req.body
  const updates = {}
  if (nom) updates.nom = nom
  if (reseau) updates.reseau = reseau
  if (abonnes) updates.abonnes = Number(abonnes)
  if (mot_de_passe) updates.mot_de_passe = await bcrypt.hash(mot_de_passe, 10)
  if (pseudo !== undefined && pseudo !== null) updates.pseudo = pseudo.replace(/^@/, '').trim()

  const { error } = await supabase.from('influenceurs').update(updates).eq('id', req.user.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Profil mis à jour' })
})

// Mes candidatures (influenceur connecté)
app.get('/mon-espace/candidatures', userAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('candidatures')
    .select(`
      id, statut, date_candidature, lien_publication, post_publie, capture_story,
      offres (titre, contrepartie, valeur_indicative, restaurants (nom, adresse))
    `)
    .eq('influenceur_id', req.user.id)
    .order('date_candidature', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ─── ESPACE RESTAURATEUR ──────────────────────────────────────────────────────

// Mon restaurant
app.get('/restaurateur/mon-restaurant', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, nom, adresse, description, telephone, statut, image, siret')
    .eq('id', req.user.restaurant_id)
    .single()
  if (error || !data) return res.status(404).json({ error: 'Restaurant introuvable' })
  res.json(data)
})

// Mes offres
app.get('/restaurateur/mes-offres', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { data, error } = await supabase
    .from('offres')
    .select('id, titre, description, menu, conditions, contrepartie, nombre_places, places_restantes, valeur_indicative, statut, tranche_min, tranche_max')
    .eq('restaurant_id', req.user.restaurant_id)
    .order('id', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Candidatures reçues pour mon restaurant
app.get('/restaurateur/candidatures', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { data, error } = await supabase
    .from('candidatures')
    .select(`
      id, statut, date_candidature, post_publie, lien_publication, capture_story, influenceur_id,
      influenceurs (nom, email, reseau, abonnes, pseudo),
      offres (titre, contrepartie)
    `)
    .eq('restaurant_id', req.user.restaurant_id)
    .order('date_candidature', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Soumettre la preuve de publication (lien ou capture story)
app.put('/mon-espace/candidatures/:id/publication', userAuth, async (req, res) => {
  const { lien_publication, capture_story } = req.body
  if (!lien_publication && !capture_story) return res.status(400).json({ error: 'Lien ou capture requis' })

  const { data: cand } = await supabase
    .from('candidatures')
    .select('id, statut, influenceur_id')
    .eq('id', req.params.id)
    .single()

  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })
  if (cand.influenceur_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' })
  if (cand.statut !== 'valide') return res.status(400).json({ error: 'Ta candidature doit être acceptée avant de soumettre une publication' })

  const updates = { post_publie: true }
  if (lien_publication) updates.lien_publication = lien_publication
  if (capture_story) updates.capture_story = capture_story

  const { error } = await supabase.from('candidatures').update(updates).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Publication enregistrée, merci !' })
})

// Upload capture story vers Supabase Storage
app.post('/mon-espace/candidatures/:id/upload-story', userAuth, upload.single('fichier'), async (req, res) => {
  const { data: cand } = await supabase
    .from('candidatures')
    .select('id, statut, influenceur_id')
    .eq('id', req.params.id)
    .single()

  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })
  if (cand.influenceur_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' })
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' })

  const { buffer, mimetype, originalname } = req.file
  const ext = originalname.split('.').pop() || 'jpg'
  const fileName = `story_${req.params.id}_${Date.now()}.${ext}`

  const { error } = await supabase.storage
    .from('Publications')
    .upload(fileName, buffer, { contentType: mimetype, upsert: true })

  if (error) return res.status(500).json({ error: error.message })

  const { data: urlData } = supabase.storage.from('Publications').getPublicUrl(fileName)
  res.json({ url: urlData.publicUrl })
})

// Accepter ou refuser une candidature (restaurateur)
app.put('/restaurateur/candidatures/:id', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { statut } = req.body
  if (!['valide', 'refuse', 'honoree'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' })

  // Vérifier que la candidature appartient bien à ce restaurant
  const { data: cand } = await supabase
    .from('candidatures')
    .select('id, offre_id, restaurant_id, statut, influenceurs (nom, email), offres (titre, restaurants (nom))')
    .eq('id', req.params.id)
    .single()

  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })
  if (cand.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ error: 'Accès refusé' })

  const { error } = await supabase.from('candidatures').update({ statut }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  // Décrémenter uniquement si on passe à valide depuis un autre statut
  if (statut === 'valide' && cand.statut !== 'valide' && cand.offre_id) {
    await supabase.rpc('decrement_places', { p_offre_id: cand.offre_id })
  }

  // Notifier l'influenceur par e-mail
  const influenceur = cand.influenceurs
  const offre = cand.offres
  if (influenceur?.email && resend && statut !== 'honoree') {
    const accepte = statut === 'valide'
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: influenceur.email,
      subject: accepte ? '🎉 Ta candidature a été acceptée !' : '❌ Ta candidature n\'a pas été retenue',
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
          <h2 style="color: #7c3aed;">${accepte ? '🎉 Bonne nouvelle !' : 'Candidature non retenue'}</h2>
          <p>Bonjour ${influenceur.nom},</p>
          ${accepte
            ? `<p>Ta candidature pour l'offre <strong>${offre?.titre ?? ''}</strong> chez <strong>${offre?.restaurants?.nom ?? ''}</strong> a été <strong style="color:#22c55e;">acceptée</strong> !</p>
               <p>Le restaurant va te contacter prochainement. Prépare ton contenu ✨</p>`
            : `<p>Ta candidature pour l'offre <strong>${offre?.titre ?? ''}</strong> chez <strong>${offre?.restaurants?.nom ?? ''}</strong> n'a pas été retenue cette fois.</p>
               <p>D'autres offres t'attendent sur la plateforme !</p>`
          }
          <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
            Voir mes candidatures
          </a>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  // Email de confirmation "collaboration honorée"
  if (statut === 'honoree' && influenceur?.email && resend) {
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: influenceur.email,
      subject: '🏆 Collaboration honorée — merci !',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#7c3aed;">🏆 Collaboration honorée !</h2>
          <p>Bonjour ${influenceur.nom},</p>
          <p>Le restaurant <strong>${offre?.restaurants?.nom ?? ''}</strong> a confirmé ta publication pour l'offre <strong>${offre?.titre ?? ''}</strong>.</p>
          <p>Cette collaboration est désormais comptabilisée dans ton historique. Bravo ! 🎉</p>
          <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
            Voir mon profil
          </a>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  res.json({ success: true })
})

// ─── AVIS / NOTATION ──────────────────────────────────────────────────────────

// Soumettre un avis (influenceur ou restaurateur)
app.post('/avis', userAuth, async (req, res) => {
  const { candidature_id, note, commentaire } = req.body
  if (!candidature_id || !note) return res.status(400).json({ error: 'candidature_id et note requis' })
  if (note < 1 || note > 5) return res.status(400).json({ error: 'La note doit être entre 1 et 5' })

  const auteur_role = req.user.role

  // Vérifier que la candidature est honorée et appartient bien à cet utilisateur
  const { data: cand } = await supabase
    .from('candidatures')
    .select('id, statut, influenceur_id, restaurant_id')
    .eq('id', candidature_id)
    .single()

  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })
  if (cand.statut !== 'honoree') return res.status(400).json({ error: 'La collaboration doit être honorée pour laisser un avis' })
  if (auteur_role === 'influenceur' && cand.influenceur_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' })
  if (auteur_role === 'restaurateur' && cand.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ error: 'Non autorisé' })

  const { error } = await supabase.from('avis').insert({ candidature_id, auteur_role, note, commentaire: commentaire || null })
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Tu as déjà laissé un avis pour cette collaboration' })
    return res.status(500).json({ error: error.message })
  }
  res.json({ message: 'Avis enregistré' })
})

// Récupérer les avis reçus par un restaurant
app.get('/restaurants/:id/avis', async (req, res) => {
  const { data, error } = await supabase
    .from('avis')
    .select('note, commentaire, created_at, candidatures!inner(restaurant_id)')
    .eq('auteur_role', 'influenceur')
    .eq('candidatures.restaurant_id', req.params.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  const notes = data.map(a => a.note)
  const moyenne = notes.length ? (notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : null
  res.json({ moyenne, total: notes.length, avis: data })
})

// Récupérer les avis reçus par un influenceur
app.get('/mon-espace/avis-recus', userAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('avis')
    .select('note, commentaire, created_at, candidatures!inner(influenceur_id)')
    .eq('auteur_role', 'restaurateur')
    .eq('candidatures.influenceur_id', req.user.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  const notes = data.map(a => a.note)
  const moyenne = notes.length ? (notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : null
  res.json({ moyenne, total: notes.length, avis: data })
})

// Note moyenne d'un influenceur (accessible aux restaurateurs)
app.get('/influenceurs/:id/avis', userAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('avis')
    .select('note, candidatures!inner(influenceur_id)')
    .eq('auteur_role', 'restaurateur')
    .eq('candidatures.influenceur_id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  const notes = data.map(a => a.note)
  const moyenne = notes.length ? (notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : null
  res.json({ moyenne, total: notes.length })
})

// Vérifier si l'utilisateur a déjà laissé un avis pour une candidature
app.get('/avis/:candidature_id', userAuth, async (req, res) => {
  const { data } = await supabase
    .from('avis')
    .select('id, note, commentaire')
    .eq('candidature_id', req.params.candidature_id)
    .eq('auteur_role', req.user.role)
    .single()
  res.json(data ?? null)
})

// ─── MESSAGERIE ───────────────────────────────────────────────────────────────

// Récupérer les messages d'une candidature
app.get('/messages/:candidature_id', userAuth, async (req, res) => {
  const candId = Number(req.params.candidature_id)

  // Vérifier que l'utilisateur a accès à cette candidature
  const { data: cand } = await supabase
    .from('candidatures')
    .select('influenceur_id, restaurant_id')
    .eq('id', candId)
    .single()
  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })

  const ok = req.user.role === 'influenceur'
    ? cand.influenceur_id === req.user.id
    : cand.restaurant_id === req.user.restaurant_id
  if (!ok) return res.status(403).json({ error: 'Accès refusé' })

  const { data, error } = await supabase
    .from('messages')
    .select('id, expediteur, contenu, date_envoi')
    .eq('candidature_id', candId)
    .order('date_envoi', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Envoyer un message
app.post('/messages/:candidature_id', userAuth, async (req, res) => {
  const candId = Number(req.params.candidature_id)
  const { contenu } = req.body
  if (!contenu?.trim()) return res.status(400).json({ error: 'Message vide' })

  // Vérifier accès + récupérer infos pour l'email
  const { data: cand } = await supabase
    .from('candidatures')
    .select(`
      influenceur_id, restaurant_id,
      influenceurs (nom, email),
      offres (titre, restaurants (nom))
    `)
    .eq('id', candId)
    .single()
  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })

  const ok = req.user.role === 'influenceur'
    ? cand.influenceur_id === req.user.id
    : cand.restaurant_id === req.user.restaurant_id
  if (!ok) return res.status(403).json({ error: 'Accès refusé' })

  const { data, error } = await supabase
    .from('messages')
    .insert({ candidature_id: candId, expediteur: req.user.role, contenu: contenu.trim() })
    .select('id, expediteur, contenu, date_envoi')
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // Notifier le destinataire par email
  if (resend) {
    const estRestaurateur = req.user.role === 'restaurateur'
    const offreTitre = cand.offres?.titre ?? ''
    const siteUrl = 'https://mon-site-omega-two.vercel.app'

    let destinataireEmail = null
    let destinataireNom = null
    let expediteurNom = null

    if (estRestaurateur) {
      // Restaurateur → influenceur
      destinataireEmail = cand.influenceurs?.email
      destinataireNom = cand.influenceurs?.nom
      expediteurNom = cand.offres?.restaurants?.nom
    } else {
      // Influenceur → restaurateur : récupérer l'email du restaurateur
      const { data: resto } = await supabase
        .from('restaurateurs')
        .select('nom, email')
        .eq('restaurant_id', cand.restaurant_id)
        .single()
      destinataireEmail = resto?.email
      destinataireNom = resto?.nom
      expediteurNom = cand.influenceurs?.nom
    }

    if (destinataireEmail) {
      await resend.emails.send({
        from: 'Pop Fluence <onboarding@resend.dev>',
        to: destinataireEmail,
        subject: `💬 Nouveau message de ${expediteurNom}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
            <h2 style="color:#7c3aed;">💬 Nouveau message</h2>
            <p>Bonjour ${destinataireNom},</p>
            <p><strong>${expediteurNom}</strong> t'a envoyé un message concernant l'offre <strong>${offreTitre}</strong> :</p>
            <div style="background:#f5f3ff;border-left:4px solid #7c3aed;padding:12px 16px;border-radius:4px;margin:16px 0;font-style:italic;">
              "${contenu.trim()}"
            </div>
            <a href="${siteUrl}" style="display:inline-block;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
              Répondre →
            </a>
            <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
          </div>
        `,
      }).catch(() => {})
    }
  }

  res.json(data)
})

// Nombre de messages non lus pour une candidature
app.get('/messages/:candidature_id/non-lus', userAuth, async (req, res) => {
  const candId = Number(req.params.candidature_id)
  const { data: cand } = await supabase.from('candidatures').select('influenceur_id, restaurant_id').eq('id', candId).single()
  if (!cand) return res.status(404).json({ error: 'Introuvable' })
  const ok = req.user.role === 'influenceur' ? cand.influenceur_id === req.user.id : cand.restaurant_id === req.user.restaurant_id
  if (!ok) return res.status(403).json({ error: 'Accès refusé' })

  const monRole = req.user.role
  const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true })
    .eq('candidature_id', candId).eq('lu', false).neq('expediteur', monRole)
  res.json({ non_lus: count ?? 0 })
})

// Marquer les messages comme lus
app.put('/messages/:candidature_id/lus', userAuth, async (req, res) => {
  const candId = Number(req.params.candidature_id)
  const { data: cand } = await supabase.from('candidatures').select('influenceur_id, restaurant_id').eq('id', candId).single()
  if (!cand) return res.status(404).json({ error: 'Introuvable' })
  const ok = req.user.role === 'influenceur' ? cand.influenceur_id === req.user.id : cand.restaurant_id === req.user.restaurant_id
  if (!ok) return res.status(403).json({ error: 'Accès refusé' })

  await supabase.from('messages').update({ lu: true }).eq('candidature_id', candId).neq('expediteur', req.user.role)
  res.json({ success: true })
})

// Créer une offre (restaurateur)
app.post('/restaurateur/offres', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, conditions } = req.body
  if (!titre || !contrepartie || !nombre_places) return res.status(400).json({ error: 'Champs obligatoires manquants' })
  const { data, error } = await supabase
    .from('offres')
    .insert({
      restaurant_id: req.user.restaurant_id,
      titre, description, menu, valeur_indicative,
      contrepartie, nombre_places, places_restantes: nombre_places,
      tranche_min: tranche_min || 1000, tranche_max, conditions,
      statut: 'en_attente_validation',
    })
    .select('id')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ id: data.id, message: 'Offre soumise pour validation' })
})

// Modifier une offre (restaurateur propriétaire)
app.put('/restaurateur/offres/:id', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, conditions } = req.body

  const { data: offre } = await supabase.from('offres').select('restaurant_id, nombre_places, places_restantes').eq('id', req.params.id).single()
  if (!offre || offre.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ error: 'Non autorisé' })

  const diff = nombre_places - offre.nombre_places
  const nouveauxRestants = Math.max(0, offre.places_restantes + diff)

  const { error } = await supabase.from('offres').update({
    titre, description, menu, valeur_indicative, contrepartie,
    nombre_places, places_restantes: nouveauxRestants,
    tranche_min: tranche_min || 1000, tranche_max, conditions,
    statut: 'en_attente_validation',
  }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Offre mise à jour, en attente de revalidation' })
})

// Supprimer une offre (restaurateur propriétaire)
app.delete('/restaurateur/offres/:id', userAuth, async (req, res) => {
  if (req.user.role !== 'restaurateur') return res.status(403).json({ error: 'Accès réservé aux restaurateurs' })
  const { data: offre } = await supabase.from('offres').select('restaurant_id').eq('id', req.params.id).single()
  if (!offre || offre.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ error: 'Non autorisé' })
  const { error } = await supabase.from('offres').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ message: 'Offre supprimée' })
})

// ─── AUTHENTIFICATION ─────────────────────────────────────────────────────────

// Inscription influenceur
app.post('/auth/inscription-influenceur', async (req, res) => {
  const { nom, email, mot_de_passe, reseau, abonnes } = req.body
  if (!nom || !email || !mot_de_passe || !reseau || !abonnes) {
    return res.status(400).json({ error: 'Tous les champs sont requis' })
  }
  if (!['instagram', 'tiktok'].includes(reseau)) {
    return res.status(400).json({ error: 'Réseau invalide (instagram ou tiktok)' })
  }
  if (Number(abonnes) < 1000) {
    return res.status(400).json({ error: 'Minimum 1 000 abonnés requis' })
  }
  // Vérifier que l'email n'est pas déjà utilisé comme restaurateur
  const { data: restoExistant } = await supabase.from('restaurateurs').select('id').eq('email', email).single()
  if (restoExistant) return res.status(409).json({ error: 'Cet email est déjà utilisé pour un compte restaurateur. Utilise une adresse différente.' })

  const hash = await bcrypt.hash(mot_de_passe, 10)
  const { data, error } = await supabase
    .from('influenceurs')
    .insert({ nom, email, mot_de_passe: hash, reseau, abonnes: Number(abonnes) })
    .select('id, nom, email, reseau, abonnes, statut')
    .single()
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' })
    return res.status(500).json({ error: error.message })
  }
  const token = jwt.sign({ id: data.id, role: 'influenceur' }, JWT_SECRET, { expiresIn: '7d' })
  res.json({ token, utilisateur: data })
})

// Inscription restaurateur
app.post('/auth/inscription-restaurateur', async (req, res) => {
  const { nom, email, mot_de_passe, nom_etablissement, adresse, siret, telephone, description } = req.body
  if (!nom || !email || !mot_de_passe || !nom_etablissement || !adresse || !siret) {
    return res.status(400).json({ error: 'Tous les champs sont requis' })
  }
  const siretNettoyé = siret.replace(/\s/g, '')
  if (siretNettoyé.length !== 14) {
    return res.status(400).json({ error: 'Le SIRET doit contenir 14 chiffres' })
  }
  // Vérifier le SIRET via l'API Sirene
  try {
    const sirenRes = await fetch(`https://entreprise.data.gouv.fr/api/sirene/v3/etablissements/${siretNettoyé}`)
    if (sirenRes.status === 404) {
      return res.status(400).json({ error: 'SIRET introuvable. Vérifie le numéro saisi.' })
    }
    if (sirenRes.ok) {
      const sirenData = await sirenRes.json()
      const etat = sirenData.etablissement?.etat_administratif_etablissement
      if (etat === 'F') {
        return res.status(400).json({ error: 'Cet établissement est fermé (SIRET inactif).' })
      }
    }
  } catch {
    // Si l'API Sirene est indisponible, on laisse passer
  }
  // Vérifier que l'email n'est pas déjà utilisé comme influenceur
  const { data: influExistant } = await supabase.from('influenceurs').select('id').eq('email', email).single()
  if (influExistant) return res.status(409).json({ error: 'Cet email est déjà utilisé pour un compte influenceur. Utilise une adresse différente.' })

  const hash = await bcrypt.hash(mot_de_passe, 10)

  const coords = await geocodeAdresse(adresse)

  const { data: resto, error: restoError } = await supabase
    .from('restaurants')
    .insert({ nom: nom_etablissement, adresse, email, statut: 'en_attente', siret: siretNettoyé, telephone: telephone || null, description: description || null, lat: coords.lat, lng: coords.lng })
    .select('id')
    .single()
  if (restoError) return res.status(500).json({ error: restoError.message })

  const { data, error } = await supabase
    .from('restaurateurs')
    .insert({ nom, email, mot_de_passe: hash, restaurant_id: resto.id, siret: siretNettoyé })
    .select('id, nom, email, restaurant_id')
    .single()
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' })
    return res.status(500).json({ error: error.message })
  }
  const token = jwt.sign({ id: data.id, role: 'restaurateur', restaurant_id: resto.id }, JWT_SECRET, { expiresIn: '7d' })
  res.json({ token, utilisateur: { ...data, role: 'restaurateur' } })
})

// Connexion (influenceur ou restaurateur)
app.post('/auth/connexion', async (req, res) => {
  const { email, mot_de_passe } = req.body
  if (!email || !mot_de_passe) return res.status(400).json({ error: 'Email et mot de passe requis' })

  // Chercher d'abord dans influenceurs
  const { data: influenceur } = await supabase
    .from('influenceurs')
    .select('id, nom, email, mot_de_passe, reseau, abonnes, statut')
    .eq('email', email)
    .single()

  if (influenceur) {
    const ok = await bcrypt.compare(mot_de_passe, influenceur.mot_de_passe)
    if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' })
    const token = jwt.sign({ id: influenceur.id, role: 'influenceur' }, JWT_SECRET, { expiresIn: '7d' })
    const { mot_de_passe: _, ...utilisateur } = influenceur
    return res.json({ token, utilisateur: { ...utilisateur, role: 'influenceur' } })
  }

  // Chercher dans restaurateurs
  const { data: restaurateur } = await supabase
    .from('restaurateurs')
    .select('id, nom, email, mot_de_passe, restaurant_id')
    .eq('email', email)
    .single()

  if (restaurateur) {
    const ok = await bcrypt.compare(mot_de_passe, restaurateur.mot_de_passe)
    if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' })
    const token = jwt.sign({ id: restaurateur.id, role: 'restaurateur', restaurant_id: restaurateur.restaurant_id }, JWT_SECRET, { expiresIn: '7d' })
    const { mot_de_passe: _, ...utilisateur } = restaurateur
    return res.json({ token, utilisateur: { ...utilisateur, role: 'restaurateur' } })
  }

  return res.status(404).json({ error: 'Aucun compte trouvé avec cet email' })
})

// ─── MOT DE PASSE OUBLIÉ ──────────────────────────────────────────────────────

app.post('/auth/mot-de-passe-oublie', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email requis' })

  // Vérifier si l'email existe (influenceur ou restaurateur)
  const { data: influenceur } = await supabase.from('influenceurs').select('id, nom').eq('email', email).single()
  const { data: restaurateur } = await supabase.from('restaurateurs').select('id, nom').eq('email', email).single()
  const utilisateur = influenceur || restaurateur

  // Toujours répondre OK pour ne pas révéler si l'email existe
  if (!utilisateur || !resend) return res.json({ message: 'Si un compte existe, un email a été envoyé.' })

  const crypto = require('crypto')
  const token = crypto.randomBytes(32).toString('hex')
  const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1h

  await supabase.from('reset_tokens').insert({ email, token, expires_at })

  const resetUrl = `https://mon-site-omega-two.vercel.app?reset_token=${token}`

  await resend.emails.send({
    from: 'Pop Fluence <onboarding@resend.dev>',
    to: email,
    subject: '🔑 Réinitialisation de ton mot de passe',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <h2 style="color:#7c3aed;">🔑 Réinitialisation du mot de passe</h2>
        <p>Bonjour ${utilisateur.nom},</p>
        <p>Tu as demandé à réinitialiser ton mot de passe. Clique sur le bouton ci-dessous :</p>
        <a href="${resetUrl}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
          Réinitialiser mon mot de passe →
        </a>
        <p style="margin-top:16px;color:#888;font-size:0.85rem;">Ce lien est valable <strong>1 heure</strong>. Si tu n'as pas fait cette demande, ignore cet email.</p>
        <p style="color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
      </div>
    `,
  }).catch(() => {})

  res.json({ message: 'Si un compte existe, un email a été envoyé.' })
})

app.post('/auth/reset-mot-de-passe', async (req, res) => {
  const { token, nouveau_mot_de_passe } = req.body
  if (!token || !nouveau_mot_de_passe) return res.status(400).json({ error: 'Token et nouveau mot de passe requis' })
  if (nouveau_mot_de_passe.length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' })

  const { data: reset } = await supabase.from('reset_tokens').select('*').eq('token', token).eq('used', false).single()
  if (!reset) return res.status(400).json({ error: 'Lien invalide ou expiré' })
  if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: 'Lien expiré' })

  const hash = await bcrypt.hash(nouveau_mot_de_passe, 10)

  // Mettre à jour dans influenceurs ou restaurateurs
  const { data: influenceur } = await supabase.from('influenceurs').select('id').eq('email', reset.email).single()
  if (influenceur) {
    await supabase.from('influenceurs').update({ mot_de_passe: hash }).eq('email', reset.email)
  } else {
    await supabase.from('restaurateurs').update({ mot_de_passe: hash }).eq('email', reset.email)
  }

  await supabase.from('reset_tokens').update({ used: true }).eq('token', token)

  res.json({ message: 'Mot de passe mis à jour avec succès' })
})

// ─── ROUTES ADMIN ─────────────────────────────────────────────────────────────

// Connexion admin
app.post('/admin/login', (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' })
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' })
  res.json({ token })
})

// Statistiques générales
app.get('/admin/stats', adminAuth, async (req, res) => {
  const [
    { count: total_influenceurs },
    { count: en_attente },
    { count: valides },
    { count: refuses },
    { count: total_candidatures },
    { count: candidatures_en_attente },
    { count: posts_publies },
    { count: collaborations_honorees },
    { count: total_restaurants },
    { count: restaurants_en_attente },
    { count: total_offres },
    { count: offres_en_attente },
  ] = await Promise.all([
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }),
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }).eq('statut', 'en_attente'),
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }).eq('statut', 'valide'),
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }).eq('statut', 'refuse'),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }).eq('statut', 'en_attente'),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }).eq('post_publie', true),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }).eq('statut', 'honoree'),
    supabase.from('restaurants').select('*', { count: 'exact', head: true }),
    supabase.from('restaurants').select('*', { count: 'exact', head: true }).eq('statut', 'en_attente'),
    supabase.from('offres').select('*', { count: 'exact', head: true }),
    supabase.from('offres').select('*', { count: 'exact', head: true }).eq('statut', 'en_attente_validation'),
  ])

  const { data: rawInscriptions } = await supabase
    .from('influenceurs')
    .select('date_inscription')
    .gte('date_inscription', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  const parJour = {}
  for (const row of rawInscriptions || []) {
    const jour = (row.date_inscription || '').slice(0, 10)
    if (jour) parJour[jour] = (parJour[jour] || 0) + 1
  }
  const inscriptions_semaine = Object.entries(parJour).map(([jour, nb]) => ({ jour, nb })).sort((a, b) => a.jour.localeCompare(b.jour))

  res.json({
    influenceurs: { total: total_influenceurs, en_attente, valides, refuses },
    candidatures: { total: total_candidatures, en_attente: candidatures_en_attente, posts_publies, honorees: collaborations_honorees },
    restaurants: { total: total_restaurants, en_attente: restaurants_en_attente },
    offres: { total: total_offres, en_attente: offres_en_attente },
    inscriptions_semaine,
  })
})

// Liste des influenceurs
app.get('/admin/influenceurs', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('influenceurs')
    .select('id, nom, email, reseau, abonnes, statut, date_inscription')
    .order('date_inscription', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Valider ou refuser un influenceur
app.put('/admin/influenceurs/:id', adminAuth, async (req, res) => {
  const { statut } = req.body
  if (!['valide', 'refuse', 'en_attente'].includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide' })
  }
  const { data: influenceur } = await supabase.from('influenceurs').select('nom, email').eq('id', req.params.id).single()
  const { error } = await supabase.from('influenceurs').update({ statut }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  if (statut === 'valide' && influenceur?.email && resend) {
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: influenceur.email,
      subject: '🎉 Ton compte Pop Fluence est activé !',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#7c3aed;">🎉 Bienvenue sur Pop Fluence !</h2>
          <p>Bonjour ${influenceur.nom},</p>
          <p>Ton compte a été <strong style="color:#22c55e;">validé par notre équipe</strong>. Tu peux maintenant candidater aux offres des restaurants près de chez toi.</p>
          <p>Connecte-toi et découvre les offres disponibles ✨</p>
          <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
            Voir les offres →
          </a>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  if (statut === 'refuse' && influenceur?.email && resend) {
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: influenceur.email,
      subject: '❌ Ton inscription Pop Fluence n\'a pas été retenue',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#7c3aed;">Inscription non retenue</h2>
          <p>Bonjour ${influenceur.nom},</p>
          <p>Après examen de ton profil, nous ne sommes pas en mesure de valider ton inscription pour le moment.</p>
          <p style="color:#888;font-size:0.85rem;">Si tu penses qu'il s'agit d'une erreur, contacte-nous à contact@popfluence.io</p>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  res.json({ success: true })
})

// Liste des candidatures avec détails
app.get('/admin/candidatures', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('candidatures')
    .select(`
      id, statut, post_publie, lien_publication, capture_story, date_candidature,
      influenceurs (nom, reseau, abonnes, email),
      offres (titre, contrepartie),
      restaurants (nom)
    `)
    .order('date_candidature', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Valider/refuser une candidature ou marquer le post comme publié
app.put('/admin/candidatures/:id', adminAuth, async (req, res) => {
  const { statut, post_publie } = req.body
  const updates = {}
  if (statut !== undefined) {
    if (!['en_attente', 'valide', 'refuse'].includes(statut)) {
      return res.status(400).json({ error: 'Statut invalide' })
    }
    updates.statut = statut
  }
  if (post_publie !== undefined) updates.post_publie = post_publie

  const { data: candAvant } = await supabase.from('candidatures').select('statut, offre_id').eq('id', req.params.id).single()
  const { error } = await supabase.from('candidatures').update(updates).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  // Décrémenter places_restantes uniquement si on passe à valide depuis un autre statut
  if (statut === 'valide' && candAvant?.statut !== 'valide' && candAvant?.offre_id) {
    await supabase.rpc('decrement_places', { p_offre_id: candAvant.offre_id })
  }

  // Notifier l'influenceur si la candidature est validée ou refusée
  if (statut === 'valide' || statut === 'refuse') {
    const { data: cand } = await supabase
      .from('candidatures')
      .select('influenceurs (nom, email), offres (titre, restaurants (nom))')
      .eq('id', req.params.id)
      .single()

    const influenceur = cand?.influenceurs
    const offre = cand?.offres

    if (influenceur?.email && resend) {
      const accepte = statut === 'valide'
      await resend.emails.send({
        from: 'Pop Fluence <onboarding@resend.dev>',
        to: influenceur.email,
        subject: accepte ? '🎉 Ta candidature a été acceptée !' : '❌ Ta candidature n\'a pas été retenue',
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color: #7c3aed;">
              ${accepte ? '🎉 Bonne nouvelle !' : 'Candidature non retenue'}
            </h2>
            <p>Bonjour ${influenceur.nom},</p>
            ${accepte
              ? `<p>Ta candidature pour l'offre <strong>${offre?.titre ?? ''}</strong> chez <strong>${offre?.restaurants?.nom ?? ''}</strong> a été <strong style="color:#22c55e;">acceptée</strong> !</p>
                 <p>Le restaurant va te contacter prochainement pour organiser ta visite. Prépare ton contenu ✨</p>`
              : `<p>Ta candidature pour l'offre <strong>${offre?.titre ?? ''}</strong> chez <strong>${offre?.restaurants?.nom ?? ''}</strong> n'a malheureusement pas été retenue cette fois.</p>
                 <p>Ne te décourage pas, d'autres offres t'attendent sur la plateforme !</p>`
            }
            <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
              Voir mes candidatures
            </a>
            <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
          </div>
        `,
      }).catch(() => {})
    }
  }

  res.json({ success: true })
})

// ─── ROUTES RESTAURANTS ───────────────────────────────────────────────────────

// Ajouter un restaurant
app.post('/admin/restaurants', adminAuth, async (req, res) => {
  const { nom, adresse, description, telephone, email, statut, info } = req.body
  if (!nom || !adresse) return res.status(400).json({ error: 'Nom et adresse requis' })
  const { data, error } = await supabase
    .from('restaurants')
    .insert({ nom, adresse, description, telephone, email, statut: statut || 'Ouvert', info })
    .select('id')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ id: data.id, message: 'Restaurant ajouté' })
})

// Modifier un restaurant
app.put('/admin/restaurants/:id', adminAuth, async (req, res) => {
  const { nom, adresse, description, telephone, statut, info } = req.body

  const { data: resto } = await supabase.from('restaurants').select('nom, statut, email, adresse, lat, lng').eq('id', req.params.id).single()

  const updates = { nom, adresse, description, telephone, statut, info }
  if (adresse && adresse !== resto?.adresse) {
    const coords = await geocodeAdresse(adresse)
    updates.lat = coords.lat
    updates.lng = coords.lng
  } else if (!resto?.lat) {
    const coords = await geocodeAdresse(adresse || resto?.adresse)
    updates.lat = coords.lat
    updates.lng = coords.lng
  }

  const { error } = await supabase.from('restaurants').update(updates).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  // Email de bienvenue quand le restaurant passe de en_attente à valide
  if (statut === 'valide' && resto?.statut === 'en_attente' && resto?.email && resend) {
    await resend.emails.send({
      from: 'Pop Fluence <onboarding@resend.dev>',
      to: resto.email,
      subject: '🎉 Votre restaurant est maintenant actif sur Pop Fluence !',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#7c3aed;">🎉 Bienvenue sur Pop Fluence !</h2>
          <p>Bonjour,</p>
          <p>Votre restaurant <strong>${resto.nom}</strong> a été <strong style="color:#22c55e;">validé par notre équipe</strong>. Vous pouvez maintenant publier vos premières offres et recevoir des candidatures d'influenceurs.</p>
          <a href="https://mon-site-omega-two.vercel.app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
            Accéder à mon espace →
          </a>
          <p style="margin-top:32px;color:#888;font-size:0.85rem;">L'équipe Pop Fluence</p>
        </div>
      `,
    }).catch(() => {})
  }

  res.json({ success: true })
})

// Supprimer un restaurant
app.delete('/admin/restaurants/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('restaurants').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// ─── ROUTES OFFRES ────────────────────────────────────────────────────────────

// Toutes les offres (admin)
app.get('/admin/offres', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select('*, restaurants (nom)')
    .order('date_creation', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Créer une offre
app.post('/admin/offres', adminAuth, async (req, res) => {
  const { restaurant_id, titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, conditions } = req.body
  if (!restaurant_id || !titre || !contrepartie || !nombre_places) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' })
  }
  const { data, error } = await supabase
    .from('offres')
    .insert({
      restaurant_id, titre, description, menu, valeur_indicative,
      contrepartie, nombre_places, places_restantes: nombre_places,
      tranche_min: tranche_min || 1000, tranche_max, conditions
    })
    .select('id')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ id: data.id, message: 'Offre créée' })
})

// Modifier une offre
app.put('/admin/offres/:id', adminAuth, async (req, res) => {
  const { restaurant_id, titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, statut, conditions } = req.body
  const { error } = await supabase
    .from('offres')
    .update({ restaurant_id, titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, statut, conditions })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// Supprimer une offre
app.delete('/admin/offres/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('offres').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// Purge des tokens de reset expirés au démarrage puis toutes les 24h
async function purgerTokensExpires() {
  await supabase.from('reset_tokens').delete().lt('expires_at', new Date().toISOString())
}
purgerTokensExpires()
setInterval(purgerTokensExpires, 24 * 60 * 60 * 1000)

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`)
})
