// =================================================================================
// File:    plugin-loki.js
//
// Authors: Jarle Elshaug
//          Jeffrey Gilbert (visualjeff)
//
// Purpose: SCIM endpoint locally at the ScimGateway
//          - Demonstrate userprovisioning towards a document-oriented database
//          - Using LokiJS (http://lokijs.org) for a fast, in-memory document-oriented database with persistence
//          - Two predefined test users loaded when using in-memory only (no persistence)
//          - Supporting explore, create, delete, modify and list users (including groups)
//
// Supported attributes:
//
// GlobalUser   Template            Scim        Endpoint
// ------------------------------------------------------
// All attributes are supported, note multivalue "type" must be unique
//
// NOTE: Default configuration file setting {"persistence": false} gives an inMemory adapter for testing purposes
//       having two predifiend users loaded. Using {"persistence": true} gives an persistence file store located in
//       config directory with name according to configuration setting {"dbname": "loki.db"} and no no testusers loaded.
//
//       LokiJS are well suited for handling large dataloads
//
// =================================================================================

'use strict'

const Loki = require('lokijs')

// mandatory plugin initialization - start
const path = require('path')
let ScimGateway = null
try {
  ScimGateway = require('scimgateway')
} catch (err) {
  ScimGateway = require('./scimgateway')
}
const scimgateway = new ScimGateway()
const pluginName = path.basename(__filename, '.js')
const configDir = path.join(__dirname, '..', 'config')
const configFile = path.join(`${configDir}`, `${pluginName}.json`)
const validScimAttr = [] // empty array - all attrbutes are supported by endpoint
let config = require(configFile).endpoint
config = scimgateway.processExtConfig(pluginName, config) // add any external config process.env and process.file
// mandatory plugin initialization - end

// let endpointPasswordExample = scimgateway.getPassword('endpoint.password', configFile); // example how to encrypt configfile having "endpoint.password"

var users
var groups

let dbname = (config.dbname ? config.dbname : 'loki.db')
dbname = path.join(`${configDir}`, `${dbname}`)
const db = new Loki(dbname, {
  env: 'NODEJS',
  autoload: config.persistence === true,
  autoloadCallback: loadHandler,
  autosave: config.persistence === true,
  autosaveInterval: 10000, // 10 seconds
  adapter: (config.persistence === true) ? new Loki.LokiFsAdapter() : new Loki.LokiMemoryAdapter()
})

function loadHandler () {
  users = db.getCollection('users')
  if (users === null) { // if database do not exist it will be empty so intitialize here
    users = db.addCollection('users', {
      unique: ['id', 'userName']
    })
  }

  groups = db.getCollection('groups')
  if (groups === null) {
    groups = db.addCollection('groups', {
      unique: ['displayName']
    })
  }

  if (db.options.autoload === false) { // not using persistence (physical database) => load testusers
    scimgateway.testmodeusers.forEach(record => {
      if (record.meta) delete record.meta
      users.insert(record)
    })
    scimgateway.testmodegroups.forEach(record => {
      groups.insert(record)
    })
  }
}

if (db.options.autoload === false) loadHandler()

// =================================================
// exploreUsers
// =================================================
scimgateway.exploreUsers = async (baseEntity, attributes, startIndex, count) => {
  const action = 'exploreUsers'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" attributes=${attributes} startIndex=${startIndex} count=${count}`)

  const ret = { // itemsPerPage will be set by scimgateway
    Resources: [],
    totalResults: null
  }
  const usersArr = users.chain().data()

  if (!startIndex && !count) { // client request without paging
    startIndex = 1
    count = usersArr.length
    if (count > 500) count = 500
  }

  const arr = usersArr.map(obj => { return stripLoki(obj) }) // includes all user attributes but groups - user attribute groups automatically handled by scimgateway
  const usersDelta = arr.slice(startIndex - 1, startIndex - 1 + count)
  Array.prototype.push.apply(ret.Resources, usersDelta)
  ret.totalResults = usersDelta.length
  return ret // all explored users
}

// =================================================
// exploreGroups
// =================================================
scimgateway.exploreGroups = async (baseEntity, attributes, startIndex, count) => {
  const action = 'exploreGroups'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" attributes=${attributes} startIndex=${startIndex} count=${count}`)

  const ret = { // itemsPerPage will be set by scimgateway
    Resources: [],
    totalResults: null
  }
  const groupsArr = groups.chain().data()

  if (!startIndex && !count) { // client request without paging
    startIndex = 1
    count = groupsArr.length
  }

  const arr = groupsArr.map(obj => { return stripLoki(obj) }) // includes all groups attributes (also members)
  const groupsDelta = arr.slice(startIndex - 1, startIndex - 1 + count)
  Array.prototype.push.apply(ret.Resources, groupsDelta)
  ret.totalResults = groupsDelta.length
  return ret // all explored groups
}

// =================================================
// getUser
// =================================================
scimgateway.getUser = async (baseEntity, getObj, attributes) => {
  // getObj = { filter: <filterAttribute>, identifier: <identifier> }
  // e.g: getObj = { filter: 'userName', identifier: 'bjensen'}
  // filter: userName and id must be supported
  // (they are most often considered as "the same" where identifier = UserID )
  // Note, the value of id attribute returned will be used by modifyUser and deleteUser
  // attributes: if not blank, attributes listed should be returned
  // Should normally return all supported user attributes having id and userName as mandatory
  // SCIM Gateway will automatically filter response according to the attributes list
  const action = 'getUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" ${getObj.filter}=${getObj.identifier} attributes=${attributes}`)

  const findObj = {}
  findObj[getObj.filter] = getObj.identifier // { userName: 'bjensen } / { externalId: 'bjensen } / { id: 'bjensen } / { 'emails.value': 'jsmith@example.com'} / { 'phoneNumbers.value': '555-555-5555'}

  const res = users.find(findObj)
  if (res.length !== 1) return null // no user, or more than one user found
  return stripLoki(res[0]) // includes all user attributes but groups - user attribute groups automatically handled by scimgateway
}

// =================================================
// createUser
// =================================================
scimgateway.createUser = async (baseEntity, userObj) => {
  const action = 'createUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" userObj=${JSON.stringify(userObj)}`)

  const notValid = scimgateway.notValidAttributes(userObj, validScimAttr) // We should check for unsupported endpoint attributes
  if (notValid) {
    const err = new Error(`unsupported scim attributes: ${notValid} ` + `(supporting only these attributes: ${validScimAttr.toString()})`)
    throw err
  }

  if (userObj.password) delete userObj.password // exclude password db not ecrypted
  for (var key in userObj) {
    if (!Array.isArray(userObj[key]) && scimgateway.isMultiValueTypes(key)) { // true if attribute is "type converted object" => convert to standard array
      const arr = []
      for (var el in userObj[key]) {
        userObj[key][el].type = el
        if (el === 'undefined') delete userObj[key][el].type // type "undefined" reverted back to original blank
        arr.push(userObj[key][el]) // create
      }
      userObj[key] = arr
    }
  }

  userObj.id = userObj.userName // for loki-plugin (scim endpoint) id is mandatory and set to userName
  try {
    users.insert(userObj)
  } catch (err) {
    if (err.message && err.message.startsWith('Duplicate key')) {
      err.name = 'DuplicateKeyError' // gives scimgateway statuscode 409 instead of default 500
    }
    throw err
  }
  return null
}

// =================================================
// deleteUser
// =================================================
scimgateway.deleteUser = async (baseEntity, id) => {
  const action = 'deleteUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id}`)

  const res = users.find({ id: id })
  if (res.length !== 1) throw new Error(`Failed to delete user with id=${id}`)
  const userObj = res[0]
  users.remove(userObj)
  return null
}

// =================================================
// modifyUser
// =================================================
scimgateway.modifyUser = async (baseEntity, id, attrObj) => {
  const action = 'modifyUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(attrObj)}`)

  const notValid = scimgateway.notValidAttributes(attrObj, validScimAttr) // We should check for unsupported endpoint attributes
  if (notValid) {
    const err = new Error(`unsupported scim attributes: ${notValid} ` +
          `(supporting only these attributes: ${validScimAttr.toString()})`
    )
    throw err
  }
  if (attrObj.password) delete attrObj.password // exclude password db not ecrypted

  const res = users.find({ id: id })
  if (res.length !== 1) throw new Error(`Could not find user with id=${id}`)
  const userObj = res[0]

  for (var key in attrObj) {
    if (Array.isArray(attrObj[key])) { // standard, not using type (e.g groups)
      attrObj[key].forEach(el => {
        if (el.operation === 'delete') {
          userObj[key] = userObj[key].filter(e => e.value !== el.value)
          if (userObj[key].length < 1) delete userObj[key]
        } else { // add
          if (!userObj[key]) userObj[key] = []
          let exists
          if (el.value) exists = userObj[key].find(e => e.value && e.value === el.value)
          if (!exists) userObj[key].push(el)
        }
      })
    } else if (scimgateway.isMultiValueTypes(key)) { // "type converted object" logic and original blank type having type "undefined"
      if (!attrObj[key]) delete userObj[key] // blank or null
      for (var el in attrObj[key]) {
        attrObj[key][el].type = el
        if (attrObj[key][el].operation && attrObj[key][el].operation === 'delete') { // delete multivalue
          let type = el
          if (type === 'undefined') type = undefined
          userObj[key] = userObj[key].filter(e => e.type !== type)
          if (userObj[key].length < 1) delete userObj[key]
        } else { // modify/create multivalue
          if (!userObj[key]) userObj[key] = []
          var found = userObj[key].find((e, i) => {
            if (e.type === el || (!e.type && el === 'undefined')) {
              for (const k in attrObj[key][el]) {
                userObj[key][i][k] = attrObj[key][el][k]
                if (k === 'type' && attrObj[key][el][k] === 'undefined') delete userObj[key][i][k] // don't store with type "undefined"
              }
              return true
            } else return false
          })
          if (attrObj[key][el].type && attrObj[key][el].type === 'undefined') delete attrObj[key][el].type // don't store with type "undefined"
          if (!found) userObj[key].push(attrObj[key][el]) // create
        }
      }
    } else {
      // None multi value attribute
      if (typeof (attrObj[key]) !== 'object' || attrObj[key] === null) {
        if (attrObj[key] === '' || attrObj[key] === null) delete userObj[key]
        else userObj[key] = attrObj[key]
      } else {
        // name.familyName=Bianchi
        if (!userObj[key]) userObj[key] = {} // e.g name object does not exist
        for (var sub in attrObj[key]) { // attributes to be cleard located in meta.attributes eg: {"meta":{"attributes":["name.familyName","profileUrl","title"]}
          if (sub === 'attributes' && Array.isArray(attrObj[key][sub])) {
            attrObj[key][sub].forEach(element => {
              var arrSub = element.split('.')
              if (arrSub.length === 2) userObj[arrSub[0]][arrSub[1]] = '' // e.g. name.familyName
              else userObj[element] = ''
            })
          } else {
            if (Object.prototype.hasOwnProperty.call(attrObj[key][sub], 'value') &&
                attrObj[key][sub].value === '') delete userObj[key][sub] // object having blank value attribute e.g. {"manager": {"value": "",...}}
            else if (attrObj[key][sub] === '') delete userObj[key][sub]
            else {
              if (!userObj[key]) userObj[key] = {} // may have been deleted by length check below
              userObj[key][sub] = attrObj[key][sub]
            }
            if (Object.keys(userObj[key]).length < 1) delete userObj[key]
          }
        }
      }
    }
  }
  users.update(userObj) // needed for persistence
  return null
}

// =================================================
// getGroup
// =================================================
scimgateway.getGroup = async (baseEntity, getObj, attributes) => {
  // getObj = { filter: <filterAttribute>, identifier: <identifier> }
  // e.g: getObj = { filter: 'displayName', identifier: 'GroupA' }
  // filter: displayName and id must be supported
  // (they are most often considered as "the same" where identifier = GroupName)
  // Note, the value of id attribute returned will be used by deleteGroup, getGroupMembers and modifyGroup
  // attributes: if not blank, attributes listed should be returned
  // Should normally return all supported group attributes having id, displayName and members as mandatory
  // members may be skipped if attributes is not blank and do not contain members or members.value
  const action = 'getGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" ${getObj.filter}=${getObj.identifier} attributes=${attributes}`)

  const findObj = {}
  findObj[getObj.filter] = getObj.identifier // { displayName: 'GroupA' }

  const res = groups.find(findObj)
  if (res.length !== 1) return null // no group found
  return stripLoki(res[0]) // includes all group attributes (also members)
}

// =================================================
// getGroupMembers
// =================================================
scimgateway.getGroupMembers = async (baseEntity, id, attributes) => {
  // return all groups the user is member of having attributes included e.g: members.value,id,displayName
  // method used when "users member of group", if used - getUser must treat user attribute groups as virtual readOnly attribute
  // "users member of group" is SCIM default and this method should normally have some logic
  const action = 'getGroupMembers'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" user id=${id} attributes=${attributes}`)

  const arrRet = []
  groups.data.forEach(el => {
    if (el.members) {
      const userFound = el.members.find(element => element.value === id)
      if (userFound) {
        let arrAttr = []
        if (attributes) arrAttr = attributes.split(',')
        const userGroup = {}
        arrAttr.forEach(attr => {
          if (el[attr]) userGroup[attr] = el[attr] // id, displayName, members.value
        })
        userGroup.members = [{ value: id }] // only includes current user (not all members)
        arrRet.push(userGroup) // { id: <id-group>> , displayName: <displayName-group>, members [{value: <id-user>}] }
      }
    }
  })
  return arrRet
}

// =================================================
// getGroupUsers
// =================================================
scimgateway.getGroupUsers = async (baseEntity, id, attributes) => {
  // return array of all users that is member of this group id having attributes included e.g: groups.value,userName
  // method used when "group member of users", if used - getGroup must treat group attribute members as virtual readOnly attribute
  const action = 'getGroupUsers'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id} attributes=${attributes}`)

  const arrRet = []
  users.data.forEach((user) => {
    if (user.groups) {
      user.groups.forEach((group) => {
        if (group.value === id) {
          arrRet.push( // {userName: "bjensen", groups: [{value: <group id>}]} - value only includes current group id
            {
              userName: user.userName,
              groups: [{ value: id }]
            }
          )
        }
      })
    }
  })
  return arrRet
}

// =================================================
// createGroup
// =================================================
scimgateway.createGroup = async (baseEntity, groupObj) => {
  const action = 'createGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" groupObj=${JSON.stringify(groupObj)}`)

  groupObj.id = groupObj.displayName // for loki-plugin (scim endpoint) id is mandatory and set to displayName
  groups.insert(groupObj)
  return null
}

// =================================================
// deleteGroup
// =================================================
scimgateway.deleteGroup = async (baseEntity, id) => {
  const action = 'deleteGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id}`)

  const res = groups.find({ id: id })
  if (res.length !== 1) throw new Error(`Failed to delete group with id=${id}`)
  const groupObj = res[0]
  groups.remove(groupObj)
  return null
}

// =================================================
// modifyGroup
// =================================================
scimgateway.modifyGroup = async (baseEntity, id, attrObj) => {
  const action = 'modifyGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(attrObj)}`)

  if (!attrObj.members) {
    throw new Error(`plugin handling "${action}" only supports modification of members`)
  }
  if (!Array.isArray(attrObj.members)) {
    throw new Error(`plugin handling "${action}" error: ${JSON.stringify(attrObj)} - correct syntax is { "members": [...] }`)
  }

  const res = groups.find({ id: id })
  if (res.length !== 1) throw new Error(`Failed to find group with id=${id}`)
  const groupObj = res[0]

  if (!groupObj.members) groupObj.members = []
  const usersNotExist = []

  await attrObj.members.forEach(async el => {
    if (el.operation && el.operation === 'delete') { // delete member from group
      if (!el.value) groupObj.members = [] // members=[{"operation":"delete"}] => no value, delete all members
      else groupObj.members = groupObj.members.filter(element => element.value !== el.value)
    } else { // Add member to group
      if (el.value) { // check if user exist
        const usrObj = { filter: 'id', identifier: el.value }
        const usr = await scimgateway.getUser(baseEntity, usrObj, 'id')
        if (!usr) {
          usersNotExist.push(el.value)
          return
        }
      }
      var newMember = {
        display: el.value,
        value: el.value
      }
      let exists
      if (el.value) exists = groupObj.members.find(e => (el.value && e.value === el.value))
      if (!exists) groupObj.members.push(newMember)
    }
  })

  groups.update(groupObj)

  if (usersNotExist.length > 0) throw new Error(`can't use ${action} including none existing user(s): ${usersNotExist.toString()}`)
  return null
}

// =================================================
// helpers
// =================================================

const stripLoki = (obj) => { // remove loki meta data and insert scim
  const retObj = JSON.parse(JSON.stringify(obj)) // new object - don't modify loki source
  if (retObj.meta) {
    if (retObj.meta.created) retObj.meta.created = new Date(retObj.meta.created).toISOString()
    delete retObj.meta.lastModified // test users loaded
    if (retObj.meta.updated) {
      retObj.meta.lastModified = new Date(retObj.meta.updated).toISOString()
      delete retObj.meta.updated
    }
    if (retObj.meta.revision !== undefined) {
      retObj.meta.version = retObj.meta.revision
      delete retObj.meta.revision
    }
  }
  delete retObj.$loki
  return retObj
}

//
// Cleanup on exit
//
process.on('SIGTERM', () => { // kill
  db.close()
})
process.on('SIGINT', () => { // Ctrl+C
  db.close()
})
