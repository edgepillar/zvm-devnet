// Checks that every part of the devnet answers, and that a transaction makes
// the whole round trip. Run at the end of setup, and on demand:
//
//   docker compose run --rm setup check
//
// Everything public is checked through the gateway, by the paths a wallet or
// page uses; the relayer, bridge, faucet and verifier, which have no public
// path, by name. Prints one line per check and exits 1 if any failed.
import {existsSync, readFileSync} from 'node:fs'
import {createPublicClient, createWalletClient, defineChain, getAddress, http, namehash, parseAbi, parseEther} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {verifyBridgeQualification} from './peg.mjs'

const GW = 'http://gateway'
const read = (f) => JSON.parse(readFileSync(`/deploy/${f}`, 'utf8'))
// The chain is the one this devnet's genesis wrote, not a number written here.
const rollup = JSON.parse(readFileSync('/l2/rollup.json', 'utf8'))
const L1 = rollup.l1ChainId
const L2 = rollup.l2ChainId
const accounts = read('accounts.json').accounts
const admin = getAddress(process.env.DEVNET_ADMIN || accounts[0].address)

let failed = 0
async function check(name, fn) {
  const t = Date.now()
  try {
    const note = await fn()
    console.log(`ok    ${name}${note ? `: ${note}` : ''} (${Date.now() - t} ms)`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}: ${e?.shortMessage ?? e?.message ?? e}`)
  }
}
async function get(url, want = 200) {
  const r = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(15_000)})
  if (r.status !== want) throw new Error(`${url} answered ${r.status}`)
  return r
}
async function rpc(url, method, params = []) {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(15_000)})
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function assert(ok, msg) {
  if (!ok) throw new Error(msg)
}

// --- the chains -----------------------------------------------------------------
await check('NoM over HTTP (/zenon)', async () => {
  const a = await rpc(`${GW}/zenon`, 'ledger.getFrontierMomentum')
  assert(a.chainIdentifier === L1, `chain ${a.chainIdentifier}, not ${L1}`)
  // Up to three slots: a host whose clock steps (Docker Desktop) loses one
  // momentum slot now and then, and one missed slot is not a stalled chain.
  let b = a
  for (let n = 0; n < 3 && b.height <= a.height; n++) {
    await sleep(11_000)
    b = await rpc(`${GW}/zenon`, 'ledger.getFrontierMomentum')
  }
  assert(b.height > a.height, `stuck at momentum ${a.height}`)
  return `momentum ${b.height}`
})
await check('NoM over WebSocket (/zenon)', () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${GW.replace('http', 'ws')}/zenon`)
  const timer = setTimeout(() => (ws.close(), reject(new Error('no answer in 15 s'))), 15_000)
  ws.onopen = () => ws.send(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ledger.getFrontierMomentum', params: []}))
  ws.onmessage = (m) => (clearTimeout(timer), ws.close(), resolve(`momentum ${JSON.parse(m.data).result.height}`))
  ws.onerror = () => (clearTimeout(timer), reject(new Error('could not connect')))
}))
await check('ZVM JSON-RPC (/zvm/rpc)', async () => {
  const id = Number(await rpc(`${GW}/zvm/rpc`, 'eth_chainId'))
  assert(id === L2, `chain ${id}, not ${L2}`)
  return `block ${Number(await rpc(`${GW}/zvm/rpc`, 'eth_blockNumber'))}`
})
await check('derivation (/zvm/api/info)', async () => {
  const i = await (await get(`${GW}/zvm/api/info`)).json()
  assert(!i.derivation.stalled, 'stalled')
  assert(i.derivation.lag <= 5, `${i.derivation.lag} momentums behind`)
  return `momentum ${i.derivation.momentum}, lag ${i.derivation.lag}`
})
await check('node health (/zvm/healthz)', async () => {
  const h = await (await get(`${GW}/zvm/healthz`)).json()
  assert(h.ok, JSON.stringify(h))
})

// --- the services ---------------------------------------------------------------
await check('relayer', async () => void (await get('http://relayer:8547/status')))
await check('bridge', async () => void (await get('http://bridge:8548/status')))
await check('faucet (/zvm/api/faucet)', async () => void (await get(`${GW}/zvm/api/faucet`)))
await check('verifier', async () => void (await get('http://verifier:8600/status')))
await check('status prober (/status/api/summary)', async () => void (await get(`${GW}/status/api/summary`)))
await check('marketplace API (/zvm/api/nft/exchange)', async () => void (await get(`${GW}/zvm/api/nft/exchange`)))
await check('media API (/zvm/api/media/challenge)', async () => void (await get(`${GW}/zvm/api/media/challenge?address=${admin}`)))
await check('swap on /zvm/api/info (uniswapV2)', async () => {
  const i = await (await get(`${GW}/zvm/api/info`)).json()
  assert(i.uniswapV2?.router?.toLowerCase() === read('deployment.json').uniswapRouter.toLowerCase(), 'no router, or another deployment')
})

// --- the pages ------------------------------------------------------------------
// Each page's shell, and the first script it loads, which proves the build
// and the gateway's routing for that prefix.
for (const p of ['explorer', 'glyphswap', 'karum', 'nft', 'mozaic', 'zchan', 'zns', 'spark', 'status']) {
  await check(`page /${p}/`, async () => {
    const html = await (await get(`${GW}/${p}/`)).text()
    const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
    assert(src, 'no script in the page')
    await get(new URL(src, `${GW}/${p}/`).href)
  })
}

// --- the contracts and who runs them --------------------------------------------
const chain = defineChain({id: L2, name: 'ZVM devnet', nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [`${GW}/zvm/rpc`]}}})
const client = createPublicClient({chain, transport: http()})
const dex = read('deployment.json')
const apps = read('apps.json')
const contracts = {
  WZNN: dex.weth, 'Uniswap V2 factory': dex.uniswapFactory, 'Uniswap V2 router': dex.uniswapRouter,
  marketplace: apps.exchange, farm: apps.farm, 'collection factory': apps.collectionFactory,
  Mozaic: read('mozaic.json').mozaic, zchan: read('zchan.json').zchan,
  'ZNS registry': read('zns.json').contracts.ENSRegistry, Spark: read('spark.json').spark,
}
await check('contracts have code', async () => {
  const empty = []
  for (const [name, address] of Object.entries(contracts)) {
    if (((await client.getCode({address})) ?? '0x') === '0x') empty.push(name)
  }
  assert(!empty.length, `no code: ${empty.join(', ')}`)
  return `${Object.keys(contracts).length} contracts`
})
const role = (address, fn) => client.readContract({address, abi: parseAbi([`function ${fn}() view returns (address)`]), functionName: fn})
await check(`admin ${admin}`, async () => {
  const roles = {
    'Uniswap feeToSetter': await role(dex.uniswapFactory, 'feeToSetter'),
    'marketplace owner': await role(apps.exchange, 'owner'),
    'farm owner': await role(apps.farm, 'owner'),
    'Mozaic owner': await role(contracts.Mozaic, 'owner'),
    'zchan owner': await role(contracts.zchan, 'owner'),
    'ZNS root owner': await client.readContract({address: contracts['ZNS registry'], abi: parseAbi(['function owner(bytes32) view returns (address)']), functionName: 'owner', args: ['0x0000000000000000000000000000000000000000000000000000000000000000']}),
    'Spark owner': await role(contracts.Spark, 'owner'),
  }
  const wrong = Object.entries(roles).filter(([, a]) => getAddress(a) !== admin)
  assert(!wrong.length, wrong.map(([n, a]) => `${n} is ${a}`).join('; '))
  return `${Object.keys(roles).length} roles`
})

// --- the round trip -------------------------------------------------------------
// A transfer from the last test account to itself, sent where a wallet sends
// it: through the node's RPC to the relayer, onto NoM, and derived back.
await check('a transaction lands (relayer → NoM → derivation)', async () => {
  const last = accounts.at(-1)
  const wallet = createWalletClient({chain, transport: http(), account: privateKeyToAccount(last.privateKey)})
  const {baseFeePerGas} = await client.getBlock()
  const tip = 100_000_000_000n
  const t = Date.now()
  const hash = await wallet.sendTransaction({to: last.address, value: parseEther('0.001'), maxPriorityFeePerGas: tip, maxFeePerGas: baseFeePerGas * 2n + tip})
  const r = await client.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 120_000})
  assert(r.status === 'success', `reverted: ${hash}`)
  return `block ${r.blockNumber} after ${Math.round((Date.now() - t) / 1000)} s`
})

// --- the test data -----------------------------------------------------------------
// Only after `setup seed`: each thing it made, read back from the chain rather
// than taken from its own record.
if (process.argv.includes('--require-seed') && !existsSync('/deploy/seed.json')) {
  await check('seed: required record', async () => { throw new Error('the required seed record is unavailable') })
}
if (existsSync('/deploy/seed.json')) {
  const seed = read('seed.json')
  const zns = read('zns.json').contracts
  const owner = parseAbi(['function owner(bytes32) view returns (address)'])
  await check('seed: .znn names', async () => {
    for (const [i, label] of [[0, 'devnet-admin'], [1, 'alice-zvm'], [2, 'bob-zvm']]) {
      const o = await client.readContract({address: zns.ENSRegistry, abi: owner, functionName: 'owner', args: [namehash(`${label}.znn`)]})
      assert(getAddress(o) === getAddress(accounts[i].address), `${label}.znn is owned by ${o}`)
    }
  })
  const balance = parseAbi(['function balanceOf(address) view returns (uint256)'])
  const WQSR = '0x4200000000000000000000000000000000000101'
  await check('seed: wQSR from swaps and the deposit', async () => {
    for (const i of [2, 8]) {
      const b = await client.readContract({address: WQSR, abi: balance, functionName: 'balanceOf', args: [accounts[i].address]})
      assert(b > 0n, `account ${i} holds no wQSR`)
    }
  })
  await check('seed: zchan thread', async () => {
    const posts = await client.readContract({address: read('zchan.json').zchan, abi: parseAbi(['function posts() view returns (uint64)']), functionName: 'posts'})
    assert(posts >= 2n, `${posts} posts`)
  })
  await check('seed: Spark coin', async () => {
    const token = seed['Spark coin launched by account 7, bought by account 8']
    const b = await client.readContract({address: token, abi: balance, functionName: 'balanceOf', args: [accounts[8].address]})
    assert(b > 0n, 'account 8 holds none of the coin')
  })
  await check('seed: completed bridge settlement', async () => {
    await verifyBridgeQualification()
    return 'four peg legs and native/relayed call lanes'
  })
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
