const Database = require('better-sqlite3')
const path = require('path')

const db = new Database(path.join(__dirname, 'restaurants.db'))

const total = db.prepare('SELECT COUNT(*) as n FROM restaurants').get().n
const geocodes = db.prepare('SELECT COUNT(*) as n FROM restaurants WHERE lat IS NOT NULL').get().n
const restants = total - geocodes

console.log(`Total         : ${total} restaurants`)
console.log(`Géocodés      : ${geocodes}`)
console.log(`Restants      : ${restants}`)

db.close()
