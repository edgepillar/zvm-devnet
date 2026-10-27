#!/bin/sh
# Puts every app on the devnet and builds every page against it, then exits.
#
# Each step is skipped when it is done: a contract step when its record in
# /deploy says so, the pages when they were built from the same records and
# the same ZVM_DEVNET_URL. So this runs on every `docker compose up`, finishes
# in seconds after the first time, and rebuilds the pages when the URL changes.
#
#   /deploy   deployment records (the node reads deployment.json and apps.json),
#             accounts.json, the test accounts, and keys/, the apps' key files
#   /site     the built pages, which the gateway serves
#
# Ends with check.mjs, the sanity check; `setup check` runs only that, and
# `setup seed` fills the finished devnet with test activity (seed.mjs).
set -eu

URL=${ZVM_DEVNET_URL:-http://localhost:47080}
URL=${URL%/}
case "$URL" in
https://*) WS="wss://${URL#https://}" ;;
*) WS="ws://${URL#http://}" ;;
esac

NODE=http://node:8080
export ZVM_RPC=$NODE/rpc ZVM_NODE=$NODE ZVM_GATEWAY=$URL
CLI="-config /l2/rollup.json -l1 http://l1-rpc:35997 -eth http://reth:8545 -submit http://relayer:8547 -api $NODE"
mkdir -p /deploy/keys

case "${1:-}" in
check) shift; exec node /apps/check.mjs "$@" ;;
seed-state) exec node /apps/seed-state.mjs ;;
seed)
	[ -f /site/.stamp ] || { echo "setup has not finished: docker compose logs setup" >&2; exit 1; }
	exec node /apps/seed.mjs
	;;
esac

say() { printf '\n== %s\n' "$*"; }
# json FILE EXPR: one value out of a JSON file, or nothing.
json() { node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],o);if(v!=null)console.log(v)}catch{}' "$1" "$2"; }

# --- wait for the chain ---------------------------------------------------------
# Nothing can land until derivation has caught up with NoM.
say "waiting for the node to catch up with NoM"
i=0
until wget -qO /tmp/info.json $NODE/api/info 2>/dev/null &&
	[ "$(json /tmp/info.json derivation.stalled)" = false ] &&
	[ "$(json /tmp/info.json derivation.lag)" -le 5 ] 2>/dev/null; do
	i=$((i + 1))
	[ $i -gt 120 ] && { echo "the node did not catch up in 20 minutes" >&2; exit 1; }
	sleep 10
done
echo "derived momentum $(json /tmp/info.json derivation.momentum), L2 head $(json /tmp/info.json l2.head)"

# --- the contracts zvm-node owns ------------------------------------------------
# WZNN, the Uniswap V2 factory and router, and nothing else: a pair is a fact
# once the factory emits it, so benchmark tokens would sit on the swap page for
# the life of the chain.
if [ -z "$(json /deploy/deployment.json uniswapRouter)" ]; then
	say "Uniswap V2"
	# shellcheck disable=SC2086
	zvm-node bench setup $CLI -swap-only -fund-znn 300000 -out /deploy/deployment.json
fi
# The ZNN/QSR pool, whose QSR is bridged from the bench funder.
if [ ! -f /deploy/.dex-seeded ]; then
	say "the ZNN/QSR pool"
	# shellcheck disable=SC2086
	zvm-node dex seed $CLI -deployment /deploy/deployment.json -znn 0 -qsr-pool-znn 1000
	touch /deploy/.dex-seeded
fi
# The NFT marketplace, the collection factory and the farm.
if [ -z "$(json /deploy/apps.json collections.0)" ]; then
	say "the marketplace and the farm"
	# shellcheck disable=SC2086
	zvm-node apps setup $CLI -deployment /deploy/deployment.json -out /deploy/apps.json
fi
# WZNN and WQSR earn their checkmark from the deployment, so a copycat cannot.
if [ ! -f /deploy/.tokens-verified ]; then
	say "verifying WZNN and WQSR"
	(cd /apps/zvm-node && zvm-node verify-tokens -api $NODE -deployment /deploy/deployment.json)
	touch /deploy/.tokens-verified
fi

# --- the test accounts ------------------------------------------------------------
# go-zenon's devnet mnemonic, at Ethereum's path, each brought up to 10,000 ZNN
# (accounts.mjs). The first is the admin unless DEVNET_ADMIN names another
# address, and deploys ZNS; the second is zchan's janitor.
say "test accounts"
node /apps/accounts.mjs /deploy/accounts.json 10 10000
key() { json /deploy/accounts.json "accounts.$1.privateKey"; }
[ -f /deploy/keys/zchan.json ] || printf '{"owner": "%s", "janitor": "%s"}\n' "$(key 0)" "$(key 1)" >/deploy/keys/zchan.json
[ -f /deploy/keys/zns.json ] || printf '{"deployer": "%s"}\n' "$(key 0)" >/deploy/keys/zns.json

# --- the apps' own contracts ----------------------------------------------------
# Their gas comes from zvm-core's EVM dev key 900, which the deploy scripts
# default to. The admin owns them, and takes what they earn.
ADMIN=${DEVNET_ADMIN:-$(json /deploy/accounts.json accounts.0.address)}
export DEVNET_ADMIN=$ADMIN
echo "admin $ADMIN"

if [ -z "$(json /deploy/mozaic.json routerVerified)" ]; then
	say "Mozaic"
	(cd /apps/zvm-mozaic && node scripts/deploy.mjs --rpc "$ZVM_RPC" --record /deploy/mozaic.json --owner "$ADMIN")
fi

if [ -z "$(json /deploy/zchan.json verified)" ]; then
	say "zchan"
	cd /apps/zvm-zchan/contracts
	node scripts/deploy.mjs -keys /deploy/keys/zchan.json -record /deploy/zchan.json
fi

if [ -z "$(json /deploy/zns.json verified)" ]; then
	say "ZNS"
	cd /apps/zvm-zns/contracts
	node scripts/deploy.mjs -owner "$ADMIN" -site "$URL/zns/" -keys /deploy/keys/zns.json -record /deploy/zns.json
fi

if [ -z "$(json /deploy/spark.json commentsVerified)" ]; then
	say "Spark"
	cd /apps/zvm-spark/contracts
	node scripts/deploy.mjs -owner "$ADMIN" -record /deploy/spark.json \
		-glyphswap /deploy/deployment.json -zns /deploy/zns.json
fi

# Every other admin role, from whichever key deployed it (admin.mjs).
say "admin roles"
node /apps/admin.mjs "$ADMIN" "$(key 0)"

# --- the pages ------------------------------------------------------------------
# Built with this devnet's records, as deployments/zvm.json, the name every
# page reads when VITE_DEPLOYMENT names no other. No repository commits a
# record, so these are the only ones in each app's copy here.
build_pages() {
	for app in mozaic zns zchan spark; do
		mkdir -p "/apps/zvm-$app/deployments"
		cp "/deploy/$app.json" "/apps/zvm-$app/deployments/zvm.json"
	done

	export VITE_ZVM_NODE=$URL/zvm VITE_GATEWAY=$URL VITE_NOM_NODE=$WS/zenon
	# .znn names in every page, and Karum's art for ZNS's registrar, from this
	# devnet's own ZNS.
	VITE_ZNS_RESOLVER=$(json /deploy/zns.json contracts.UniversalResolver)
	VITE_ZNS_REGISTRARS=$(json /deploy/zns.json contracts.ZNSRegistrar)
	export VITE_ZNS_RESOLVER VITE_ZNS_REGISTRARS
	for page in explorer:zvm-explorer glyphswap:zvm-glyphswap karum:zvm-karum nft:zvm-nft mozaic:zvm-mozaic \
		status:zvm-status/web zchan:zvm-zchan/web zns:zvm-zns/web spark:zvm-spark/web; do
		prefix=${page%%:*}
		dir=/apps/${page#*:}
		say "page /$prefix/"
		rm -rf "$dir/dist"
		(cd "$dir" && BASE_PATH=/$prefix/ npx vite build --logLevel warn)
		rm -rf "/site/$prefix"
		cp -r "$dir/dist" "/site/$prefix"
	done
}

stamp=$( (echo "$URL"; cat /deploy/*.json; cat /apps/.built-from 2>/dev/null) | sha256sum | cut -c1-16)
if [ "$(cat /site/.stamp 2>/dev/null)" = "$stamp" ]; then
	say "pages are current for $URL"
else
	build_pages
	echo "$stamp" >/site/.stamp
fi

say "sanity check"
node /apps/check.mjs
say "done: $URL"
