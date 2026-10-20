#!/bin/sh
# go-zenon's docker/devnet/entrypoint.sh at the pinned commit, carried here
# because a Windows checkout of the submodule gives it CRLF line endings and
# the image then cannot exec it. This repository's .gitattributes keeps this
# copy LF everywhere.
set -e

ROLE="${ZNND_ROLE:-rpc}"
SRC="/devnet/${ROLE}"
DATA_DIR="/root/.znn"

if [ ! -d "$SRC" ]; then
    echo "unknown ZNND_ROLE='$ROLE' (expected a directory under /devnet)" >&2
    exit 1
fi

mkdir -p "$DATA_DIR"

if [ ! -f "$DATA_DIR/config.json" ]; then
    echo "seeding $DATA_DIR for role=$ROLE"
    cp "$SRC/config.json" "$DATA_DIR/config.json"
    cp /devnet/genesis.json "$DATA_DIR/genesis.json"

    if [ -d "$SRC/wallet" ]; then
        mkdir -p "$DATA_DIR/wallet"
        cp -r "$SRC/wallet/." "$DATA_DIR/wallet/"
        chmod 700 "$DATA_DIR/wallet"
        chmod 600 "$DATA_DIR/wallet/"*
    fi

    if [ -f "$SRC/network-private-key" ]; then
        cp "$SRC/network-private-key" "$DATA_DIR/network-private-key"
        chmod 600 "$DATA_DIR/network-private-key"
    fi
fi

exec znnd "$@"
