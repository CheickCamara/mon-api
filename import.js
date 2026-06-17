const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

const CSV_PATH = '/Users/cheickcamara/Downloads/Prospect Miavane Agency - Paris _ 92.csv'
const DB_PATH = path.join(__dirname, 'restaurants.db')

const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT,
    adresse TEXT,
    description TEXT,
    telephone TEXT,
    email TEXT,
    statut TEXT,
    info TEXT
  )
`)

const contenu = fs.readFileSync(CSV_PATH, 'utf8')
const lignes = contenu.split('\n').slice(1) // on saute la ligne d'en-tête

const insert = db.prepare(`
  INSERT INTO restaurants (nom, adresse, description, telephone, email, statut, info)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

let count = 0
const importAll = db.transaction(() => {
  for (const ligne of lignes) {
    if (!ligne.trim()) continue
    const cols = ligne.split(',')
    const nom       = cols[0]?.trim() || ''
    const adresse   = cols[1]?.trim() || ''
    const desc      = cols[2]?.trim() || ''
    const tel       = cols[3]?.trim() || ''
    const email     = cols[4]?.trim() || ''
    const statut    = cols[9]?.trim() || ''
    const info      = cols[10]?.trim() || ''
    if (!nom) continue
    insert.run(nom, adresse, desc, tel, email, statut, info)
    count++
  }
})

importAll()
console.log(`✅ ${count} restaurants importés dans restaurants.db`)
db.close()
