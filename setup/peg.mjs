// Real, fixed internal endpoints for the isolated compose stack. This module
// cannot be pointed at a public network through an environment override.
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync,
  renameSync, mkdirSync, rmdirSync, lstatSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress,
  http, parseAbi, parseEventLogs} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {runQualification, verifyQualification, validateProof, uint, waitFor} from './settlement.mjs'

const RPC = 'http://node:8080/rpc', NOM = 'http://l1-rpc:35997'
const FILE = '/deploy/settlement.json', LOCK = '/deploy/.settlement-lock'
const BRIDGE = '0x4200000000000000000000000000000000000100'
const WQSR = '0x4200000000000000000000000000000000000101'
const NOM_FROM = 'z1qpeet8dcjg0m6x6m3tg437wnc42aa2nez2fzth' // dev NoM index 8
const NOM_TO = 'z1qqcam4ycu0ta8333hx38r5j2z3ry9jjfxkc7t5' // dev NoM index 9
const ZTS = {ZNN: 'zts1znnxxxxxxxxxxxxx9z4ulx', QSR: 'zts1qsrxxxxxxxxxxxxxmrhjll'}
const ZTS_HEX = {ZNN: '0x14e66318c6318c6318c6', QSR: '0x04066318c6318c6318c6'}
const SCALE = 10_000_000_000n
const TIP = 100_000_000_000n
const ZERO = `0x${'0'.repeat(64)}`
const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function feeFor(bytes10,uint256) view returns (uint256)',
  'function withdrawZNN(address) payable returns (uint256)',
  'function withdrawQSR(address,uint256) returns (uint256)',
  'function withdrawal(uint256) view returns (address,address,bytes10,uint64,uint64,bytes32,uint64)',
  'event WithdrawalInitiated(uint256 indexed id,address indexed from,address indexed to,bytes10 zts,uint256 amount)',
  'event QSRDeposited(bytes32 indexed nomBlock,address indexed to,uint256 amount)',
])
const insist = (ok, message) => { if (!ok) throw new Error(message) }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const hash = (value) => typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/.test(value) && value.replace(/^0x/, '') !== '0'.repeat(64)
const nomHash = (value) => { insist(hash(value), 'invalid retained NoM hash'); return value.replace(/^0x/, '') }
const hex = (value) => `0x${BigInt(value).toString(16)}`
const dec = (value) => {
  insist(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'invalid EVM quantity')
  return BigInt(value).toString()
}

function read(path) {
  const info = lstatSync(path)
  insist(info.isFile() && info.size > 0 && info.size <= 256 * 1024, 'expected a bounded regular devnet input')
  return JSON.parse(readFileSync(path, 'utf8'))
}
function save(record) {
  const raw = JSON.stringify(record, null, 2) + '\n'
  insist(Buffer.byteLength(raw) <= 64 * 1024, 'settlement evidence exceeds its selected size budget')
  const fd = openSync(FILE + '.next', 'wx', 0o600)
  try { writeFileSync(fd, raw); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(FILE + '.next', FILE)
  const dir = openSync('/deploy', 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}
function command(name, args) {
  const text = execFileSync(name, args, {encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']})
  return {text, outputSHA256: createHash('sha256').update(text).digest('hex'), actualExit: 0}
}
function nomBytes(value) {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  // The fixed fixture address is also checked by the Go receiver before use.
  const data = [...value.slice(value.lastIndexOf('1') + 1)].slice(0, -6)
  let acc = 0, bits = 0
  const out = []
  for (const char of data) {
    const digit = alphabet.indexOf(char)
    insist(digit >= 0, 'invalid fixed NoM recipient')
    acc = (acc << 5) | digit; bits += 5
    while (bits >= 8) out.push((acc >> (bits -= 8)) & 255)
  }
  insist(out.length === 20, 'invalid fixed NoM address width')
  return `0x${Buffer.from(out).toString('hex')}`
}

function adapter() {
  const rollup = read('/l2/rollup.json'), accounts = read('/deploy/accounts.json').accounts
  insist(rollup.l1ChainId === 69 && rollup.l2ChainId === 7340469 && accounts.length === 10, 'isolated devnet inputs required')
  const chain = defineChain({id: 7340469, name: 'isolated ZVM qualification',
    nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [RPC]}}})
  const transport = () => http(RPC, {retryCount: 0, timeout: 15_000})
  const client = createPublicClient({chain, transport: transport()})
  const who = (index) => getAddress(accounts[index].address)
  let id = 0
  async function rpc(url, method, params = []) {
    const requestId = ++id
    const response = await fetch(url, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}), signal: AbortSignal.timeout(15_000)})
    insist(response.ok, `${method}: HTTP request failed`)
    const result = await response.json()
    insist(result.jsonrpc === '2.0' && result.id === requestId && !result.error && Object.hasOwn(result, 'result'), `${method}: invalid RPC result`)
    return result.result
  }
  const evm = (method, params) => rpc(RPC, method, params)
  const nom = (method, params) => rpc(NOM, method, params)
  const observe = async (label, fn, wait) => {
    const result = wait ? await waitFor(label, fn) : await fn()
    insist(result !== null, `${label}: still pending`)
    return result
  }
  async function block(number = 'latest') {
    const value = await evm('eth_getBlockByNumber', [number, false])
    insist(value && hash(value.hash), 'canonical EVM block is unavailable')
    return {number: dec(value.number), hash: value.hash}
  }
  async function balance(token, address, at) {
    return token === 'ZNN' ? dec(await evm('eth_getBalance', [address, hex(at)])) :
      (await client.readContract({address: WQSR, abi, functionName: 'balanceOf', args: [address], blockNumber: BigInt(at)})).toString()
  }
  async function nomBalance(token, address) {
    const value = await nom('ledger.getAccountInfoByAddress', [address])
    insist(value?.address === address && value.balanceInfoMap?.[ZTS[token]], 'NoM recipient balance is unavailable')
    const amount = value.balanceInfoMap[ZTS[token]].balance
    uint(amount, 'NoM balance')
    return amount
  }
  const confirmed = (value) => value?.chainIdentifier === 69 &&
    Number.isSafeInteger(value.confirmationDetail?.momentumHeight) && value.confirmationDetail.momentumHeight > 0 &&
    Number.isSafeInteger(value.confirmationDetail?.numConfirmations) && value.confirmationDetail.numConfirmations > 0 &&
    hash(value.confirmationDetail.momentumHash)
  async function nomBlock(sourceHash, wait) {
    return observe('NoM block confirmation', async () => {
      const value = await nom('ledger.getAccountBlockByHash', [nomHash(sourceHash)])
      if (!value || !confirmed(value)) return null
      insist(nomHash(value.hash) === nomHash(sourceHash), 'NoM source identity changed')
      return value
    }, wait)
  }
  async function receipt(sourceHash, wait) {
    return observe('EVM receipt', async () => {
      const value = await evm('eth_getTransactionReceipt', [sourceHash])
      if (!value) return null
      insist(same(value.transactionHash, sourceHash) && value.status === '0x1', 'transaction reverted or receipt identity changed')
      insist(same((await block(value.blockNumber)).hash, value.blockHash), 'receipt block is no longer canonical')
      return value
    }, wait)
  }
  const recipient = (leg) => leg.kind === 'withdrawal' ? NOM_TO : who(leg.kind === 'deposit' ? 8 : 7)
  const sender = (leg) => leg.kind === 'native' || leg.kind === 'deposit' ? NOM_FROM : who(leg.token === 'QSR' ? 8 : 9)
  async function context() {
    const frontier = await nom('ledger.getFrontierMomentum')
    const genesis = await nom('ledger.getMomentumsByHeight', [1, 1])
    const evmGenesis = await block('0x0')
    insist(frontier?.chainIdentifier === 69 && dec(await evm('eth_chainId', [])) === '7340469', 'wrong running devnet chain')
    insist(genesis?.list?.length === 1 && genesis.list[0].chainIdentifier === 69 && hash(genesis.list[0].hash), 'NoM genesis identity is unavailable')
    insist(same(evmGenesis.hash, rollup.l2GenesisHash), 'EVM genesis differs from the setup record')
    return {l1ChainId: 69, l2ChainId: 7340469, nomGenesisHash: nomHash(genesis.list[0].hash),
      evmGenesisHash: evmGenesis.hash.toLowerCase(), vault: rollup.vault, inbox: rollup.inbox}
  }
  async function before(leg) {
    const at = await block()
    const out = {blockNumber: at.number, blockHash: at.hash, recipient: recipient(leg), sender: sender(leg)}
    out.recipientBalance = leg.kind === 'withdrawal' ? await nomBalance(leg.token, out.recipient) : await balance(leg.token, out.recipient, at.number)
    if (leg.kind === 'withdrawal' || leg.kind === 'relayed') out.senderBalance = await balance(leg.token, out.sender, at.number)
    if (leg.kind === 'deposit') out.nomSenderBalance = await nomBalance(leg.token, NOM_FROM)
    if (leg.kind === 'withdrawal') {
      insist(rollup.bridgeFee?.bps === 25 && rollup.bridgeFee.minZnn === 0 && rollup.bridgeFee.minQsr === 0, 'unexpected isolated withdrawal fee recipe')
      out.fee = (await client.readContract({address: BRIDGE, abi, functionName: 'feeFor',
        args: [ZTS_HEX[leg.token], BigInt(leg.gross)], blockNumber: BigInt(at.number)})).toString()
      insist(BigInt(out.fee) === BigInt(leg.gross) * 25n / 10_000n, 'withdrawal fee differs from the genesis recipe')
    }
    return out
  }
  async function submit(leg, initial) {
    if (leg.kind === 'deposit' || leg.kind === 'native') {
      const args = [leg.kind === 'deposit' ? 'deposit' : 'call', '-config', '/l2/rollup.json', '-l1', NOM,
        '-eth', 'http://reth:8545', '-index', '8', '-wait', '0', '-to', initial.recipient]
      if (leg.kind === 'deposit') args.push('-token', leg.token, '-amount', (BigInt(leg.gross) / 100_000_000n).toString())
      else args.push('-value', '0', '-data', '0x', '-gas', '21000', '-fee-token', 'ZNN')
      const result = command('zvm', args)
      const match = result.text.match(/^NoM block\s+([0-9a-f]{64})\b/m)
      insist(match, 'CLI source publication identity is unknown')
      const l2 = result.text.match(/^L2 tx\s+(0x[0-9a-f]{64})\b/m)?.[1]
      insist(leg.token === 'QSR' || l2, 'CLI derived transaction identity is unknown')
      return {sourceHash: match[1], ...(l2 ? {l2Hash: l2} : {}), outputSHA256: result.outputSHA256, actualExit: result.actualExit}
    }
    const index = leg.token === 'QSR' ? 8 : 9
    const wallet = createWalletClient({chain, transport: transport(), account: privateKeyToAccount(accounts[index].privateKey)})
    const latest = await client.getBlock()
    const tx = leg.kind === 'relayed' ? {to: initial.recipient, value: BigInt(leg.gross)} : {
      to: BRIDGE, data: encodeFunctionData({abi, functionName: leg.token === 'ZNN' ? 'withdrawZNN' : 'withdrawQSR',
        args: leg.token === 'ZNN' ? [nomBytes(NOM_TO)] : [nomBytes(NOM_TO), BigInt(leg.gross)]}),
      ...(leg.token === 'ZNN' ? {value: BigInt(leg.gross) * SCALE} : {}),
    }
    return {sourceHash: await wallet.sendTransaction({...tx, maxPriorityFeePerGas: TIP, maxFeePerGas: latest.baseFeePerGas * 2n + TIP})}
  }
  async function makeProof(leg, entry, wait, checkpoint) {
    const initial = entry.before, source = entry.submitted
    insist(initial.recipient === recipient(leg) && initial.sender === sender(leg), 'retained sender or recipient changed')
    insist(same((await block(hex(initial.blockNumber))).hash, initial.blockHash), 'initial balance block changed')
    let r, paidIn, receiveHash, withdrawalId, nomSend
    if (leg.kind === 'deposit' || leg.kind === 'native') {
      nomSend = await nomBlock(source.sourceHash, wait)
      insist(nomSend.blockType === 2 && nomSend.address === NOM_FROM && nomSend.toAddress === (leg.kind === 'deposit' ? rollup.vault : rollup.inbox), 'NoM source route differs')
      if (leg.kind === 'deposit') insist(nomSend.tokenStandard === ZTS[leg.token] && nomSend.amount === leg.gross, 'NoM deposit token or amount differs')
      if (leg.kind === 'deposit' && leg.token === 'QSR') {
        const log = await observe('exact QSR deposit event', async () => {
          const logs = await evm('eth_getLogs', [{address: BRIDGE, fromBlock: hex(initial.blockNumber), toBlock: 'latest'}])
          insist(Array.isArray(logs) && logs.length <= 256, 'unexpected isolated deposit log inventory')
          const matched = parseEventLogs({abi, eventName: 'QSRDeposited', logs, strict: true})
            .filter((row) => same(row.args.nomBlock, `0x${source.sourceHash}`))
          insist(matched.length <= 1, 'duplicate QSR deposit observation')
          if (!matched.length) return null
          insist(same(matched[0].args.to, initial.recipient) && matched[0].args.amount.toString() === leg.gross, 'QSR deposit event recipient or amount differs')
          return matched[0]
        }, wait)
        r = await receipt(log.transactionHash, wait)
      } else r = await receipt(source.l2Hash, wait)
    } else r = await receipt(source.sourceHash, wait)
    const transaction = await evm('eth_getTransactionByHash', [r.transactionHash])
    insist(transaction && same(transaction.blockHash, r.blockHash), 'source transaction is unavailable in its receipt block')
    if (leg.kind === 'withdrawal') {
      insist(same(transaction.from, initial.sender) && same(transaction.to, BRIDGE), 'withdrawal transaction route differs')
      const events = parseEventLogs({abi, eventName: 'WithdrawalInitiated', logs: r.logs.filter((row) => same(row.address, BRIDGE)), strict: true})
      insist(events.length === 1, 'one exact withdrawal event is required')
      const event = events[0].args
      withdrawalId = event.id.toString()
      insist(same(event.from, initial.sender) && same(event.to, nomBytes(NOM_TO)) && same(event.zts, ZTS_HEX[leg.token]) &&
        event.amount === BigInt(leg.gross) - BigInt(initial.fee), 'withdrawal event accounting differs')
      const row = await observe('derived payout confirmation', async () => {
        const value = await client.readContract({address: BRIDGE, abi, functionName: 'withdrawal', args: [event.id]})
        insist(same(value[0], initial.sender) && same(value[1], nomBytes(NOM_TO)) && same(value[2], ZTS_HEX[leg.token]) &&
          value[3].toString() === event.amount.toString() && value[4].toString() === dec(r.blockNumber) && value[6].toString() === initial.fee, 'withdrawal record differs from the source event')
        return same(value[5], ZERO) ? null : value
      }, wait)
      paidIn = row[5]
      nomSend = await nomBlock(paidIn, wait)
      insist(nomSend.blockType === 2 && nomSend.address === rollup.vault && nomSend.toAddress === NOM_TO &&
        nomSend.tokenStandard === ZTS[leg.token] && nomSend.amount === event.amount.toString(), 'NoM payout route or amount differs')
      insist(Buffer.from(nomSend.data, 'base64').toString('hex') === '5a564d57' + BigInt(withdrawalId).toString(16).padStart(64, '0'), 'NoM payout does not bind the exact withdrawal identifier')
      if (!entry.receiveHash && wait) {
        const received = command('zvm-devnet-receive', ['-hash', nomHash(paidIn), '-token', leg.token, '-amount', event.amount.toString()])
        const result = JSON.parse(received.text)
        insist(hash(result.hash), 'recipient receive identity is unknown')
        entry.receiveHash = nomHash(result.hash)
        await checkpoint()
      }
      receiveHash = entry.receiveHash
      const received = await nomBlock(receiveHash, wait)
      insist(received.blockType === 3 && received.address === NOM_TO && nomHash(received.fromBlockHash) === nomHash(paidIn), 'recipient receive does not match the exact payout')
      insist(BigInt((await block('finalized')).number) >= BigInt(dec(r.blockNumber)), 'withdrawal source is not finalized')
    } else if (leg.kind === 'native') {
      insist(same(transaction.from, nomBytes(NOM_FROM)) && same(transaction.to, initial.recipient) && dec(transaction.value) === '0' && transaction.input === '0x', 'native call differs from the selected transfer')
    } else if (leg.kind === 'relayed') {
      insist(same(transaction.from, initial.sender) && same(transaction.to, initial.recipient) && dec(transaction.value) === leg.gross, 'relayed transfer route or value differs')
    }
    const after = leg.kind === 'withdrawal' ? await nomBalance(leg.token, NOM_TO) : await balance(leg.token, initial.recipient, dec(r.blockNumber))
    if (leg.kind === 'withdrawal' || leg.kind === 'relayed') {
      const senderAfter = BigInt(await balance(leg.token, initial.sender, dec(r.blockNumber)))
      const spent = BigInt(leg.gross) * (leg.kind === 'withdrawal' && leg.token === 'ZNN' ? SCALE : 1n)
      const gas = leg.token === 'ZNN' ? BigInt(dec(r.gasUsed)) * BigInt(dec(r.effectiveGasPrice)) +
        (r.l1Fee === undefined ? 0n : BigInt(dec(r.l1Fee))) : 0n
      insist(BigInt(initial.senderBalance) - senderAfter === spent + gas, 'source debit differs from value plus the measured transaction fee')
    }
    const fee = leg.kind === 'withdrawal' ? initial.fee : '0'
    return validateProof(leg, {sourceHash: source.sourceHash, sourceConfirmed: true,
      recipientHash: receiveHash ?? r.blockHash, recipientConfirmed: true, recipient: initial.recipient,
      gross: leg.gross, fee, net: (BigInt(leg.gross) - BigInt(fee)).toString(),
      recipientBefore: initial.recipientBalance, recipientAfter: after,
      sourceBlockHash: r.blockHash, sourceBlockNumber: dec(r.blockNumber), l2TransactionHash: r.transactionHash,
      ...(paidIn ? {paidIn, receiveHash, withdrawalId} : {}),
      ...(nomSend ? {nomSourceHash: nomSend.hash, nomMomentumHash: nomSend.confirmationDetail.momentumHash} : {})})
  }
  async function fingerprint() {
    const nonces = []
    for (const account of accounts) nonces.push(dec(await evm('eth_getTransactionCount', [account.address, 'pending'])))
    const nomFrontiers = []
    for (const address of [NOM_FROM, NOM_TO]) {
      const value = await nom('ledger.getFrontierAccountBlock', [address])
      insist(value && hash(value.hash) && Number.isSafeInteger(value.height), 'selected NoM frontier is unavailable')
      nomFrontiers.push({hash: value.hash, height: value.height})
    }
    const files = {}
    for (const path of ['/deploy/seed.json', FILE]) {
      read(path) // Bound the retained file before hashing it.
      files[path.split('/').at(-1)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
    return {context: await context(), selectedAccountNonces: nonces, selectedNoMFrontiers: nomFrontiers, files}
  }
  return {context, before, submit, fingerprint, settle: (leg, entry, checkpoint) => makeProof(leg, entry, true, checkpoint),
    verify: async (leg, entry) => {
      const actual = await makeProof(leg, entry, false, null)
      insist(JSON.stringify(actual) === JSON.stringify(entry.proof), 'retained settlement observations changed')
    }}
}

export async function runBridgeQualification() {
  mkdirSync(LOCK, {mode: 0o700})
  const owned = lstatSync(LOCK)
  try {
    const existing = existsSync(FILE) ? read(FILE) : null
    if (!existing && existsSync('/deploy/seed.json')) {
      const legacy = read('/deploy/seed.json')
      insist(!Object.keys(legacy).some((key) => key.startsWith('bridge withdrawal,') || key.startsWith('bridge deposit,')), 'legacy bridge seed operations require a fresh isolated stack; they will not be submitted again')
    }
    const result = await runQualification({existing, save, adapter: adapter()})
    console.log('ok    completed seed settlement: four peg legs and native/relayed call lanes')
    return result
  } finally {
    const current = lstatSync(LOCK)
    insist(current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino, 'settlement lock identity changed')
    rmdirSync(LOCK)
  }
}

export async function verifyBridgeQualification() {
  insist(existsSync(FILE), 'complete seed settlement evidence is required')
  return verifyQualification(read(FILE), adapter())
}

export async function seedState() {
  return adapter().fingerprint()
}
