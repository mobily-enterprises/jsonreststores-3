/* jsonreststores.js
   (Refactored to a plugin-based, hook-driven architecture)
*/

const e = require('allhttperrors')
const semver = require('semver')

// Keep a global registry as in your original code
const registryByName = {}
const registryByVersion = {}

//--------------------------------------------------------------------------
// Hook Manager to keep track of all registered plugins
//--------------------------------------------------------------------------
class HookManager {
  constructor() {
    this.plugins = []
  }

  register(plugin, storeInstance) {
    this.plugins.push(plugin)
    // If the plugin has an install() method, call it once
    if (typeof plugin.install === 'function') {
      plugin.install(storeInstance)
    }
  }

  // Call a specific hook (e.g. "onInsert", "onBeforeValidate") across all plugins
  async callHook(hookName, context) {
    for (const plugin of this.plugins) {
      if (typeof plugin[hookName] === 'function') {
        await plugin[hookName](context)
      }
    }
  }
}

//--------------------------------------------------------------------------
// The core store class that orchestrates requests and plugin hooks
//--------------------------------------------------------------------------
class JsonRestStores {
  // Some static references to your old error classes
  static get BadRequestError () { return e.BadRequestError }
  static get UnauthorizedError () { return e.UnauthorizedError }
  static get ForbiddenError () { return e.ForbiddenError }
  static get NotFoundError () { return e.NotFoundError }
  static get PreconditionFailedError () { return e.PreconditionFailedError }
  static get UnprocessableEntityError () { return e.UnprocessableEntityError }
  static get NotImplementedError () { return e.NotImplementedError }
  static get ServiceUnavailableError () { return e.ServiceUnavailableError }

  static get registryByName () { return registryByName }
  static get registryByVersion () { return registryByVersion }

  // In your original code, these were static. Now we accept them as constructor options
  constructor(options = {}) {
    // Basic config
    this.storeName = options.storeName
    this.version = options.version
    if (!this.storeName || !this.version) {
      throw new Error('A store must define a storeName and version')
    }

    // Register in global registry (like your original)
    this._register()

    // Hooks manager
    this.hookManager = new HookManager()

    // Keep your original properties for behavior toggles
    this.handlePut = options.handlePut ?? false
    this.handlePost = options.handlePost ?? false
    this.handleGet = options.handleGet ?? false
    this.handleGetQuery = options.handleGetQuery ?? false
    this.handleDelete = options.handleDelete ?? false
    this.defaultLimitOnQueries = options.defaultLimitOnQueries ?? 1000

    // Keep your schema references
    this.schema = options.schema
    if (!this.schema) throw new Error(`You must define a schema for store ${this.storeName}`)

    this.searchSchema = options.searchSchema ?? null
    // (You can replicate your original logic of “auto-creating searchSchema” if needed)
    // ...
  }

  // Register plugin
  use(plugin) {
    this.hookManager.register(plugin, this)
  }

  // Crud Entry Points

  async post(request) {
    // If store says "no POST", throw
    if (!this.handlePost && request.remote) {
      throw new this.constructor.NotImplementedError()
    }

    // This method orchestrates an "insert" flow
    // -- same as your original implementInsert, but calls hooks
    // 1) Param validations (if any) before we let plugins do their “before validate”
    await this._validateParamsIfNeeded(request, skipId=true)
    
    // 2) Call "onBeforeValidate" across plugins
    await this.hookManager.callHook('onBeforeValidate', { store: this, request })
    
    // 3) Basic validation (schema)
    await this._validateBody(request, { mode: 'insert' })

    // 4) onCheckPermissions
    await this.hookManager.callHook('onCheckPermissions', { store: this, request })

    // 5) onValidate for deeper validations (like your original “validate()”)
    await this.hookManager.callHook('onValidate', { store: this, request })

    // 6) onInsert - plugin does the actual DB write
    await this.hookManager.callHook('onInsert', { store: this, request })

    // 7) onAfterInsert
    await this.hookManager.callHook('onAfterInsert', { store: this, request })

    // Return the new record
    return request.record
  }

  async put(request) {
    if (!this.handlePut && request.remote) {
      throw new this.constructor.NotImplementedError()
    }

    // 1) Validate params
    await this._validateParamsIfNeeded(request)
    
    // 2) onBeforeValidate
    await this.hookManager.callHook('onBeforeValidate', { store: this, request })

    // 3) Basic validation (schema)
    // We do the same approach, though it might be "insert or update"
    await this._validateBody(request, { mode: 'upsert' })
    
    // 4) onCheckPermissions
    await this.hookManager.callHook('onCheckPermissions', { store: this, request })

    // 5) onValidate
    await this.hookManager.callHook('onValidate', { store: this, request })

    // 6) onPut - plugin decides whether to insert or update
    await this.hookManager.callHook('onPut', { store: this, request })

    // 7) onAfterPut
    await this.hookManager.callHook('onAfterPut', { store: this, request })

    return request.record
  }

  async get(request) {
    if (!this.handleGet && request.remote) {
      throw new this.constructor.NotImplementedError()
    }

    // Typically, we want to validate param IDs
    await this._validateParamsIfNeeded(request)

    // Let the plugin fetch from DB (or whatever)
    await this.hookManager.callHook('onFetch', { store: this, request })

    // If plugin sets `request.record = null`, then not found
    if (!request.record) {
      throw new this.constructor.NotFoundError()
    }

    return request.record
  }

  async getQuery(request) {
    if (!this.handleGetQuery && request.remote) {
      throw new this.constructor.NotImplementedError()
    }

    // Possibly validate param IDs if your store uses them
    await this._validateParamsIfNeeded(request, skipId=true) // or not, depends on your design

    // Let plugin do query
    await this.hookManager.callHook('onQuery', { store: this, request })

    // Return the data set that plugin placed in request.data
    return request.data || []
  }

  async delete(request) {
    if (!this.handleDelete && request.remote) {
      throw new this.constructor.NotImplementedError()
    }

    // Validate param IDs
    await this._validateParamsIfNeeded(request)

    // Possibly fetch the record so we can see if it’s there
    await this.hookManager.callHook('onFetch', { store: this, request })
    if (!request.record) {
      throw new this.constructor.NotFoundError()
    }

    // Let plugin do the actual delete
    await this.hookManager.callHook('onDelete', { store: this, request })

    // onAfterDelete if you want post-delete steps
    await this.hookManager.callHook('onAfterDelete', { store: this, request })

    return request.record
  }

  //------------------------------------------------------------------
  // Some of the old utility methods from your code (trimmed for space)
  //------------------------------------------------------------------
  
  copyRequest (request, extras = {}) {
    return { 
      ...request, 
      params: { ...request.params }, 
      body: { ...request.body }, 
      ...extras 
    }
  }

  _sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // Minimal param validator, referencing your old `_validateParams` logic
  async _validateParamsIfNeeded(request, skipId=false) {
    if (!this.schema || !request.params) return
    // If you want to replicate your original paramIds logic, do so here
    // e.g. check that required params exist, etc.
  }

  // Minimal body validator referencing your old schema approach
  async _validateBody(request, { mode }) {
    const errors = []
    // If you want to replicate your original "schema.validate(request.body)" logic,
    // do it here, e.g.:
    //   const { validatedObject, errors: schemaErrors } = await this.schema.validate(request.body, {...})
    //   if (schemaErrors.length) { errors.push(...schemaErrors) }
    // if (errors.length) throw new this.constructor.UnprocessableEntityError({ errors })
  }

  // ... etc. You can bring in as many of your old helpers as you like, 
  // hooking them in this core class.

  //------------------------------------------------------------------
  // Register in the global “registry”
  //------------------------------------------------------------------
  _register() {
    registryByName[this.storeName] = registryByName[this.storeName] || {}
    registryByVersion[this.version] = registryByVersion[this.version] || {}
    registryByName[this.storeName][this.version] = this
    registryByVersion[this.version][this.storeName] = this
  }

  // A static helper if you want to fetch stores by version, etc.
  static stores (version) {
    return new Proxy({}, {
      get: function (obj, prop) {
        if (!registryByName[prop]) return undefined
        if (registryByName[prop][version]) {
          return registryByName[prop][version]
        }
        const rightVersion = Object.keys(registryByName[prop])
          .filter(el => semver.satisfies(registryByName[prop][el].version, `<${version}`))
          .sort((a, b) => semver.compare(a, b))
          .shift()
        if (rightVersion) {
          return registryByName[prop][rightVersion]
        } else {
          return undefined
        }
      }
    })
  }
}

module.exports = JsonRestStores
