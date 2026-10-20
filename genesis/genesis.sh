#!/bin/sh
# Writes both layers' genesis once, into the nom and l2 volumes, and does
# nothing on every later start. Runs in the zvm-core image (zvm-core's CLI).
#
# The timestamp is now: go-zenon schedules momentum ticks from the genesis
# timestamp, and a single pillar on a genesis far in the past produces in only
# some of its ticks (zvm-core devnet.GenesisTimestampSec). Both layers must
# agree on it, so a half-written pair is written again from scratch.
set -eu

if [ -f /nom/genesis.json ] && [ -f /l2/rollup.json ]; then
	echo "genesis exists; chain $(sed -n 's/.*"ChainIdentifier": *\([0-9]*\).*/\1/p' /nom/genesis.json)"
	exit 0
fi
rm -rf /nom/* /l2/*

ts=$(date +%s)
# NoM chain 69 with dynamic plasma from genesis: l1-genesis's defaults, and
# what go-zenon's dev branch runs. The pillar is on this stack's own subnet
# (docker-compose.yml), not zvm-fleet's, which a host may already have.
zvm l1-genesis -out /nom -devnet /go-zenon-devnet -timestamp "$ts" -subnet 10.70.0

# The burned fee is priced against the L1's supply. l2-genesis would read it
# from a running node, and none is running yet; at genesis it is epoch 0 and
# the two totals just written, ZNN's first.
supply=$(sed -n 's/.*"totalSupply": *\([0-9]*\).*/\1/p' /nom/genesis.json | head -2 | paste -sd, -)
case "$supply" in
*,*) ;;
*) echo "no ZNN and QSR totalSupply in /nom/genesis.json" >&2; exit 1 ;;
esac

# ZVM chain 7340469 on it: Karst, a base-fee floor, the burned fee from
# momentum 10, both forks from 200, and a 0.25% withdrawal fee.
zvm l2-genesis -out /l2 -timestamp "$ts" -fee-anchor "$ts,0,$supply" \
	-evm karst -min-base-fee 1000000 -fee-from 10 -gas-fork 200 -wire-fork 200 -bridge-fee-bps 25
echo "genesis written at $ts"
