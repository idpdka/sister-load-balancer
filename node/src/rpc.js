import fetch from 'node-fetch'

import baseDebug from 'debug'
const debug = baseDebug('rpc')

// Function to generate a proxy object that automatically sends requests
export default function rpc (address, initialData = {}) {
  return new Proxy(initialData, {
    get (target, name) {
      if (!(name in target)) {
        return async function (args) {
          try {
            debug(`Attempting rpc call '${name}' to ${address}`)
            const resPromise = fetch(address + '/rpc', {
              method: 'post',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                action: name,
                data: args
              })
            })

            // Customize timeout for faster response when a node is down
            return Promise.race([
              resPromise.then(r => r.json()),
              new Promise(function (resolve, reject) {
                setTimeout(r => resolve(null), 100)
              })
            ])
          } catch (e) {
            debug(`Cannot send RPC to ${address}: ${e}`)
            return null
          }
        }
      } else {
        return target[name]
      }
    }
  })
}
