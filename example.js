// usage.js
const JsonRestStores = require('./jsonreststores') // your new core
const createMySQLPlugin = require('./jsonreststores-mysql')

// 1) Create your store
const userStore = new JsonRestStores({
  storeName: 'users',
  version: '1.0.0',
  schema: userSchema,
  handlePost: true,
  handlePut: true,
  handleGet: true,
  handleDelete: true,
  handleGetQuery: true
})

// 2) Create MySQL plugin with your connection + table
const mysqlPlugin = createMySQLPlugin({
  connection: mysqlConnection, 
  table: 'users'
})

// 3) Register plugin
userStore.use(mysqlPlugin)

// 4) Use your store
async function example() {
  const request = {
    params: { id: 123 },
    body: { name: "Alice" },
    options: {}
  }

  // Insert or update
  const inserted = await userStore.post(request)
  console.log('Inserted:', inserted)
  
  // fetch single
  const record = await userStore.get({ params: { id: 123 } })
  console.log('Fetched record:', record)

  // query
  const all = await userStore.getQuery({
    options: {
      conditionsHash: { someField: 'someValue' }
    }
  })
  console.log('Queried records:', all)
}

example()
