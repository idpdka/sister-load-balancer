import express from 'express'
import {asyncRouter as ar} from '../utils'
import * as raft from '../raft'

const router = express.Router()

/* GET home page. */
router.get('/', function (req, res, next) {
  res.send(`API server running, but there's nothing here.`)
})

router.get('/prime/:n', ar(async function (req, res, next) {

}))

const rpcMap = {
  setNodeId: raft.setNodeId,
  appendEntries: raft.appendEntries,
  requestVote: raft.requestVote
}

router.post('/rpc', ar(async function (req, res, next) {
  const {action, data} = req.body
  res.send(JSON.stringify(await rpcMap[action](data)))
}))

router.get('/set/:key/:value', ar(async function (req, res, next) {
  const {key, value} = req.params

  raft.setData(key, parseFloat(value))

  res.send('OK')
}))

router.get('/state', ar(async function (req, res, next) {
  res.send(JSON.stringify(raft.getNodeState()))
}))

module.exports = router
