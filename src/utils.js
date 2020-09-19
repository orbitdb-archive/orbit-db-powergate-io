const url = require('url')

function waitForBalance(ffs, address, greaterThan) {
  return new Promise(async (resolve, reject) => {
    while (true) {
      try {
        const res = await ffs.info()
        if (!res.info) {
          reject("no balance info returned")
          return
        }
        const info = res.info.balancesList.find((info) => info.addr && info.addr.addr === address)
        if (!info) {
          reject("address not in balances list")
          return
        }
        if (info.balance > greaterThan) {
          resolve(info.balance)
          return
        }
      } catch (e) {
        reject(e)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  })
}

const filterPublicMultiaddr = (addresses) => {
  const publicAddrs = addresses.map(a => a.toString())
                            .filter(a => a.indexOf('ip6') === -1)
                            .filter(a => a.indexOf('quic') === -1)
                            .filter(a => a.indexOf('127.0.0.1') === -1)
                            .filter(a => a.indexOf('ip4/192.168') === -1)
                            .filter(a => a.indexOf('ip4/10.') === -1)
                            .filter(a => a.indexOf('ip4/172.1') === -1)

  return publicAddrs
}

const generateIPFSOptions = (host, token) => {
  const urlObj = url.parse(host)
  const ipfsOptions = {
    host: urlObj.hostname,
    port: urlObj.port || 443,
    protocol: urlObj.protocol.replace(':', ''),
    headers: { 'x-ipfs-ffs-auth': token }
  }
  return ipfsOptions
}

module.exports = {
  filterPublicMultiaddr,
  generateIPFSOptions,
  waitForBalance
}
