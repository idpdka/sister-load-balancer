import rpc from './rpc'
import fs from 'fs'
import shortid from 'shortid'

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

  commitIndex: -1,
  lastApplied: -1
}

// All nodes, excluding the current one.
let nodeCount
let nodes = []

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

async function startElection () {
  debug(`Starting election`)
  await incrementNodeTerm()

  nodeState.votedFor = nodeState.id

  const rvPromises = nodes.map(n => n.requestVote({
    term: nodeState.currentTerm,
    candidateId: nodeState.id,
    lastLogIndex: nodeState.lastLogIndex(),
    lastLogTerm: nodeState.lastLogTerm()
  }))

  const rvResults = await Promise.all(rvPromises)

  debug(`All vote requests replied/timed out`)

  let votes = 1

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

async function leaderProcess () {
  if (nodeState.state === 'leader') {
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
      }).then(response => ({node: n, response}))
    })

    let aeResponses = await Promise.all(aePromises)

    for (let {node, response} of aeResponses.filter(r => r.response)) {
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
          node.nextIndex = node.matchIndex = nodeState.lastLogIndex()
        }
      }
    }

    // Incrementing commitIndex
    while (true) {
      if (nodeState.commitIndex === nodeState.lastLogIndex()) break

      let newCommitted = nodeState.commitIndex + 1

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

    setTimeout(leaderProcess, 1000)
  }
}

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

  applyData()

  return {
    term: nodeState.currentTerm,
    empty: nodeState.log.length === 0,
    success: success
  }
}

export async function requestVote ({term, candidateId, lastLogIndex, lastLogTerm}) {
  if (!isReady()) return null
  timeout.refreshFollowerTimeout()

  if (term > nodeState.currentTerm) {
    await changeNodeTerm(term)
  }

  const grantVote = !(term < nodeState.currentTerm) &&
                    (nodeState.votedFor === null || nodeState.votedFor === candidateId) &&
                    lastLogIndex >= nodeState.lastLogIndex()

  if (grantVote) debug(`Voting for ${candidateId} at term ${term}`)

  return {
    term: nodeState.currentTerm,
    voteGranted: grantVote
  }
}

export function setNodeId ({id, randomId}) {
  if (randomId === nodeState.randomId) {
    nodeState.id = id
    return true
  }
  return false
}

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

export function getNodeState () {
  return nodeState
}
