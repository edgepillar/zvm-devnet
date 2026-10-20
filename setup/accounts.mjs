// The devnet's EVM test accounts: go-zenon's devnet mnemonic at Ethereum's
// own path, m/44'/60'/0'/0/i, which is what MetaMask and Rabby derive when the
// mnemonic is imported. Its NoM accounts are the same mnemonic at Zenon's path
// (go-zenon docker/devnet/README.md), so one phrase holds both sides.
//
//   node accounts.mjs <out.json> <count> <znn each>
//
// Writes the accounts and brings each up to the given ZNN on the ZVM, paid by
// zvm-core's EVM dev key 900, which `zvm-node bench setup` funds through the
// vault. ZNN reaches the ZVM only through the vault: the L2 genesis holds none.
import {writeFileSync} from 'node:fs'
import {createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, toBytes, toHex} from 'viem'
import {mnemonicToAccount, privateKeyToAccount} from 'viem/accounts'

const MNEMONIC =
  'abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million'

const [out, count, each] = process.argv.slice(2)
const rpc = process.env.ZVM_RPC
const want = parseEther(each)

const probe = createPublicClient({transport: http(rpc)})
const chain = defineChain({id: await probe.getChainId(), name: 'ZVM devnet', nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [rpc]}}})
const client = createPublicClient({chain, transport: http(rpc)})
const funder = createWalletClient({chain, transport: http(rpc), account: privateKeyToAccount(keccak256(toBytes('zvm-dev-evm-900')))})

const accounts = []
for (let i = 0; i < Number(count); i++) {
  const account = mnemonicToAccount(MNEMONIC, {addressIndex: i})
  accounts.push({index: i, address: account.address, privateKey: toHex(account.getHdKey().privateKey)})
}
writeFileSync(out, JSON.stringify({mnemonic: MNEMONIC, path: "m/44'/60'/0'/0/i", accounts}, null, 2) + '\n')

// The relayer refuses a tip under 50 gwei; zvm's own senders offer 100.
const tip = 100_000_000_000n
const hashes = []
let nonce = await client.getTransactionCount({address: funder.account.address, blockTag: 'pending'})
const {baseFeePerGas} = await client.getBlock()
for (const a of accounts) {
  const held = await client.getBalance({address: a.address})
  if (held >= want) continue
  hashes.push(await funder.sendTransaction({to: a.address, value: want - held, nonce: nonce++, maxPriorityFeePerGas: tip, maxFeePerGas: baseFeePerGas * 2n + tip}))
}
for (const hash of hashes) {
  const r = await client.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 600_000})
  if (r.status !== 'success') throw new Error(`funding ${hash} reverted`)
}
for (const a of accounts) console.log(`${a.index}  ${a.address}  ${formatEther(await client.getBalance({address: a.address}))} ZNN`)
