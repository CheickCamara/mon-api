require('dotenv').config()
const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { createClient } = require('@supabase/supabase-js')

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
    .select('id, nom, adresse, description, telephone, statut, info, lat, lng, image')
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
      id, statut, date_candidature,
      offres (titre, contrepartie, valeur_indicative, restaurants (nom, adresse))
    `)
    .eq('influenceur_id', req.user.id)
    .order('date_candidature', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
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
  const { nom, email, mot_de_passe, nom_etablissement, adresse } = req.body
  if (!nom || !email || !mot_de_passe || !nom_etablissement || !adresse) {
    return res.status(400).json({ error: 'Tous les champs sont requis' })
  }
  const hash = await bcrypt.hash(mot_de_passe, 10)

  // Créer le compte restaurateur dans influenceurs avec rôle restaurateur
  const { data: resto, error: restoError } = await supabase
    .from('restaurants')
    .insert({ nom: nom_etablissement, adresse, email, statut: 'Ouvert' })
    .select('id')
    .single()
  if (restoError) return res.status(500).json({ error: restoError.message })

  const { data, error } = await supabase
    .from('restaurateurs')
    .insert({ nom, email, mot_de_passe: hash, restaurant_id: resto.id })
    .select('id, nom, email, restaurant_id')
    .single()
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' })
    return res.status(500).json({ error: error.message })
  }
  const token = jwt.sign({ id: data.id, role: 'restaurateur', restaurant_id: resto.id }, JWT_SECRET, { expiresIn: '7d' })
  res.json({ token, utilisateur: data })
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
      id, statut, post_publie, lien_publication, date_candidature,
      influenceurs (nom, reseau, abonnes),
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
  const { titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, statut, conditions } = req.body
  const { error } = await supabase
    .from('offres')
    .update({ titre, description, menu, valeur_indicative, contrepartie, nombre_places, tranche_min, tranche_max, statut, conditions })
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
