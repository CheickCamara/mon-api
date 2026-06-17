const Database = require('better-sqlite3')
const path = require('path')

const db = new Database(path.join(__dirname, 'restaurants.db'))

// Ajout des colonnes lat/lng si elles n'existent pas encore
try { db.exec('ALTER TABLE restaurants ADD COLUMN lat REAL') } catch {}
try { db.exec('ALTER TABLE restaurants ADD COLUMN lng REAL') } catch {}

const restaurants = db.prepare("SELECT id, nom, adresse FROM restaurants WHERE lat IS NULL AND adresse != ''").all()
const update = db.prepare('UPDATE restaurants SET lat = ?, lng = ? WHERE id = ?')

console.log(`${restaurants.length} restaurants à géocoder…`)

async function geocode(adresse) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(adresse + ', France')}&format=json&limit=1`
  const res = await fetch(url, { headers: { 'User-Agent': 'PopFluence/1.0' } })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Réponse non-JSON : ${text.slice(0, 200)}`) }
  if (data.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  return { empty: true, raw: text.slice(0, 200) }
}

async function run() {
  let ok = 0, echec = 0

  for (const r of restaurants) {
    try {
      const coords = await geocode(r.adresse)
      if (coords && !coords.empty) {
        update.run(coords.lat, coords.lng, r.id)
        ok++
        console.log(`✅ [${ok + echec}/${restaurants.length}] ${r.nom}`)
      } else {
        echec++
        console.log(`❌ [${ok + echec}/${restaurants.length}] Introuvable : ${r.nom} | Réponse brute : ${coords?.raw}`)
      }
    } catch (e) {
      echec++
      console.log(`⚠️  [${ok + echec}/${restaurants.length}] Erreur : ${r.nom} — ${e.message}`)
    }
    // 1 requête par seconde (règle Nominatim)
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`\n\nTerminé ! ${ok} restaurants géocodés, ${echec} échecs.`)
  db.close()
}

run()
