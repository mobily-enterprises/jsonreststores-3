/* jsonreststores-mysql.js
   (A MySQL plugin that uses the new hooks approach)
*/

const util = require('util')

function createMySQLPlugin(options) {
  const { connection, table } = options
  // Setup for async usage
  if (!connection.queryP) {
    connection.queryP = util.promisify(connection.query).bind(connection)
  }

  return {
    // Called once when the plugin is registered
    install(store) {
      console.log(`MySQL plugin installed for store: ${store.storeName}, table: ${table}`)
    },

    // HOOK: For reading a single record
    async onFetch({ store, request }) {
      const id = request.params[store.idProperty || 'id']
      if (id == null) return // no ID
      // In your old code: implementFetch -> build a SELECT ...
      const sql = `SELECT * FROM \`${table}\` WHERE \`${store.idProperty}\` = ?`
      const rows = await connection.queryP(sql, [id])
      request.record = rows[0] || null

      // Possibly check permissions here or let the store call onCheckPermissions
    },

    // HOOK: For inserting a new record
    async onInsert({ store, request }) {
      // Example based on your old implementInsert approach
      // 1) Possibly handle positioning if store.positioning
      // 2) Build insert object
      const insertObject = { ...request.body }
      // 3) Insert
      const sql = `INSERT INTO \`${table}\` SET ?`
      const result = await connection.queryP(sql, [insertObject])
      const newId = result.insertId

      // 4) Re-fetch the record
      const [row] = await connection.queryP(`SELECT * FROM \`${table}\` WHERE \`${store.idProperty}\`=?`, [newId])
      request.record = row
    },

    // HOOK: For put => "upsert" logic
    async onPut({ store, request }) {
      const id = request.params[store.idProperty || 'id']
      // Check if record currently exists
      const rows = await connection.queryP(
        `SELECT * FROM \`${table}\` WHERE \`${store.idProperty}\`=?`,
        [id]
      )
      const existing = rows[0]

      if (!existing) {
        // Insert
        const insertObject = { ...request.body }
        const sql = `INSERT INTO \`${table}\` SET ?`
        const result = await connection.queryP(sql, [insertObject])
        const newId = result.insertId
        const [fetched] = await connection.queryP(`SELECT * FROM \`${table}\` WHERE \`${store.idProperty}\`=?`, [newId])
        request.record = fetched
      } else {
        // Update
        const updateObject = { ...request.body }
        const sql = `UPDATE \`${table}\` SET ? WHERE \`${store.idProperty}\`=?`
        await connection.queryP(sql, [updateObject, id])
        const [fetched] = await connection.queryP(`SELECT * FROM \`${table}\` WHERE \`${store.idProperty}\`=?`, [id])
        request.record = fetched
      }
    },

    // HOOK: For the "update" part if you want a dedicated approach
    async onUpdate({ store, request }) {
      // If you separate the logic of "update" from "put", you can do it here
      // e.g. in your old code: implementUpdate
    },

    // HOOK: For deleting
    async onDelete({ store, request }) {
      const id = request.params[store.idProperty || 'id']
      if (id == null) return
      const sql = `DELETE FROM \`${table}\` WHERE \`${store.idProperty}\`=?`
      await connection.queryP(sql, [id])
      // record was in request.record (fetched previously)
    },

    // HOOK: For queries
    async onQuery({ store, request }) {
      // In your old code, implementQuery => build WHERE conditions from `request.options.conditionsHash`
      const { skip = 0, limit = store.defaultLimitOnQueries, conditionsHash = {} } = request.options
      const { conditions, args } = buildWhereClause(conditionsHash)
      const whereString = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const sql = `SELECT * FROM \`${table}\` ${whereString} LIMIT ?,?`
      const rows = await connection.queryP(sql, [...args, skip, limit])

      // For total count
      const countSql = `SELECT COUNT(*) as grandTotal FROM \`${table}\` ${whereString}`
      const countResult = await connection.queryP(countSql, args)
      const grandTotal = countResult[0].grandTotal

      request.data = rows
      request.grandTotal = grandTotal
    },

    // HOOK: Permission checks, advanced validations, etc.
    async onCheckPermissions({ store, request }) {
      // If you want to replicate your old checkPermissions logic,
      // you can do it here. If not granted, throw store.constructor.ForbiddenError
    },

    // HOOK: After insert
    async onAfterInsert({ store, request }) {
      // Possibly do any post-processing. 
      // e.g. “afterInsert” from your original code
    },

    // ... etc. You could implement more hooks (onBeforeValidate, onValidate, etc.)
  }
}

// Example helper for building a WHERE from conditionsHash
function buildWhereClause(conditionsHash) {
  const conditions = []
  const args = []
  for (const field in conditionsHash) {
    const val = conditionsHash[field]
    if (val === null) {
      conditions.push(`\`${field}\` IS NULL`)
    } else {
      // If you want partial matches vs exact, adapt here:
      conditions.push(`\`${field}\` = ?`)
      args.push(val)
    }
  }
  return { conditions, args }
}

module.exports = createMySQLPlugin
