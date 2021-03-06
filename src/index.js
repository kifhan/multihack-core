/* globals window */

var Y = require('yjs')
require('y-memory')(Y)
require('y-array')(Y)
require('y-map')(Y)
require('y-multihack')(Y)
var YText = require('y-text')(Y)

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var Voice

inherits(RemoteManager, EventEmitter)

function RemoteManager (opts) {
  var self = this
  
  opts = opts || {}
  Voice = opts.voice || null
  opts.wrtc = opts.wrtc || null
  self.roomID = opts.room || 'welcome'
  self.hostname = opts.hostname || 'https://quiet-shelf-57463.herokuapp.com'
  self.nickname = opts.nickname || 'Guest'
  self.id = null
  self.yfs = null
  self.ySelections = null
  self.posFromIndex = function (filePath, index, cb) {
    console.warn('No "remote.posFromIndex" provided. Unable to apply change!')
  }
  self.client = null
  self.voice = null
  self.peers = []
  self.lastSelection = null
  
  var tokens = {}
  self.mutualExcluse = function (key, f) {
    if (!tokens[key]) {
      tokens[key] = true
      try {
        f()
      } catch (e) {
        delete tokens[key]
        throw new Error(e)
      }
      delete tokens[key]
    }
  }
  
  Y({
    db: {
      name: 'memory' // Store the CRDT model in memory
    },
    connector: {
      name: 'multihack', // TODO: Use a custom connector
      room: self.roomID,
      hostname: self.hostname,
      nickname: self.nickname,
      wrtc: opts.wrtc,
      events: function (event, value) {
        if (event === 'id') {
          self.id = value
        } else if (event === 'client') {
          self.client = value
        } else if (event === 'voice') {
          if (Voice) {
            self.voice = new Voice(value.socket, value.client, self.roomID)
          }
        } else if (event === 'peers') {
          self.peers = value
        }
        self.emit(event, value)
      }
    },
    share: {
      selections: 'Array',
      dir_tree: 'Map'
    }
  }).then(function (y) {
    self.yfs = y.share.dir_tree
    self.ySelections = y.share.selections
    
    self.ySelections.observe(function (event) {
      if (event.type === 'insert') {
        event.values.forEach(function (sel) {
          if (sel.id !== self.id || !self.id) {
            self.emit('changeSelection', sel)
          }
        })
      }
    })
    
    self.yfs.observe(function (event) {
      var filePath = event.name

      if (event.type === 'add') { // create file/folder     

        if (event.value instanceof Y.Text.typeDefinition.class) {
          event.value.observe(self._onYTextAdd.bind(self, filePath))
          
          self.emit('createFile', {
            filePath: filePath,
            content: event.value.toString()
          })
        } else {
          self.emit('createDir', {
            path: filePath
          })
        }
      } else if (event.type === 'update') { 
        // a file with the same name has been added
        self.emit('deleteFile', {
          filePath: filePath
        })
        if (event.value instanceof Y.Text.typeDefinition.class) {
          event.value.observe(self._onYTextAdd.bind(self, filePath))
          self.emit('createFile', {
            filePath: filePath,
            content: event.value.toString()
          })
        } else {
          self.emit('createDir', {
            filePath: filePath
          })
        }
      } else if (event.type === 'delete') { // delete
        self.emit('deleteFile', {
          filePath: filePath
        })
      }
    })
    
    self.emit('ready')
  })
}

RemoteManager.prototype.getContent = function (filePath) {
  var self = this
  return self.yfs.get(filePath).toString()
}

RemoteManager.prototype.createFile = function (filePath, contents) {
  var self = this
  
  self.yfs.set(filePath, Y.Text)
  insertChunked(self.yfs.get(filePath), 0, contents || '')
}

RemoteManager.prototype.createDir = function (filePath, contents) {
  var self = this
  
  self.yfs.set(filePath, 'DIR')
}

function insertChunked(ytext, start, str) {
  var i = start
  var CHUNK_SIZE = 60000
  chunkString(str, CHUNK_SIZE).forEach(function (chunk) {
    ytext.insert(i, chunk)
    i+=chunk.length
  })
}

function chunkString(str, size) {
  var numChunks = Math.ceil(str.length / size),
      chunks = new Array(numChunks);

  for(var i = 0, o = 0; i < numChunks; ++i, o += size) {
    chunks[i] = str.substr(o, size);
  }

  return chunks;
}

RemoteManager.prototype.replaceFile = function (oldPath, newPath) {
  var self = this
  
  self.yfs.set(newPath, self.yfs.get(oldPath))
}
  
RemoteManager.prototype.deleteFile = function (filePath) {
  var self = this
  
  self.yfs.delete(filePath)
}

RemoteManager.prototype.changeFile = function (filePath, delta) {
  var self = this
  
  self.mutualExcluse(filePath, function () {
    var ytext = self.yfs.get(filePath)
    if (!ytext) return

    // apply the delta to the ytext instance
    var start = delta.start

    // apply the delete operation first
    if (delta.removed.length > 0) {
      var delLength = 0
      for (var j = 0; j < delta.removed.length; j++) {
        delLength += delta.removed[j].length
      }
      // "enter" is also a character in our case
      delLength += delta.removed.length - 1
      ytext.delete(start, delLength)
    }

    // apply insert operation
    insertChunked(ytext, start, delta.text.join('\n'))
  })
}

RemoteManager.prototype.changeSelection = function (data) {
  var self = this
  
  // remove our last select first
  if (self.lastSelection !== null) {
    self.ySelections.toArray().forEach(function (a, i) {
      if (a.tracker === self.lastSelection) {
        self.ySelections.delete(i)
      }
    })
  } 
  
  data.id = self.id
  data.tracker = Math.random()
  self.lastSelection = data.tracker
  self.ySelections.push([data])
}

RemoteManager.prototype._onYTextAdd = function (filePath, event) {
  var self = this
  
  self.mutualExcluse(filePath, function () { 
    self.posFromIndex(filePath, event.index, function (from) {
      if (event.type === 'insert') {
        console.log('got insert')
        self.emit('changeFile', {
          filePath, filePath,
          change: {
            from: from,
            to: from,
            text: event.values.join('')
          }
        })
      } else if (event.type === 'delete') {
        console.log('got delete')
        self.posFromIndex(filePath, event.index + event.length, function (to) {
          self.emit('changeFile', {
            filePath, filePath,
            change: {
              from: from,
              to: to,
              text: ''
            }
          })
        })
      }
    })
  })
}

RemoteManager.prototype.destroy = function () {
  var self = this
  
  // TODO: Add a proper destroy function in simple-signal
  peers.forEach(function (peer) {
    peer.destroy()
  })
  
  self.client = null
  self.voice = null
  self.id = null
  self.yfs = null
  self.ySelections = null
  self.posFromIndex = null
  self.lastSelection = null
}

module.exports = RemoteManager