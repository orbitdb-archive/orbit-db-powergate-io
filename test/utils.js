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

module.exports = {
  waitForBalance
}

