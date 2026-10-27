import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'
import * as path from 'node:path'
import {createHash} from 'node:crypto'

const root = new URL('./', import.meta.url)
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const accounts = Array.from({length: 10}, (_, index) => ({index, address: address(index + 1), privateKey: 'synthetic'}))
const deployment = {weth: address(20), uniswapFactory: address(21), uniswapRouter: address(22)}
const zns = {ENSRegistry: address(23)}

// Execute the real check entry point with an isolated module graph. All RPC,
// filesystem, wallet and timer capabilities are synthetic; a missing import or
// unexpected side effect is a fixture failure, never a successful refusal.
async function runCheck({seed = true, required = false, paid = '0', pending = '1', qsr = 1n} = {}) {
  const records = {
    '/l2/rollup.json': {l1ChainId: 69, l2ChainId: 7340469, vault: 'synthetic-vault'},
    '/deploy/accounts.json': {accounts}, '/deploy/deployment.json': deployment,
    '/deploy/apps.json': {exchange: address(24), farm: address(25), collectionFactory: address(26)},
    '/deploy/mozaic.json': {mozaic: address(27)}, '/deploy/zchan.json': {zchan: address(28)},
    '/deploy/zns.json': {contracts: zns}, '/deploy/spark.json': {spark: address(29)},
    '/deploy/seed.json': {'Spark coin launched by account 7, bought by account 8': address(30)},
  }
  if (!seed) delete records['/deploy/seed.json']
  const logs = []
  let exitCode, height = 1
  const forbidden = () => { throw new Error('unexpected side effect in read-only fixture') }
  const context = createContext({
    console: {log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' '))},
    process: {env: {}, argv: ['node', '/apps/check.mjs', ...(required ? ['--require-seed'] : [])], exit: (code) => { exitCode = code }},
    URL, Buffer, TextEncoder, TextDecoder, AbortSignal: {timeout: () => undefined},
    setTimeout: (callback, delay) => { if (delay <= 11_000) queueMicrotask(callback); return 0 }, clearTimeout: () => {},
    WebSocket: class {
      constructor() { queueMicrotask(() => this.onopen?.()) }
      send() { queueMicrotask(() => this.onmessage?.({data: JSON.stringify({result: {height: 3}})})) }
      close() {}
    },
    fetch: async (url, options = {}) => {
      const route = String(url)
      let result = {}
      if (options.method === 'POST') {
        const {method} = JSON.parse(options.body)
        if (method === 'ledger.getFrontierMomentum') result = {chainIdentifier: 69, height: height++}
        else if (method === 'eth_chainId') result = '0x7001b5'
        else if (method === 'eth_blockNumber') result = '0x1'
        else throw new Error('unexpected fixture RPC: ' + method)
        return {status: 200, json: async () => ({result})}
      }
      if (route.endsWith('/zvm/api/info')) result = {derivation: {stalled: false, lag: 0, momentum: 1}, uniswapV2: {router: deployment.uniswapRouter}}
      else if (route.endsWith('/zvm/healthz')) result = {ok: true}
      else if (route === 'http://bridge:8548/status') result = {paidZNN: paid, pendingZNN: pending}
      return {status: 200, json: async () => result, text: async () => '<script src="/fixture.js"></script>'}
    },
  })
  const client = {
    getBlock: async () => ({number: 1n, hash: `0x${'1'.repeat(64)}`, baseFeePerGas: 1n}),
    getCode: async () => '0x60',
    readContract: async ({address: target, functionName, args}) => {
      if (functionName === 'balanceOf') return qsr
      if (functionName === 'posts') return 2n
      if (functionName === 'owner' && target === zns.ENSRegistry) {
        const labels = ['devnet-admin.znn', 'alice-zvm.znn', 'bob-zvm.znn']
        const index = labels.indexOf(args[0])
        if (index >= 0) return accounts[index].address
      }
      return accounts[0].address
    },
    waitForTransactionReceipt: async () => ({status: 'success', blockNumber: 1n}),
  }
  const viem = {
    createPublicClient: () => client,
    createWalletClient: () => ({sendTransaction: async () => `0x${'2'.repeat(64)}`}),
    defineChain: (value) => value, getAddress: (value) => value.toLowerCase(), http: () => ({}),
    namehash: (value) => value, parseAbi: (value) => value,
    parseEther: (value) => BigInt(value.replace('.', '')) * 10n ** BigInt(18 - (value.split('.')[1]?.length ?? 0)),
    encodeFunctionData: forbidden, parseEventLogs: forbidden, toHex: forbidden,
    zeroHash: `0x${'0'.repeat(64)}`,
  }
  const fs = {
    existsSync: (name) => Object.hasOwn(records, String(name)),
    readFileSync: (name) => {
      if (!Object.hasOwn(records, String(name))) throw new Error('missing synthetic input')
      return JSON.stringify(records[String(name)])
    },
    writeFileSync: forbidden, renameSync: forbidden, mkdirSync: forbidden, rmdirSync: forbidden,
    openSync: forbidden, closeSync: forbidden, writeSync: forbidden, fsyncSync: forbidden, lstatSync: forbidden,
  }
  const builtins = new Map([
    ['node:fs', fs], ['node:path', path], ['node:crypto', {createHash}],
    ['node:child_process', {execFileSync: forbidden}], ['viem', viem],
    ['viem/accounts', {privateKeyToAccount: () => ({address: accounts[9].address})}],
  ])
  const modules = new Map()
  async function moduleFor(specifier, parent = root.href) {
    const key = builtins.has(specifier) ? specifier : new URL(specifier, parent).href
    if (modules.has(key)) return modules.get(key)
    let module
    if (builtins.has(key)) {
      const exports = builtins.get(key)
      module = new SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
      }, {context, identifier: key})
    } else {
      assert.ok(key.startsWith(root.href), 'fixture module escaped its source directory')
      module = new SourceTextModule(readFileSync(new URL(key), 'utf8'), {context, identifier: key})
    }
    modules.set(key, module)
    return module
  }
  const program = await moduleFor('./check.mjs')
  await program.link((specifier, parent) => moduleFor(specifier, parent.identifier))
  await program.evaluate({timeout: 5000})
  assert.equal(typeof exitCode, 'number', 'actual check entry point did not finish')
  assert.ok(logs.some((line) => line.includes('a transaction lands') && line.startsWith('ok')), 'unrelated round-trip fixture did not pass')
  return {exitCode, logs}
}

test('seeded checks refuse a pending-only bridge observation', async () => {
  const result = await runCheck()
  assert.equal(result.exitCode, 1, 'pending-only bridge evidence incorrectly passed the actual checker')
})

test('seeded checks refuse unrelated aggregate paid totals', async () => {
  const result = await runCheck({paid: '999', pending: '0'})
  assert.equal(result.exitCode, 1, 'aggregate paid totals supplied no exact seed settlement')
})

test('seeded checks refuse a positive but unproved QSR balance', async () => {
  const result = await runCheck({paid: '999', pending: '0', qsr: 1n})
  assert.equal(result.exitCode, 1, 'positive QSR balance supplied no exact seed deposit proof')
})

test('required seed checks refuse an absent seed record', async () => {
  const result = await runCheck({seed: false, required: true})
  assert.equal(result.exitCode, 1, 'required seeded verification silently ran only the unseeded checks')
})

test('ordinary unseeded sanity checks retain their existing meaning', async () => {
  const result = await runCheck({seed: false})
  assert.equal(result.exitCode, 0)
})
