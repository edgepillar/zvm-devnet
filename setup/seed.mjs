// Fills a fresh devnet with something to look at and test against: names,
// trades, a pool position, NFT listings, a painted canvas, a board thread, a
// launched coin and a bridge withdrawal, each from a test account.
//
//   docker compose run --rm setup seed
//
// Each step is recorded in /deploy/seed.json when it lands, and skipped on the
// next run, so a second run sends nothing. The test accounts are go-zenon's
// devnet mnemonic at Ethereum's path (accounts.mjs), funded by setup.
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {crc32, deflateSync} from 'node:zlib'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  namehash,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
  zeroHash,
} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {runBridgeQualification} from './peg.mjs'

const NODE = 'http://node:8080'
const RPC = `${NODE}/rpc`
const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
const accounts = read('/deploy/accounts.json').accounts
const dex = read('/deploy/deployment.json')
const rollup = read('/l2/rollup.json')

const chain = defineChain({id: rollup.l2ChainId, name: 'ZVM devnet', nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [RPC]}}})
const client = createPublicClient({chain, transport: http(RPC)})
const wallet = (i) => createWalletClient({chain, transport: http(RPC), account: privateKeyToAccount(accounts[i].privateKey)})
const who = (i) => getAddress(accounts[i].address)

const STATE = '/deploy/seed.json'
const done = existsSync(STATE) ? read(STATE) : {}
async function step(name, fn) {
  if (done[name]) return console.log(`ok    ${name} (already)`)
  const note = await fn()
  done[name] = note ?? true
  writeFileSync(STATE, JSON.stringify(done, null, 2) + '\n')
  console.log(`ok    ${name}${typeof note === 'string' ? `: ${note}` : ''}`)
}

// The relayer refuses a tip under 50 gwei; zvm's own senders offer 100.
const TIP = 100_000_000_000n
async function send(i, tx) {
  const {baseFeePerGas} = await client.getBlock()
  const hash = await wallet(i).sendTransaction({...tx, maxPriorityFeePerGas: TIP, maxFeePerGas: baseFeePerGas * 2n + TIP})
  const r = await client.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 300_000})
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`)
  return r
}
const call = (i, address, abi, functionName, args, value) =>
  send(i, {to: address, data: encodeFunctionData({abi, functionName, args}), value})
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600)

// --- names ------------------------------------------------------------------------
// Three .znn names, each its owner's primary name, so pages show names. Seven
// characters or more: shorter ones carry the launch premium.
const zns = read('/deploy/zns.json').contracts
const controller = read('/apps/zvm-zns/contracts/out/ZNSController.json').abi
const resolverAbi = read('/apps/zvm-zns/contracts/out/PublicResolver.json').abi
for (const [i, label] of [[0, 'devnet-admin'], [1, 'alice-zvm'], [2, 'bob-zvm']]) {
  await step(`name ${label}.znn`, async () => {
    const reg = {
      label,
      owner: who(i),
      duration: 365n * 86_400n,
      secret: toHex(crypto.getRandomValues(new Uint8Array(32))),
      resolver: zns.PublicResolver,
      data: [encodeFunctionData({abi: resolverAbi, functionName: 'setAddr', args: [namehash(`${label}.znn`), who(i)]})],
      reverseRecord: 1,
      referrer: zeroHash,
    }
    const commitment = await client.readContract({address: zns.ZNSController, abi: controller, functionName: 'makeCommitment', args: [reg]})
    await call(i, zns.ZNSController, controller, 'commit', [commitment])
    const wait = await client.readContract({address: zns.ZNSController, abi: controller, functionName: 'minCommitmentAge'})
    await new Promise((r) => setTimeout(r, (Number(wait) + 25) * 1000))
    const price = await client.readContract({address: zns.ZNSController, abi: controller, functionName: 'rentPrice', args: [label, reg.duration]})
    const value = price.base + price.premium + (price.base + price.premium) / 100n
    await call(i, zns.ZNSController, controller, 'register', [reg], value)
    return `${label}.znn → account ${i}`
  })
}

// --- Glyphswap ----------------------------------------------------------------------
const WQSR = '0x4200000000000000000000000000000000000101'
const router = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
])
const erc20 = parseAbi(['function approve(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
for (const i of [2, 3, 4]) {
  await step(`swap ZNN for wQSR, account ${i}`, async () => {
    await call(i, dex.uniswapRouter, router, 'swapExactETHForTokens', [0n, [dex.weth, WQSR], who(i), deadline()], parseEther(String(40 + 20 * i)))
  })
}
await step('swap wQSR back for ZNN, account 3', async () => {
  const held = await client.readContract({address: WQSR, abi: erc20, functionName: 'balanceOf', args: [who(3)]})
  await call(3, WQSR, erc20, 'approve', [dex.uniswapRouter, held / 2n])
  await call(3, dex.uniswapRouter, router, 'swapExactTokensForETH', [held / 2n, 0n, [WQSR, dex.weth], who(3), deadline()])
})
await step('liquidity in ZNN/wQSR, account 4', async () => {
  const held = await client.readContract({address: WQSR, abi: erc20, functionName: 'balanceOf', args: [who(4)]})
  await call(4, WQSR, erc20, 'approve', [dex.uniswapRouter, held])
  // ZNN to match at the pool's price; the router takes what the ratio needs and returns the rest.
  await call(4, dex.uniswapRouter, router, 'addLiquidityETH', [WQSR, held, 0n, 0n, who(4), deadline()], parseEther('200'))
})

// --- the NFT market --------------------------------------------------------------------
// More listings from what the marketplace's seed minted (zvm-node apps demo).
await step('NFT listings', async () => {
  execFileSync('zvm-node', ['apps', 'demo', '-config', '/l2/rollup.json', '-l1', 'http://l1-rpc:35997', '-eth', 'http://reth:8545',
    '-submit', 'http://relayer:8547', '-api', NODE, '-apps', '/deploy/apps.json', '-count', '6', '-price', '5'], {stdio: 'inherit'})
})

// --- Mozaic ------------------------------------------------------------------------------
// A 16-pixel square in each of the three Zenon colours, near the centre.
const mozaic = read('/deploy/mozaic.json')
await step('Mozaic pixels, account 5', async () => {
  const pixels = []
  for (const [k, rgb] of [[0, 0x00d557], [1, 0x0061eb], [2, 0xf91690]]) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels.push({index: (496 + y) * 1000 + 490 + k * 6 + x, rgb})
  }
  const bytes = new Uint8Array(pixels.length * 6)
  pixels.forEach((p, n) => bytes.set([p.index >> 16, (p.index >> 8) & 0xff, p.index & 0xff, p.rgb >> 16, (p.rgb >> 8) & 0xff, p.rgb & 0xff], n * 6))
  const abi = read('/apps/zvm-mozaic/contracts/Mozaic.json').abi
  await call(5, mozaic.mozaic, abi, 'paint', [toHex(bytes)], BigInt(mozaic.priceWei) * BigInt(pixels.length))
  return `${pixels.length} pixels`
})

// --- zchan ---------------------------------------------------------------------------------
const zchan = read('/deploy/zchan.json')
const zchanAbi = read('/apps/zvm-zchan/contracts/out/ZChan.json').abi
// A thread must open with an image: a 64-pixel square in the three Zenon colours.
function png(size = 64) {
  const colours = [[0x00, 0xd5, 0x57], [0x00, 0x61, 0xeb], [0xf9, 0x16, 0x90]]
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = [0]
    for (let x = 0; x < size; x++) row.push(...colours[Math.floor((3 * x) / size)])
    rows.push(...row)
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length)
    b.writeUInt32BE(data.length, 0)
    b.write(type, 4, 'latin1')
    data.copy(b, 8)
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length)
    return b
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}
await step('zchan thread and reply, accounts 6 and 7', async () => {
  const r = await call(6, zchan.zchan, zchanAbi, 'post', [0n, 0, 'Devnet is up', 'First post on a fresh ZVM devnet.', toHex(png())])
  const [posted] = parseEventLogs({abi: zchanAbi, logs: r.logs, eventName: 'Posted'})
  await call(7, zchan.zchan, zchanAbi, 'post', [posted.args.id, 0, '', 'Reply from another test account.', '0x'])
  return `thread ${posted.args.id}`
})

// --- Spark ---------------------------------------------------------------------------------
const spark = read('/deploy/spark.json')
const sparkAbi = read('/apps/zvm-spark/contracts/out/Spark.json').abi
await step('Spark coin launched by account 7, bought by account 8', async () => {
  const launch = {
    name: 'Devnet Spark', symbol: 'DSPRK', description: 'A coin launched by the devnet seed.', website: '', twitter: '', telegram: '',
    image: '0x', holders: true, recipients: [], bps: [], minTokensOut: 0n,
  }
  const r = await call(7, spark.spark, sparkAbi, 'launch', [launch], parseEther('50'))
  const [launched] = parseEventLogs({abi: sparkAbi, logs: r.logs, eventName: 'Launched'})
  const token = launched.args.token
  await call(8, spark.spark, sparkAbi, 'buy', [token, 0n], parseEther('20'))
  return `${token}`
})

// --- completed bridge settlement and both call lanes --------------------------
await runBridgeQualification()

console.log('\nseeded: names, swaps, a pool position, NFT listings, Mozaic, zchan, Spark, the bridge both ways')
