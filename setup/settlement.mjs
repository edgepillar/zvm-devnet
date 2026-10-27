// Control flow and exact accounting for this throwaway devnet qualification.
// RPC observations are supplied and re-read by peg.mjs; they are not signatures
// or independently authenticated NoM state proofs.
export const legs = Object.freeze([
  {key: 'deposit-znn', kind: 'deposit', token: 'ZNN', gross: '5000000000'},
  {key: 'deposit-qsr', kind: 'deposit', token: 'QSR', gross: '100000000000'},
  {key: 'withdraw-znn', kind: 'withdrawal', token: 'ZNN', gross: '2500000000'},
  {key: 'withdraw-qsr', kind: 'withdrawal', token: 'QSR', gross: '12500000000'},
  {key: 'native-call', kind: 'native', token: 'ZNN', gross: '0'},
  {key: 'relayed-call', kind: 'relayed', token: 'ZNN', gross: '1000000000000000'},
].map(Object.freeze))

const contextKeys = ['l1ChainId', 'l2ChainId', 'nomGenesisHash', 'evmGenesisHash', 'vault', 'inbox']
const hash = /^(?:0x)?[0-9a-f]{64}$/
const nonzeroHash = (value) => typeof value === 'string' && hash.test(value) && /[1-9a-f]/.test(value.replace(/^0x/, ''))
const insist = (ok, message) => { if (!ok) throw new Error(message) }

export function uint(value, label = 'amount') {
  insist(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78, `${label}: expected an exact unsigned integer string`)
  const result = BigInt(value)
  insist(result < 2n ** 256n, `${label}: integer exceeds uint256`)
  return result
}

export function validateContext(context) {
  insist(context && typeof context === 'object' && !Array.isArray(context), 'missing isolated chain context')
  insist(Object.keys(context).sort().join(',') === [...contextKeys].sort().join(','), 'unexpected isolated chain context fields')
  insist(context.l1ChainId === 69 && context.l2ChainId === 7340469, 'qualification requires the isolated devnet chain identifiers')
  insist(nonzeroHash(context.nomGenesisHash) && nonzeroHash(context.evmGenesisHash), 'missing isolated genesis identities')
  for (const key of ['vault', 'inbox']) insist(typeof context[key] === 'string' && /^z1[0-9a-z]{38}$/.test(context[key]), `invalid ${key} identity`)
  return context
}

function contextEqual(a, b) {
  validateContext(a)
  validateContext(b)
  return contextKeys.every((key) => a[key] === b[key])
}

export function validateProof(leg, proof) {
  insist(proof && typeof proof === 'object' && !Array.isArray(proof), `${leg.key}: missing proof`)
  insist(proof.sourceConfirmed === true && nonzeroHash(proof.sourceHash), `${leg.key}: source is not confirmed`)
  insist(proof.recipientConfirmed === true && nonzeroHash(proof.recipientHash), `${leg.key}: recipient observation is not confirmed`)
  insist(typeof proof.recipient === 'string' && proof.recipient.length > 0, `${leg.key}: missing recipient`)
  const gross = uint(proof.gross, 'gross')
  const fee = uint(proof.fee, 'fee')
  const net = uint(proof.net, 'net')
  const before = uint(proof.recipientBefore, 'recipient before')
  const after = uint(proof.recipientAfter, 'recipient after')
  insist(proof.gross === leg.gross, `${leg.key}: gross amount differs from the selected case`)
  const scale = leg.kind === 'deposit' && leg.token === 'ZNN' ? 10_000_000_000n : 1n
  if (leg.kind === 'withdrawal') {
    insist(fee < gross && net === gross - fee, `${leg.key}: invalid net withdrawal accounting`)
    insist(nonzeroHash(proof.paidIn) && nonzeroHash(proof.receiveHash), `${leg.key}: payout and recipient receive must both exist`)
  } else {
    insist(fee === 0n && net === gross, `${leg.key}: unexpected recipient deduction`)
  }
  insist(after >= before && after - before === net * scale, `${leg.key}: recipient delta differs from the exact selected amount`)
  return proof
}

export async function waitFor(label, observe, {timeoutMs = 300_000, pollMs = 2_000,
  now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))} = {}) {
  insist(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000 && Number.isFinite(pollMs) && pollMs > 0, 'invalid qualification wait budget')
  const until = now() + timeoutMs
  for (;;) {
    const observed = await observe()
    insist(observed !== undefined, `${label}: observation is unknown`)
    if (now() > until) throw new Error(`${label}: incomplete before the qualification deadline`)
    if (observed !== null) return observed
    if (now() >= until) throw new Error(`${label}: incomplete before the qualification deadline`)
    await sleep(Math.min(pollMs, Math.max(0, until - now())))
  }
}

function validateEntry(leg, entry) {
  insist(entry && entry.key === leg.key && entry.state === 'complete', `${leg.key}: incomplete retained operation; preserve its identity and use a fresh isolated stack`)
  validateProof(leg, entry.proof)
  insist(entry.submitted && entry.submitted.sourceHash === entry.proof.sourceHash, `${leg.key}: source identity changed`)
}

export async function verifyQualification(record, adapter) {
  insist(record && record.schema === 1 && record.kind === 'zvm-devnet-settlement' && record.state === 'complete', 'complete seed settlement evidence is required')
  insist(contextEqual(record.context, await adapter.context()), 'retained settlement belongs to another isolated chain context')
  insist(Array.isArray(record.legs) && record.legs.length === legs.length, 'all four peg legs and both call lanes are required')
  for (let i = 0; i < legs.length; i++) {
    validateEntry(legs[i], record.legs[i])
    await adapter.verify(legs[i], record.legs[i])
  }
  return record
}

export async function runQualification({existing = null, save, adapter}) {
  // An unfinished attempt may already have sent a transaction. It must never
  // be silently re-signed, replaced, re-submitted or treated as a fresh run.
  if (existing !== null) return verifyQualification(existing, adapter)
  const context = validateContext(await adapter.context())
  const record = {schema: 1, kind: 'zvm-devnet-settlement', context, state: 'running', legs: []}
  await save(record)
  for (const leg of legs) {
    const before = await adapter.before(leg)
    const entry = {key: leg.key, state: 'prepared', before}
    record.legs.push(entry)
    await save(record) // Intent is retained before the first possible send.
    entry.submitted = await adapter.submit(leg, before)
    insist(nonzeroHash(entry.submitted?.sourceHash), `${leg.key}: submission identity is unknown`)
    entry.state = 'submitted'
    await save(record)
    entry.proof = validateProof(leg, await adapter.settle(leg, entry, () => save(record)))
    insist(entry.proof.sourceHash === entry.submitted.sourceHash, `${leg.key}: settlement changed the source identity`)
    entry.state = 'complete'
    await adapter.verify(leg, entry)
    await save(record)
  }
  record.state = 'complete'
  await save(record)
  return verifyQualification(record, adapter)
}
