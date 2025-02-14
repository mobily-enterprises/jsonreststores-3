/**
 * positioning-plugin.js
 * 
 * A separate plugin that handles record "positioning" logic in MySQL.
 * 
 * Usage Example:
 *   const positioningPlugin = createPositioningPlugin({
 *     connection,
 *     table: 'myTable',
 *     positionField: 'position',
 *     positionFilter: ['category_id'],
 *     beforeIdField: 'beforeId',
 *   })
 *   store.use(positioningPlugin)
 */

const util = require('util')

function createPositioningPlugin(options) {
  const {
    connection,
    table,
    positionField = 'position',
    positionFilter = [], 
    beforeIdField = 'beforeId'
  } = options

  if (!connection) {
    throw new Error('Positioning plugin requires a MySQL connection')
  }
  if (!table) {
    throw new Error('Positioning plugin requires a table name')
  }
  if (!connection.queryP) {
    // Make sure we have a promise-based version of query
    connection.queryP = util.promisify(connection.query).bind(connection)
  }

  /**
   * Helper that runs the actual logic to compute request.body[positionField].
   * We look for `request.body[beforeIdField]`:
   *   - `undefined` => keep the old position if it’s an update; or place last if it’s a new record
   *   - `null`      => place it last
   *   - a valid ID  => shift that row & everything after it, then place this row
   */
  async function _calculatePosition(context, isInsert) {
    const { request, store } = context
    const { body, params } = request

    // Check if the user has provided "beforeId" in the request body
    const beforeId = body[beforeIdField]

    // We’ll need to figure out what “group” or “subset” the record belongs to
    // based on `positionFilter` fields. That way, items are only repositioned
    // within their group. E.g. a different "category_id" might be a different group.
    const filterConditions = []
    const filterValues = []
    positionFilter.forEach((field) => {
      const val = (typeof body[field] !== 'undefined') 
                    ? body[field] 
                    : (request.record && request.record[field])
      if (val === null || typeof val === 'undefined') {
        filterConditions.push(`\`${field}\` IS NULL`)
      } else {
        filterConditions.push(`\`${field}\` = ?`)
        filterValues.push(val)
      }
    })
    const wherePositionFilter = filterConditions.length
      ? filterConditions.join(' AND ')
      : '1=1'

    // A small helper to move this item to the “last” position
    async function placeAtEnd() {
      const [rows] = await connection.queryP(
        `SELECT MAX(\`${positionField}\`) as maxPos 
           FROM \`${table}\`
          WHERE ${wherePositionFilter}`,
        filterValues
      )
      const maxPos = rows?.maxPos ?? 0
      // We'll set the new position to (maxPos + 1)
      body[positionField] = maxPos + 1
    }

    // If we’re in an UPDATE scenario, we might already have a record with a position.
    // So let’s see if we can figure out that old position, for the “undefined beforeId” case.
    // (We do the same logic you had in your original `_calculatePosition`.)
    let oldPosition = null
    if (!isInsert) {
      // If we already fetched the record in onFetch
      oldPosition = request.record ? request.record[positionField] : null

      // If we didn’t fetch yet or record is missing, we can attempt it:
      if (oldPosition == null && params[store.idProperty]) {
        const [row] = await connection.queryP(
          `SELECT \`${positionField}\`
             FROM \`${table}\`
            WHERE \`${store.idProperty}\`= ?`,
          [params[store.idProperty]]
        )
        if (row) oldPosition = row[positionField]
      }
    }

    // Now handle each “beforeId” scenario:
    // --------------------------------------------------------
    // (1) beforeId === undefined
    if (typeof beforeId === 'undefined') {
      // For inserts: place at end
      // For updates: keep old position
      if (isInsert) {
        await placeAtEnd()
      } else {
        // keep old position if it was found
        if (oldPosition == null) {
          // if no old position, place at end
          await placeAtEnd()
        } else {
          body[positionField] = oldPosition
        }
      }
      return
    }

    // --------------------------------------------------------
    // (2) beforeId === null => explicitly place at end
    if (beforeId === null) {
      await placeAtEnd()
      return
    }

    // --------------------------------------------------------
    // (3) A valid ID? => Shift that record + everything behind it.
    // First, check if the “beforeId” record is in the same group (same positionFilter).
    const groupCheckSql = `
      SELECT \`${store.idProperty}\`, \`${positionField}\`
        FROM \`${table}\`
       WHERE \`${store.idProperty}\`= ?
         AND ${wherePositionFilter}
    `
    const [beforeRows] = await connection.queryP(groupCheckSql, [beforeId, ...filterValues])
    const beforeIdItem = beforeRows || []

    if (!beforeIdItem.length) {
      // If there’s no matching record in the same group, place at end
      await placeAtEnd()
      return
    }

    // If the record is found, shift positions
    const targetPosition = beforeIdItem[0][positionField] || 0
    // Example: push everything from targetPosition upward
    await connection.queryP(
      `UPDATE \`${table}\`
          SET \`${positionField}\` = \`${positionField}\` + 1
        WHERE \`${positionField}\` >= ?
          AND ${wherePositionFilter}
        ORDER BY \`${positionField}\` DESC`,
      [targetPosition, ...filterValues]
    )
    // Now set this record’s position
    body[positionField] = targetPosition
  }

  return {
    install(store) {
      console.log(`Positioning plugin installed for table "${table}", using field "${positionField}".`)
    },

    /**
     * Hook: onBeforeInsert
     *   - We intercept the request right before MySQL’s onInsert. 
     *   - We update request.body[positionField] as needed.
     */
    async onBeforeInsert(context) {
      // context = { store, request }
      const { store, request } = context
      // If your store has `store.positioning` as a flag, you could check it here:
      // if (!store.positioning) return
      await _calculatePosition(context, /* isInsert = */ true)
      // We also remove the `beforeIdField` from the body so it won't get inserted as a column
      if (typeof request.body[beforeIdField] !== 'undefined') {
        delete request.body[beforeIdField]
      }
    },

    /**
     * Hook: onBeforeUpdate (if you separate update from put),
     *       or onBeforePut (if you do upsert logic).
     */
    async onBeforePut(context) {
      // context = { store, request }
      const { request } = context
      await _calculatePosition(context, /* isInsert = */ false)
      // Remove `beforeIdField`
      if (typeof request.body[beforeIdField] !== 'undefined') {
        delete request.body[beforeIdField]
      }
    },

    // Optionally, if you have a dedicated "onBeforeUpdate" hook in your core:
    // async onBeforeUpdate(context) {
    //   await _calculatePosition(context, false)
    //   // remove beforeIdField
    // }

    // Similarly, if you want to handle “dragging” between groups, you’d handle it here.
    // The approach is the same: check if the positionFilter fields changed,
    // if so, place the record at the end or do more complex logic, etc.
  }
}

module.exports = createPositioningPlugin
