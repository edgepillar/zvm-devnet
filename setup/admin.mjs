// Hands every admin role on the devnet to one address. `zvm-node bench setup`
// and `apps setup` leave Uniswap V2's feeToSetter and the owner of the NFT
// marketplace and of the farm with zvm-core's EVM dev key 900, which is derived
// from a public string and shared by every zvm devnet; zchan is deployed owned
// by test account 0. The admin is test account 0, go-zenon's devnet mnemonic at
// Ethereum's path, unless DEVNET_ADMIN names another address. Mozaic, ZNS and
// Spark are deployed owned by the admin and need nothing here.
//
//   node admin.mjs <admin address> <test account 0's key>
//
// Each role is read first, so a second run sends nothing.
import {readFileSync} from 'node:fs'
import {createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, parseAbi, toBytes} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'

const admin = getAddress(process.argv[2])
const rpc = process.env.ZVM_RPC
const dex = JSON.parse(readFileSync('/deploy/deployment.json', 'utf8'))
const apps = JSON.parse(readFileSync('/deploy/apps.json', 'utf8'))

const probe = createPublicClient({transport: http(rpc)})
const chain = defineChain({id: await probe.getChainId(), name: 'ZVM devnet', nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18}, rpcUrls: {default: {http: [rpc]}}})
const client = createPublicClient({chain, transport: http(rpc)})
const signers = [keccak256(toBytes('zvm-dev-evm-900')), process.argv[3]].map((key) =>
  createWalletClient({chain, transport: http(rpc), account: privateKeyToAccount(key)}),
)
const zchan = JSON.parse(readFileSync('/deploy/zchan.json', 'utf8'))

const ownable = parseAbi(['function owner() view returns (address)', 'function transferOwnership(address)'])
const factory = parseAbi(['function feeToSetter() view returns (address)', 'function setFeeToSetter(address)'])
const board = parseAbi(['function owner() view returns (address)', 'function setOwner(address)'])
const roles = [
  {name: 'Uniswap V2 feeToSetter', address: dex.uniswapFactory, abi: factory, read: 'feeToSetter', write: 'setFeeToSetter'},
  {name: 'marketplace owner', address: apps.exchange, abi: ownable, read: 'owner', write: 'transferOwnership'},
  {name: 'farm owner', address: apps.farm, abi: ownable, read: 'owner', write: 'transferOwnership'},
  {name: 'zchan owner', address: zchan.zchan, abi: board, read: 'owner', write: 'setOwner'},
]

// The relayer refuses a tip under 50 gwei; zvm's own senders offer 100.
const tip = 100_000_000_000n
for (const r of roles) {
  const holder = await client.readContract({address: r.address, abi: r.abi, functionName: r.read})
  if (getAddress(holder) === admin) {
    console.log(`${r.name}: ${admin}`)
    continue
  }
  const signer = signers.find((w) => w.account.address === getAddress(holder))
  if (!signer) throw new Error(`${r.name} is ${holder}, which this devnet holds no key for`)
  const {baseFeePerGas} = await client.getBlock()
  const hash = await signer.writeContract({address: r.address, abi: r.abi, functionName: r.write, args: [admin], maxPriorityFeePerGas: tip, maxFeePerGas: baseFeePerGas * 2n + tip})
  const receipt = await client.waitForTransactionReceipt({hash, pollingInterval: 2_000, timeout: 600_000})
  if (receipt.status !== 'success') throw new Error(`handing over ${r.name} reverted: ${hash}`)
  console.log(`${r.name}: ${admin} (was ${holder})`)
}
