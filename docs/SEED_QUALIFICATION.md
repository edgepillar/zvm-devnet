# Seed and completed settlement qualification

`setup seed` retains the existing application activity and then qualifies four
peg legs: ZNN and QSR deposits and ZNN and QSR withdrawals. It also sends a
native inbox call and a relayed transfer. `setup check --require-seed` requires
the seed record and re-reads the exact settlement evidence. An aggregate paid
counter, a pending withdrawal or an arbitrary positive token balance cannot
satisfy the gate.

The fixed compose endpoints, NoM chain 69, ZVM chain 7340469, both observed
genesis identities, vault and inbox bind the retained record. ZNN deposits
scale NoM base units by 1e10; Wrapped QSR retains NoM's eight-decimal units.
Withdrawals account for the selected 25-basis-point genesis fee and credit its
exact net amount. The checker binds each withdrawal event and record to the
confirmed exact NoM vault payout, its withdrawal-ID payload, the recipient's
receive block and the recipient balance delta. EVM recipient observations are
read at retained canonical block hashes; source debits include observed gas
and any reported L1 fee. The zero-value native EOA call declares 21,000 gas
and pays the CLI's ZNN fee quote for the selected chain. Its receipt and
recipient are checked; contract creation, calldata execution and other gas
limits remain outside this selected call. The nonzero relayed transfer is
checked against its actual receipt and recipient.

Intent is retained before each possible submission. An incomplete or ambiguous
attempt is preserved and refused on later runs. The controller does not re-sign,
replace or automatically submit it again. The fixture receiver accepts only an
exact confirmed vault payout for the pinned development recipient, uses fixed
internal endpoints and disables automatic rebidding. A complete record is
revalidated without new sends. Legacy bridge seed markers without this evidence
require a separately created isolated stack; they are not silently migrated or
replayed. Existing data and failures must be retained.

The lightweight Node tests execute the real check entry point with synthetic
RPC/filesystem/wallet/timer capabilities and exercise the control flow, exact
arithmetic, pending/unknown/incorrect proof refusal, deadline handling and
second-run submission count. They do not execute a real chain. CI runs these
controls before the existing full clean-checkout compose build, actual seed and
required settlement check. A second actual seed compares selected application
account nonces, the two selected NoM account frontiers and both evidence-file
hashes. The files contain development identities; they are not uploaded as
public diagnostic artifacts or treated as credentials for another network.

A source proposal or green lightweight control is not a successful full stack.
Keep the actual workflow revision, attempt, platform, exit and step outcomes.
These are isolated integration observations through the selected local RPCs,
not independent NoM value proofs, authenticated production release/context
acceptance, supported-browser qualification, adversarial endpoint assurance,
cross-file snapshots, general wallet recovery or hardware power-loss proof.
No public-chain, real-fund, release or deployment operation is required.

A separate submission fixture executes the real peg entry point and adapter
with synthetic CLI transport. It checks the native gas and fee-token
arguments and both unchanged deposit token/amount paths. It does not run
the Go CLI, buy real gas or qualify a completed native transaction.
