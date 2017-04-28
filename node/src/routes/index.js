import express from 'express'
import {asyncRouter as ar} from '../utils'
import * as raft from '../raft'

import fetch from 'node-fetch'

const router = express.Router()

import baseDebug from 'debug'
const debug = baseDebug('route')

/* GET home page. */
router.get('/', function (req, res, next) {
  res.send(`API server running, but there's nothing here.`)
})

// Simple rpc receiver
const rpcMap = {
  setNodeId: raft.setNodeId,
  appendEntries: raft.appendEntries,
  requestVote: raft.requestVote
}

router.post('/rpc', ar(async function (req, res, next) {
  const {action, data} = req.body
  res.send(JSON.stringify(await rpcMap[action](data)))
}))

// Set kev/value on map directly, used for debugging
router.get('/set/:key/:value', ar(async function (req, res, next) {
  const {key, value} = req.params

  await raft.setData(key, parseFloat(value))

  res.send('OK')
}))

// Set load for a host
router.get('/load/:key/:value', ar(async function (req, res, next) {
  const {key, value} = req.params

  await raft.setLoad(key, parseFloat(value))

  res.send('OK')
}))

// Return the host that will be used for prime number generation
router.get('/prime/dest', ar(async function (req, res, next) {
  const dest = await raft.getLowestLoadActiveHost()

  if (!dest) {
    res.status(500).send('No active hosts!')
  } else {
    res.send(`The lowest load active host is ${dest}`)
  }
}))

// Prime number reverse proxy
router.get('/prime/:n', ar(async function (req, res, next) {
  const {n} = req.params

  const dest = await raft.getLowestLoadActiveHost()

  if (!dest) {
    res.status(500).send('No active hosts!')
  } else {
    debug(`Sending prime request to ${dest}`)
    const result = await fetch(`http://${dest}/${n}`).then(r => r.text())

    res.send(result)
  }
}))

// Return entire node state for debugging
router.get('/state', ar(async function (req, res, next) {
  res.send(JSON.stringify(raft.getNodeState()))
}))

module.exports = router
