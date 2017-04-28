import rpc from './rpc'
import fs from 'fs'
import shortid from 'shortid'
import moment from 'moment'

import baseDebug from 'debug'
const debug = baseDebug('raft')

// Based on raft paper https://raft.github.io/raft.pdf

let nodeState = {
  // This is used to determine the current ID.
  // At start, the node sends RPCs containing the randomId
  // and the index on the nodesfile.
  // The current id is set to the index only if the randomId
  // matches the current randomId.
  randomId: shortid(),
  id: -1,

  state: 'follower', // follower, candidate, leader
  port: 0,

  currentTerm: 0,
  votedFor: null,

  /*
    Data structure:
    {
      index: [log index]
      term: [term when written],
      data: [log contents]
    }
  */
  log: [],

  data: {},

  lastLogIndex () {
    return nodeState.log.length - 1
  },
  lastLogTerm () {
    if (nodeState.log.length > 0) {
      return nodeState.log[nodeState.log.length - 1].term
    } else {
      return 0
    }
  },

  // Minor difference with raft paper, log indexes are 0-based
  commitIndex: -1,
  lastApplied: -1
}

// All nodes, excluding the current one. Updated by loadNodes
let nodeCount
let nodes = []

// Timeout manager
let timeout = {
  /*
    If a timeout is in progress, this contains:
    {
      kind: 'follower', // or 'election'
      timeout: // the timeout object returned by setTimeout
    }
  */
  currentTimeout: null,

  clearCurrentTimeout () {
    if (timeout.currentTimeout) {
      clearTimeout(timeout.currentTimeout.timeout)
    }
  },

  // The start methods also restart the timeouts, if any are running
  // The names are a bit different from the raft paper
  startFollowerTimeout () {
    timeout.clearCurrentTimeout()
    timeout.currentTimeout = {
      kind: 'follower',
      timeout: setTimeout(followerTimeout, 1500 + Math.random() * 1500)
    }
  },
  startElectionTimeout () {
    timeout.clearCurrentTimeout()
    timeout.currentTimeout = {
      kind: 'election',
      timeout: setTimeout(electionTimeout, 1500 + Math.random() * 1500)
    }
  },

  refreshFollowerTimeout () {
    if (nodeState.state === 'follower') {
      debug(`Refreshing follower timeout, term: ${nodeState.currentTerm}`)
      timeout.startFollowerTimeout()
    }
  }
}

// Setup functions
export function setPort (portNum) {
  nodeState.port = portNum
}

// Only receive requests when ready, checked by other code
function isReady () {
  return nodeState.id >= 0
}

export async function loadNodes (nodesFilePath) {
  const fileData = fs.readFileSync(nodesFilePath, 'utf8')
  let nodeLocations = fileData.split(/[\r\n]+/g).filter(x => x.length > 0)
  nodeCount = nodeLocations.length
  for (let i = 0; i < nodeCount; i++) {
    const nodeLocation = nodeLocations[i]
    const node = rpc(`http://${nodeLocation}`, {
      id: i,
      nextIndex: -1,
      matchIndex: -1,
      location: nodeLocation
    })

    const isCurrentNode = await node.setNodeId({id: i, randomId: nodeState.randomId})

    if (!isCurrentNode) {
      debug(`Discovered node ${i} at ${node.location}`)
      nodes.push(node)
    }
  }

  if (nodeState.id < 0) {
    debug(`Cannot determine own ID!`)
  } else {
    debug(`I'm node ${nodeState.id}`)
  }
}

export async function start () {
  await loadNodes('../nodes.txt')

  await changeNodeState('follower')
}

// Handlers for timeouts
function followerTimeout () {
  debug(`No info from leader at term ${nodeState.currentTerm}`)
  changeNodeState('candidate')
}

function electionTimeout () {
  if (nodeState.state === 'candidate') {
    debug('Starting another election...')
    startElection()
  }
}

// Utility functions

// Function to change node state
// This function is the only one allowed to change nodeState.state directly
async function changeNodeState (state) {
  nodeState.state = state
  if (state === 'follower') {
    timeout.startFollowerTimeout()
  } else if (state === 'candidate') {
    startElection()
  } else if (state === 'leader') {
    for (let node of nodes) {
      node.nextIndex = nodeState.lastLogIndex() + 1
      node.matchIndex = -1
    }
    leaderProcess()
  } else {
    throw new Error(`Programmer error`)
  }
}

// Same with changeNodeState, this is also the only place nodeState.currentTerm can be modified
async function changeNodeTerm (term) {
  if (term < nodeState.currentTerm) throw new Error(`currentTerm must be increasing`)
  if (term > nodeState.currentTerm) {
    nodeState.votedFor = null
  }
  nodeState.currentTerm = term
}

async function incrementNodeTerm () {
  await changeNodeTerm(nodeState.currentTerm + 1)
}

// Election process
async function startElection () {
  debug(`Starting election`)
  await incrementNodeTerm()

  nodeState.votedFor = nodeState.id

  // Send vote requests in parallel
  const rvPromises = nodes.map(n => n.requestVote({
    term: nodeState.currentTerm,
    candidateId: nodeState.id,
    lastLogIndex: nodeState.lastLogIndex(),
    lastLogTerm: nodeState.lastLogTerm()
  }))

  const rvResults = await Promise.all(rvPromises)

  debug(`All vote requests replied/timed out`)

  let votes = 1 // My own vote

  for (let rv of rvResults.filter(rv => rv)) {
    if (rv) {
      if (rv.voteGranted) {
        votes++
      }
    }
  }

  if (votes > nodes.length / 2) {
    debug(`Got the majority vote. I'm now the leader`)

    changeNodeState('leader')
  } else {
    debug(`Not enough votes! Preparing to restart election`)
    timeout.startElectionTimeout()
  }
}

// One iteration of a leader's work
// Includes: sending appendEntries, committing entries, and applying data
async function leaderProcess () {
  if (nodeState.state === 'leader') {
    // Send appendEntries in parallel
    const aePromises = nodes.map(n => {
      const prevLogIndex = n.nextIndex - 1
      const prevLogTerm = prevLogIndex >= 0 ? nodeState.log[prevLogIndex].term : 0

      return n.appendEntries({
        term: nodeState.currentTerm,
        leaderId: nodeState.id,
        prevLogIndex,
        prevLogTerm,
        entries: nodeState.log.slice(prevLogIndex + 1),
        leaderCommit: nodeState.commitIndex
      }).then(response => ({node: n, response})) // Associate each response with its node
    })

    let aeResponses = await Promise.all(aePromises)

    // Process responses
    for (let {node, response} of aeResponses.filter(r => r.response)) {
      // Response might be null, if the node is down
      if (response) {
        let {term, success, empty} = response

        if (term > nodeState.currentTerm) {
          debug(`Discovered follower with higher term, reverting to follower`)
          changeNodeTerm(term)
          changeNodeState('follower')
          break
        }

        if (!success) {
          if (empty && nodeState.log.length > 0) {
            debug(`Node ${node.id} is empty! Just send everything`)
            node.nextIndex = 0
          } else if (node.nextIndex > 0) {
            debug(`Node ${node.id} does not have ${node.nextIndex - 1} yet.`)
            node.nextIndex--
          }
        } else {
          // Successfully updated logs, update indexes with own lastLogIndex
          node.nextIndex = node.matchIndex = nodeState.lastLogIndex()
        }
      }
    }

    // Incrementing commitIndex
    while (true) {
      if (nodeState.commitIndex === nodeState.lastLogIndex()) break

      let newCommitted = nodeState.commitIndex + 1

      // Check commitIndex majority
      let matches = 1 // With myself
      for (let node of nodes) {
        if (node.matchIndex >= newCommitted) {
          matches++
        }
      }

      if (matches > nodeCount / 2) {
        debug(`Incrementing commitIndex...`)
        nodeState.commitIndex = newCommitted
      } else {
        debug(`Don't have a majority, can't commit data yet`)
        break
      }
    }

    applyData()

    // Do the leader process again
    setTimeout(leaderProcess, 1000)
  }
}

// Apply log commands based on commitIndex and lastApplied
function applyData () {
  // Applying log to data
  while (nodeState.lastApplied < nodeState.commitIndex) {
    nodeState.lastApplied++
    const {key, value} = nodeState.log[nodeState.lastApplied].data
    debug(`Applying data by setting ${key} = ${value}`)
    nodeState.data[key] = value

    debug(`Data is now: ${JSON.stringify(nodeState.data)}`)
  }
}

// RPC methods for communication between nodes, based on raft paper
// Code for receiving appendEntries
// Most of the code are direct translations of raft spec
export async function appendEntries ({term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit}) {
  if (!isReady()) return null
  timeout.refreshFollowerTimeout()

  if (term >= nodeState.currentTerm && nodeState.state === 'candidate') {
    debug(`Another leader has appeared, switching to follower`)
    changeNodeState('follower')
  }

  if (term > nodeState.currentTerm) {
    changeNodeTerm(term)
  }

  let success = true

  if (term < nodeState.currentTerm) {
    success = false
    debug(`Leader has outdated term.`)
  } else if (
    prevLogIndex > nodeState.lastLogIndex() ||
    (nodeState.log.length > 0 && prevLogIndex >= 0 && nodeState.log[prevLogIndex].term !== prevLogTerm)) {
    success = false
  } else {
    nodeState.log.splice(prevLogIndex + 1)
    entries.forEach(e => {
      nodeState.log.push(e)
    })

    if (leaderCommit > nodeState.commitIndex) {
      nodeState.commitIndex = Math.min(leaderCommit, nodeState.lastLogIndex())
    }
  }

  // Apply received log entries so it can be used
  applyData()

  return {
    term: nodeState.currentTerm,
    // Extension for faster updates when a node is restarted
    empty: nodeState.log.length === 0,
    success: success
  }
}

// Code for receiving requestVotes
export async function requestVote ({term, candidateId, lastLogIndex, lastLogTerm}) {
  if (!isReady()) return null
  timeout.refreshFollowerTimeout()

  if (term > nodeState.currentTerm) {
    await changeNodeTerm(term)
  }

  // Based on raft paper
  const grantVote = !(term < nodeState.currentTerm) &&
                    (nodeState.votedFor === null || nodeState.votedFor === candidateId) &&
                    lastLogIndex >= nodeState.lastLogIndex()

  if (grantVote) debug(`Voting for ${candidateId} at term ${term}`)

  return {
    term: nodeState.currentTerm,
    voteGranted: grantVote
  }
}

// RPC used to determine own id, instead of messing with network interfaces and IPs
export function setNodeId ({id, randomId}) {
  if (randomId === nodeState.randomId) {
    nodeState.id = id
    return true
  }
  return false
}

// Exported functions for use by http routes

// Directly set data on map
export async function setData (key, value) {
  if (nodeState.state === 'leader') {
    debug(`Received request to set ${key} to ${value}`)

    nodeState.log.push({
      index: nodeState.lastLogIndex() + 1,
      term: nodeState.currentTerm,
      data: {
        key,
        value
      }
    })
  }
}

// Set a host's cpu load
export async function setLoad (host, load) {
  if (nodeState.state === 'leader') {
    debug(`Received request to set load of ${host} to ${load}`)

    nodeState.log.push({
      index: nodeState.lastLogIndex() + 1,
      term: nodeState.currentTerm,
      data: {
        key: host,
        value: {
          lastContact: +moment(),
          load
        }
      }
    })
  }
}

// The name is probably descriptive enough
// If no active host, return '' (a falsy value)
export async function getLowestLoadActiveHost () {
  // Active means has contacted daemon within the last 10 seconds

  const hosts = Object.keys(nodeState.data)

  // Filter inactive
  const activeHosts = hosts.filter(host => {
    const hostLastContact = moment(nodeState.data[host].lastContact)

    return moment().diff(hostLastContact, 'seconds') < 10
  })

  if (activeHosts.length <= 0) return ''

  const result = activeHosts.slice(1).reduce((a, b) => {
    if (nodeState.data[a].load < nodeState.data[b].load) {
      return a
    } else {
      return b
    }
  }, activeHosts[0])

  return result
}

// Function to get entire node state, useful for debug purposes
export function getNodeState () {
  return nodeState
}
