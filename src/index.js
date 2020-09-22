const OrbitDB = require('orbit-db')
const { createPow } = require('@textile/powergate-client')
const IpfsClient = require('ipfs-http-client')
const {
  generateIPFSOptions,
  waitForBalance
} = require('./utils')
const Log = require('ipfs-log')

class PowergateIO {
  constructor (databases, orbitdb, pow, addr) {
    this.databases = databases
    this._orbitdb = orbitdb
    this._pow = pow

    this.wallet = {}
    waitForBalance(pow.ffs, addr, 0).then((info) => {
      this.wallet = info
    })

    this._jobWatchers = []
  }

  get ipfs () {
    return this._orbitdb._ipfs
  }

  // TODO: Config
  // TODO: Call this createDefault?
  static async create (host = 'http://0.0.0.0:6002') {
    const pow = createPow({ host })
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)

    const ipfsOptions = generateIPFSOptions(host, ffs.token)
    const ipfs = new IpfsClient(ipfsOptions)
    const orbitdb = await OrbitDB.createInstance(ipfs)

    const jobsDb = await orbitdb.docs('jobs', { indexBy: 'id' })

    // Create default address
    const { addr } = await pow.ffs.newAddr('_default')

    return new PowergateIO({ jobs: jobsDb }, orbitdb, pow, addr)
  }

  async getJobStatus (jobId) {
    await this.databases.jobs.load()
    return this.databases.jobs.get(jobId)
  }

  async retrieveSnapshot (dbAddress) {
    await this.databases.jobs.load()
    const jobs = await this.databases.jobs.query(d => d.dbAddress === dbAddress)

    const snapshots = await Promise.all(jobs.map(async (job) => {
      const bytes = await this._pow.ffs.get(job.cid)
      const snapshotData = JSON.parse((Buffer.from(bytes).toString()))

      const log = await Log.fromJSON(this._orbitdb._ipfs, this._orbitdb.identity, snapshotData, {
        length: -1,
        timeout: 1000
      })

      const snapshot = { job, log }

      return snapshot
    }))

    return snapshots
  }

  snapshotJob (jobId) {
    return new Promise((resolve, reject) => {
      try {
        const cancel = this._pow.ffs.watchJobs(async (job) => {
          resolve(job)
          cancel()
        }, jobId)
      } catch (e) {
        reject(e)
      }
    })
  }

  async storeSnapshot (dbAddress) {
    return new Promise((resolve, reject) => {
      this._orbitdb.open(dbAddress).then(async (db) => {
        let replicationComplete = false

        db.events.on('replicate.progress', (dbAddress, hash, entry) => {
          if (entry.next.length === 0) {
            replicationComplete = true
          }
        })

        db.events.on('replicated', async () => {
          if (replicationComplete) {
            await db.load()

            const snapshot = await db.saveSnapshot()
            const cid = snapshot[0].hash
            const { jobId } = await this._pow.ffs.pushStorageConfig(cid)
            const jobStatus = await this.snapshotJob(jobId)
            jobStatus.dbAddress = dbAddress
            await this.databases.jobs.put(jobStatus)

            this.watchJob(jobId)

            await db.drop()
            resolve(jobStatus)
          }
        })
      })
    })
  }

  watchJob (jobId) {
    const checkAndUpdate = async () => {
      try {
        const currentStatus = await this.getJobStatus(jobId)
        const newStatus = await this.snapshotJob(jobId)
        if (currentStatus[0].status !== newStatus.status) {
          newStatus.dbAddress = currentStatus[0].dbAddress
          await this.databases.jobs.put(newStatus)
        }
      } catch (e) {
        console.error(e)
      }
    }

    checkAndUpdate()
    const watch = setInterval(checkAndUpdate, 1000)
    this._jobWatchers.push(watch)
  }

  async stop () {
    for (const watcher of this._jobWatchers) {
      clearInterval(watcher)
    }

    await this._orbitdb.disconnect()
  }
}

module.exports = PowergateIO
