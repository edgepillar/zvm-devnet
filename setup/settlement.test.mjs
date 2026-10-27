import test from 'node:test'
import assert from 'node:assert/strict'
import {legs, uint, validateContext, validateProof, waitFor, runQualification, verifyQualification} from './settlement.mjs'

const digest = (n) => n.toString(16).padStart(64, '0')
const context = {l1ChainId: 69, l2ChainId: 7340469, nomGenesisHash: digest(1), evmGenesisHash: `0x${digest(2)}`,
  vault: `z1${'q'.repeat(38)}`, inbox: `z1${'p'.repeat(38)}`}
function proof(leg) {
  const gross = BigInt(leg.gross)
  const fee = leg.kind === 'withdrawal' ? gross * 25n / 10_000n : 0n
  const net = gross - fee
  return {sourceHash: digest(10 + legs.indexOf(leg)), sourceConfirmed: true,
    recipientHash: digest(20 + legs.indexOf(leg)), recipientConfirmed: true, recipient: 'synthetic recipient',
    gross: gross.toString(), fee: fee.toString(), net: net.toString(), recipientBefore: '123',
    recipientAfter: (123n + net * (leg.kind === 'deposit' && leg.token === 'ZNN' ? 10_000_000_000n : 1n)).toString(),
    ...(leg.kind === 'withdrawal' ? {paidIn: digest(30), receiveHash: digest(31)} : {})}
}
function fixture() {
  const calls = [], saved = []
  const adapter = {context: async () => structuredClone(context), before: async (leg) => ({key: leg.key}),
    submit: async (leg) => { calls.push(leg.key); return {sourceHash: proof(leg).sourceHash} },
    settle: async (leg) => proof(leg), verify: async () => {}}
  const save = async (record) => saved.push(structuredClone(record))
  return {adapter, save, calls, saved}
}

test('all four peg legs and both call lanes retain exact recipient accounting', async () => {
  const f = fixture()
  const record = await runQualification(f)
  assert.deepEqual(f.calls, legs.map((leg) => leg.key))
  assert.equal(record.state, 'complete')
  for (const leg of legs) {
    const intent = f.saved.find((value) => value.legs.at(-1)?.key === leg.key && value.legs.at(-1)?.state === 'prepared')
    assert.ok(intent, `${leg.key} has no pre-send intent`)
  }
  const again = fixture()
  await runQualification({...again, existing: record})
  assert.equal(again.calls.length, 0, 'a second completed run sent again')
  assert.equal(again.saved.length, 0, 'read-only revalidation rewrote its record')
})

test('a QSR deposit uses eight-decimal units while native ZNN scales to wei', () => {
  for (const leg of legs) validateProof(leg, proof(leg))
  const qsr = legs[1], wrong = proof(qsr)
  wrong.recipientAfter = (123n + BigInt(qsr.gross) * 10_000_000_000n).toString()
  assert.throws(() => validateProof(qsr, wrong), /recipient delta/)
})

test('pending or published withdrawals cannot satisfy completed recipient evidence', async (t) => {
  const leg = legs[2]
  for (const [name, change] of [
    ['pending source', {sourceConfirmed: false}], ['pending recipient', {recipientConfirmed: false}],
    ['missing payout', {paidIn: digest(0)}], ['missing receive', {receiveHash: digest(0)}],
    ['wrong net', {net: '1'}], ['gross rather than net credit', {recipientAfter: (123n + BigInt(leg.gross)).toString()}],
    ['tiny positive recipient balance', {recipientAfter: '124'}], ['over-credit', {recipientAfter: '999999999999999999'}],
  ]) await t.test(name, () => assert.throws(() => validateProof(leg, {...proof(leg), ...change})))
})

test('an unfinished attempt is preserved and never automatically submitted again', async (t) => {
  for (const failAt of ['before', 'submit', 'settle', 'verify']) await t.test(failAt, async () => {
    const f = fixture()
    f.adapter[failAt] = async () => { throw new Error('synthetic interruption') }
    await assert.rejects(runQualification(f), /synthetic interruption/)
    const retained = f.saved.at(-1), before = JSON.stringify(retained)
    const next = fixture()
    await assert.rejects(runQualification({...next, existing: retained}), /complete seed settlement evidence/)
    assert.equal(next.calls.length, 0)
    assert.equal(next.saved.length, 0)
    assert.equal(JSON.stringify(retained), before)
  })
})

test('a partial recipient receive identity can be checkpointed without changing its source', async () => {
  const f = fixture()
  const complete = f.adapter.settle
  f.adapter.settle = async (leg, entry, checkpoint) => {
    if (leg.kind !== 'withdrawal') return complete(leg, entry, checkpoint)
    entry.receiveHash = digest(40)
    await checkpoint()
    throw new Error('synthetic observation timeout')
  }
  await assert.rejects(runQualification(f), /observation timeout/)
  assert.equal(f.saved.at(-1).legs.at(-1).receiveHash, digest(40))
  assert.equal(f.saved.at(-1).legs.at(-1).submitted.sourceHash, proof(legs[2]).sourceHash)
})

test('current context, every exact leg and each submitted source identity are required', async (t) => {
  const f = fixture(), record = await runQualification(f)
  for (const [name, mutate] of [
    ['another genesis', (r) => { r.context.nomGenesisHash = digest(99) }],
    ['another chain', (r) => { r.context.l1ChainId = 1 }],
    ['missing peg leg', (r) => { r.legs.splice(0, 1) }],
    ['duplicate leg', (r) => { r.legs[1] = r.legs[0] }],
    ['replaced source', (r) => { r.legs[0].submitted.sourceHash = digest(98) }],
    ['pending leg', (r) => { r.legs[0].state = 'submitted' }],
  ]) await t.test(name, async () => {
    const changed = structuredClone(record); mutate(changed)
    await assert.rejects(verifyQualification(changed, fixture().adapter))
  })
})

test('exact integer validation rejects coercion, signs, fractions and uint256 overflow', () => {
  assert.equal(uint((2n ** 256n - 1n).toString()), 2n ** 256n - 1n)
  for (const value of [1, null, '-1', '+1', '01', '1.0', '1e3', ' 1', (2n ** 256n).toString()]) assert.throws(() => uint(value))
  assert.throws(() => validateContext({...context, l2ChainId: 1}))
})

test('bounded observation polls one operation and refuses unknown or late results', async () => {
  let time = 0, reads = 0
  const options = {timeoutMs: 5, pollMs: 2, now: () => time, sleep: async (n) => { time += n }}
  assert.equal(await waitFor('synthetic', async () => ++reads === 3 ? 'complete' : null, options), 'complete')
  assert.equal(reads, 3)
  time = 0
  await assert.rejects(waitFor('pending', async () => null, options), /deadline/)
  assert.equal(time, 5)
  await assert.rejects(waitFor('unknown', async () => undefined, options), /unknown/)
  time = 0
  await assert.rejects(waitFor('late', async () => { time = 6; return 'complete' }, options), /deadline/)
})
