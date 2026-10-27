import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'

const recipient = '0x0000000000000000000000000000000000000007'
const sourceHash = '1'.repeat(64)
const l2Hash = `0x${'2'.repeat(64)}`

// Execute the real peg entry point and adapter. Only the controller, filesystem,
// CLI transport and client constructors are synthetic. No command, RPC, wallet,
// network request or real transaction is available to this module graph.
async function submittedArguments(leg) {
  const forbidden = () => { throw new Error('unexpected capability in submission fixture') }
  const files = {
    '/l2/rollup.json': {l1ChainId: 69, l2ChainId: 7340469},
    '/deploy/accounts.json': {accounts: Array.from({length: 10}, (_, index) => ({
      address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      privateKey: 'synthetic',
    }))},
  }
  let locked = false, submissions = 0
  const calls = []
  const context = createContext({Buffer, fetch: forbidden, console: {log: () => {}}})
  const builtins = new Map([
    ['node:child_process', {execFileSync: (name, args, options) => {
      calls.push({name, args: [...args], options})
      return `NoM block   ${sourceHash}\nL2 tx       ${l2Hash}\n`
    }}],
    ['node:crypto', {createHash}],
    ['node:fs', {
      existsSync: (name) => Object.hasOwn(files, name),
      readFileSync: (name) => {
        assert.ok(Object.hasOwn(files, name), 'unexpected fixture file')
        return JSON.stringify(files[name])
      },
      lstatSync: (name) => {
        if (name === '/deploy/.settlement-lock') {
          assert.ok(locked)
          return {dev: 1, ino: 2, isDirectory: () => true}
        }
        assert.ok(Object.hasOwn(files, name), 'unexpected fixture stat')
        return {size: JSON.stringify(files[name]).length, isFile: () => true}
      },
      mkdirSync: (name) => {
        assert.equal(name, '/deploy/.settlement-lock')
        assert.equal(locked, false)
        locked = true
      },
      rmdirSync: (name) => {
        assert.equal(name, '/deploy/.settlement-lock')
        assert.ok(locked)
        locked = false
      },
      writeFileSync: forbidden, openSync: forbidden, closeSync: forbidden,
      fsyncSync: forbidden, renameSync: forbidden,
    }],
    ['viem', {
      createPublicClient: () => ({}), createWalletClient: forbidden,
      defineChain: (value) => value, encodeFunctionData: forbidden,
      getAddress: (value) => value, http: () => ({}),
      parseAbi: (value) => value, parseEventLogs: forbidden,
    }],
    ['viem/accounts', {privateKeyToAccount: forbidden}],
    ['./settlement.mjs', {
      runQualification: async ({existing, adapter}) => {
        assert.equal(existing, null)
        submissions++
        return adapter.submit(leg, {recipient})
      },
      verifyQualification: forbidden, validateProof: forbidden, uint: forbidden, waitFor: forbidden,
    }],
  ])
  const program = new SourceTextModule(readFileSync(new URL('./peg.mjs', import.meta.url), 'utf8'), {context})
  await program.link((name) => {
    assert.ok(builtins.has(name), 'unexpected submission-fixture import: ' + name)
    const exports = builtins.get(name)
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, {context})
  })
  await program.evaluate({timeout: 5000})
  const result = await program.namespace.runBridgeQualification()
  assert.equal(submissions, 1)
  assert.equal(locked, false, 'entry point did not release its synthetic lock')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'zvm')
  assert.equal(calls[0].options.timeout, 60_000)
  assert.equal(calls[0].options.maxBuffer, 64 * 1024)
  assert.equal(result.sourceHash, sourceHash)
  assert.equal(result.actualExit, 0)
  return calls[0].args
}

const common = (kind) => [kind, '-config', '/l2/rollup.json', '-l1', 'http://l1-rpc:35997',
  '-eth', 'http://reth:8545', '-index', '8', '-wait', '0', '-to', recipient]

test('native EOA qualification declares intrinsic gas and its ZNN fee token', async () => {
  const args = await submittedArguments({kind: 'native', token: 'ZNN', gross: '0'})
  assert.deepEqual(args, [...common('call'), '-value', '0', '-data', '0x', '-gas', '21000', '-fee-token', 'ZNN'])
})

test('ZNN deposit retains its CLI token and exact whole-unit amount', async () => {
  const args = await submittedArguments({kind: 'deposit', token: 'ZNN', gross: '5000000000'})
  assert.deepEqual(args, [...common('deposit'), '-token', 'ZNN', '-amount', '50'])
})

test('QSR deposit retains its own CLI path and eight-decimal units', async () => {
  const args = await submittedArguments({kind: 'deposit', token: 'QSR', gross: '100000000000'})
  assert.deepEqual(args, [...common('deposit'), '-token', 'QSR', '-amount', '1000'])
})
