require('dotenv').config()
const express = require('express')
const cors = require('cors')
const Database = require('better-sqlite3')
const path = require('path')
const jwt = require('jsonwebtoken')
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

const db = new Database(path.join(__dirname, 'restaurants.db'))

// Création des tables si elles n'existent pas encore
db.exec(`
  CREATE TABLE IF NOT EXISTS influenceurs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    mot_de_passe TEXT NOT NULL,
    reseau TEXT NOT NULL,
    abonnes INTEGER NOT NULL,
    statut TEXT DEFAULT 'en_attente',
    date_inscription TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS candidatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    influenceur_id INTEGER NOT NULL,
    restaurant_id INTEGER NOT NULL,
    statut TEXT DEFAULT 'en_attente',
    post_publie INTEGER DEFAULT 0,
    date_candidature TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (influenceur_id) REFERENCES influenceurs(id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );
`)

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

// ─── ROUTES PUBLIQUES ────────────────────────────────────────────────────────

app.get('/restaurants', async (req, res) => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, nom, adresse, description, telephone, statut, info, lat, lng, image')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/restaurants/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, nom, adresse, description, telephone, statut, info, lat, lng, image')
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: 'Restaurant non trouvé' })
  res.json(data)
})

// Inscription influenceur
app.post('/inscription', (req, res) => {
  const { nom, email, mot_de_passe, reseau, abonnes } = req.body
  if (!nom || !email || !mot_de_passe || !reseau || !abonnes) {
    return res.status(400).json({ error: 'Tous les champs sont requis' })
  }
  try {
    const result = db.prepare(
      'INSERT INTO influenceurs (nom, email, mot_de_passe, reseau, abonnes) VALUES (?, ?, ?, ?, ?)'
    ).run(nom, email, mot_de_passe, reseau, Number(abonnes))
    res.json({ id: result.lastInsertRowid, message: 'Inscription enregistrée' })
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email déjà utilisé' })
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// Candidature d'un influenceur à un restaurant
app.post('/candidatures', (req, res) => {
  const { influenceur_id, restaurant_id } = req.body
  if (!influenceur_id || !restaurant_id) return res.status(400).json({ error: 'Champs manquants' })
  const result = db.prepare(
    'INSERT INTO candidatures (influenceur_id, restaurant_id) VALUES (?, ?)'
  ).run(influenceur_id, restaurant_id)
  res.json({ id: result.lastInsertRowid, message: 'Candidature envoyée' })
})

// ─── ROUTES ADMIN ─────────────────────────────────────────────────────────────

// Connexion admin — renvoie un token valable 24h
app.post('/admin/login', (req, res) => {
  const { password } = req.body
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' })
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' })
  res.json({ token })
})

// Statistiques générales
app.get('/admin/stats', adminAuth, (req, res) => {
  const total_influenceurs = db.prepare('SELECT COUNT(*) as n FROM influenceurs').get().n
  const en_attente = db.prepare("SELECT COUNT(*) as n FROM influenceurs WHERE statut = 'en_attente'").get().n
  const valides = db.prepare("SELECT COUNT(*) as n FROM influenceurs WHERE statut = 'valide'").get().n
  const refuses = db.prepare("SELECT COUNT(*) as n FROM influenceurs WHERE statut = 'refuse'").get().n
  const total_candidatures = db.prepare('SELECT COUNT(*) as n FROM candidatures').get().n
  const candidatures_en_attente = db.prepare("SELECT COUNT(*) as n FROM candidatures WHERE statut = 'en_attente'").get().n
  const posts_publies = db.prepare('SELECT COUNT(*) as n FROM candidatures WHERE post_publie = 1').get().n
  const total_restaurants = db.prepare('SELECT COUNT(*) as n FROM restaurants').get().n

  const inscriptions_semaine = db.prepare(`
    SELECT date(date_inscription) as jour, COUNT(*) as nb
    FROM influenceurs
    WHERE date_inscription >= datetime('now', '-7 days')
    GROUP BY jour ORDER BY jour
  `).all()

  res.json({
    influenceurs: { total: total_influenceurs, en_attente, valides, refuses },
    candidatures: { total: total_candidatures, en_attente: candidatures_en_attente, posts_publies },
    restaurants: { total: total_restaurants },
    inscriptions_semaine
  })
})

// Liste des influenceurs
app.get('/admin/influenceurs', adminAuth, (req, res) => {
  const influenceurs = db.prepare(
    'SELECT id, nom, email, reseau, abonnes, statut, date_inscription FROM influenceurs ORDER BY date_inscription DESC'
  ).all()
  res.json(influenceurs)
})

// Valider ou refuser un influenceur
app.put('/admin/influenceurs/:id', adminAuth, (req, res) => {
  const { statut } = req.body
  if (!['valide', 'refuse', 'en_attente'].includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide' })
  }
  db.prepare('UPDATE influenceurs SET statut = ? WHERE id = ?').run(statut, req.params.id)
  res.json({ success: true })
})

// Liste des candidatures avec détails
app.get('/admin/candidatures', adminAuth, (req, res) => {
  const candidatures = db.prepare(`
    SELECT c.id, c.statut, c.post_publie, c.date_candidature,
           i.nom as influenceur_nom, i.reseau, i.abonnes,
           r.nom as restaurant_nom
    FROM candidatures c
    JOIN influenceurs i ON c.influenceur_id = i.id
    JOIN restaurants r ON c.restaurant_id = r.id
    ORDER BY c.date_candidature DESC
  `).all()
  res.json(candidatures)
})

// Valider/refuser une candidature ou marquer le post comme publié
app.put('/admin/candidatures/:id', adminAuth, (req, res) => {
  const { statut, post_publie } = req.body
  if (statut !== undefined) {
    if (!['en_attente', 'valide', 'refuse'].includes(statut)) {
      return res.status(400).json({ error: 'Statut invalide' })
    }
    db.prepare('UPDATE candidatures SET statut = ? WHERE id = ?').run(statut, req.params.id)
  }
  if (post_publie !== undefined) {
    db.prepare('UPDATE candidatures SET post_publie = ? WHERE id = ?').run(post_publie ? 1 : 0, req.params.id)
  }
  res.json({ success: true })
})

// Ajouter un restaurant (admin)
app.post('/admin/restaurants', adminAuth, (req, res) => {
  const { nom, adresse, description, telephone, email, statut, info } = req.body
  if (!nom || !adresse) return res.status(400).json({ error: 'Nom et adresse requis' })
  const result = db.prepare(
    'INSERT INTO restaurants (nom, adresse, description, telephone, email, statut, info) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nom, adresse, description || '', telephone || '', email || '', statut || 'Ouvert', info || '')
  res.json({ id: result.lastInsertRowid, message: 'Restaurant ajouté' })
})

// Modifier un restaurant (admin)
app.put('/admin/restaurants/:id', adminAuth, (req, res) => {
  const { nom, adresse, description, telephone, statut, info } = req.body
  db.prepare(
    'UPDATE restaurants SET nom=?, adresse=?, description=?, telephone=?, statut=?, info=? WHERE id=?'
  ).run(nom, adresse, description, telephone, statut, info, req.params.id)
  res.json({ success: true })
})

// Supprimer un restaurant (admin)
app.delete('/admin/restaurants/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM restaurants WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`)
})
