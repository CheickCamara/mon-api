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
const JWT_SECRET = process.env.JWT_SECRET

app.use(cors())
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

  res.json({ id: data.id, message: 'Candidature envoyée' })
})

// Mon profil
app.get('/mon-espace/profil', userAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('influenceurs')
    .select('id, nom, email, reseau, abonnes, statut, date_inscription')
    .eq('id', req.user.id)
    .single()
  if (error || !data) return res.status(404).json({ error: 'Profil introuvable' })
  res.json(data)
})

// Modifier mon profil
app.put('/mon-espace/profil', userAuth, async (req, res) => {
  const { nom, reseau, abonnes, mot_de_passe } = req.body
  const updates = {}
  if (nom) updates.nom = nom
  if (reseau) updates.reseau = reseau
  if (abonnes) updates.abonnes = Number(abonnes)
  if (mot_de_passe) updates.mot_de_passe = await bcrypt.hash(mot_de_passe, 10)
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
    .select('id, titre, contrepartie, nombre_places, places_restantes, valeur_indicative, statut, tranche_min, tranche_max')
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
      id, statut, date_candidature, post_publie, lien_publication, capture_story,
      influenceurs (nom, email, reseau, abonnes),
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
  if (!['valide', 'refuse'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' })

  // Vérifier que la candidature appartient bien à ce restaurant
  const { data: cand } = await supabase
    .from('candidatures')
    .select('id, restaurant_id, influenceurs (nom, email), offres (titre, restaurants (nom))')
    .eq('id', req.params.id)
    .single()

  if (!cand) return res.status(404).json({ error: 'Candidature introuvable' })
  if (cand.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ error: 'Accès refusé' })

  const { error } = await supabase.from('candidatures').update({ statut }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  // Notifier l'influenceur par e-mail
  const influenceur = cand.influenceurs
  const offre = cand.offres
  if (influenceur?.email && resend) {
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

  res.json({ success: true })
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
  if (siret.replace(/\s/g, '').length !== 14) {
    return res.status(400).json({ error: 'Le SIRET doit contenir 14 chiffres' })
  }
  // Vérifier que l'email n'est pas déjà utilisé comme influenceur
  const { data: influExistant } = await supabase.from('influenceurs').select('id').eq('email', email).single()
  if (influExistant) return res.status(409).json({ error: 'Cet email est déjà utilisé pour un compte influenceur. Utilise une adresse différente.' })

  const hash = await bcrypt.hash(mot_de_passe, 10)

  const { data: resto, error: restoError } = await supabase
    .from('restaurants')
    .insert({ nom: nom_etablissement, adresse, email, statut: 'en_attente', siret, telephone: telephone || null, description: description || null })
    .select('id')
    .single()
  if (restoError) return res.status(500).json({ error: restoError.message })

  const { data, error } = await supabase
    .from('restaurateurs')
    .insert({ nom, email, mot_de_passe: hash, restaurant_id: resto.id, siret })
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
    { count: total_restaurants },
    { count: total_offres },
  ] = await Promise.all([
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }),
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }).eq('statut', 'en_attente'),
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }).eq('statut', 'valide'),
    supabase.from('influenceurs').select('*', { count: 'exact', head: true }).eq('statut', 'refuse'),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }).eq('statut', 'en_attente'),
    supabase.from('candidatures').select('*', { count: 'exact', head: true }).eq('post_publie', true),
    supabase.from('restaurants').select('*', { count: 'exact', head: true }),
    supabase.from('offres').select('*', { count: 'exact', head: true }),
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
    candidatures: { total: total_candidatures, en_attente: candidatures_en_attente, posts_publies },
    restaurants: { total: total_restaurants },
    offres: { total: total_offres },
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
  const { error } = await supabase.from('influenceurs').update({ statut }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
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
  const { error } = await supabase.from('candidatures').update(updates).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

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
  const { error } = await supabase
    .from('restaurants')
    .update({ nom, adresse, description, telephone, statut, info })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
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

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`)
})
