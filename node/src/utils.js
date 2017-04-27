export function clamp (a, b, x) {
  if (x < a) return a
  else if (x > b) return b
  else return x
}

export function asyncRouter (asyncFn) {
  return function (req, res, next) {
    asyncFn(req, res, next)
    .catch(next)
  }
}

export function wait (ms) {
  return new Promise(function (resolve, reject) {
    setTimeout(resolve, ms)
  })
}
