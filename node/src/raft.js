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

  nextIndex: {},
  matchIndex: {}
}

// All nodes, excluding the current one.
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
  for (let i = 0; i < nodeLocations.length; i++) {
    const nodeLocation = nodeLocations[i]
    const node = rpc(`http://${nodeLocation}`, {
      id: i,
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

  timeout.startFollowerTimeout()
}

// Handlers for timeouts
function followerTimeout () {
  debug(`No info from leader at term ${nodeState.currentTerm}`)
  nodeState.state = 'candidate'
  nodeState.currentTerm++
  startElection()
}

function electionTimeout () {
  // Split vote case
  if (nodeState.state === 'candidate') {
    debug('Starting another election...')
    startElection()
  }
}

// Utility functions
async function startElection () {
  debug(`Starting election`)

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
    nodeState.state = 'leader'
    debug(`Got the majority vote. I'm now the leader`)
    leaderProcess()
  } else {
    debug(`Not enough votes! Preparing to restart election`)
    timeout.startElectionTimeout()
  }
}

async function leaderProcess () {
  if (nodeState.state === 'leader') {
    const aePromises = nodes.map(n => n.appendEntries({
      term: nodeState.currentTerm,
      leaderId: nodeState.id,
      prevLogIndex: nodeState.log.length - 1,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: false
    }))

    const aeResponses = await Promise.all(aePromises)

    setTimeout(leaderProcess, 1000)
  }
}

// RPC methods for communication between nodes, based on raft paper
export function appendEntries ({term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit}) {
  if (!isReady()) return null
  timeout.refreshFollowerTimeout()

  if (term >= nodeState.currentTerm && nodeState.state !== 'follower') {
    debug(`Another leader has appeared, switching to follower`)
    nodeState.state = 'follower'
  }

  if (term > nodeState.currentTerm) {
    nodeState.currentTerm = term
  }

  return {
    term: nodeState.currentTerm,
    success: true
  }
}

export function requestVote ({term, candidateId, lastLogIndex, lastLogTerm}) {
  if (!isReady()) return null
  timeout.refreshFollowerTimeout()

  if (term > nodeState.currentTerm) {
    nodeState.currentTerm = term
    nodeState.votedFor = null
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
