// This fixture receiver has no configurable endpoint or signing key. It only
// receives an exact confirmed vault payout for dev NoM index 9 on chain 69.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"
	"time"

	"github.com/Zenoglyphs-VM/zvm-core/devnet"
	"github.com/Zenoglyphs-VM/zvm-core/rollup"
	"github.com/Zenoglyphs-VM/zvm-core/znn"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	rawHash := flag.String("hash", "", "exact confirmed vault payout hash")
	token := flag.String("token", "", "ZNN or QSR")
	rawAmount := flag.String("amount", "", "exact net payout in NoM base units")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected receiver arguments")
	}
	sourceHash, err := znn.ParseHash(*rawHash)
	if err != nil || sourceHash == (znn.Hash{}) {
		return fmt.Errorf("an exact payout hash is required")
	}
	amount, ok := new(big.Int).SetString(*rawAmount, 10)
	if !ok || amount.Sign() <= 0 || !amount.IsUint64() || amount.String() != *rawAmount {
		return fmt.Errorf("a canonical positive uint64 payout amount is required")
	}
	var zts znn.TokenStandard
	switch *token {
	case "ZNN":
		zts = znn.ZNN
	case "QSR":
		zts = znn.QSR
	default:
		return fmt.Errorf("unsupported fixture token")
	}
	cfg, err := rollup.Load("/l2/rollup.json")
	if err != nil {
		return err
	}
	if cfg.L1ChainID != 69 || cfg.L2ChainID != 7340469 {
		return fmt.Errorf("isolated fixture chain identifiers required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	client := znn.NewClient("http://l1-rpc:35997")
	momentum, err := client.FrontierMomentum(ctx)
	if err != nil {
		return err
	}
	if momentum.ChainIdentifier != 69 {
		return fmt.Errorf("wrong running NoM fixture chain")
	}
	block, err := client.AccountBlockByHash(ctx, sourceHash)
	if err != nil {
		return err
	}
	recipient := devnet.Key(9)
	expected, err := znn.ParseAddress("z1qqcam4ycu0ta8333hx38r5j2z3ry9jjfxkc7t5")
	if err != nil || recipient.Address != expected {
		return fmt.Errorf("fixture recipient key does not match the pinned address")
	}
	if block == nil || block.Hash != sourceHash || block.ChainIdentifier != 69 || block.BlockType != znn.BlockTypeUserSend ||
		block.Address != cfg.Vault || block.ToAddress != recipient.Address || block.TokenStandard != zts ||
		block.AmountBig().Cmp(amount) != 0 || block.ConfirmationDetail == nil || block.ConfirmationDetail.NumConfirmations == 0 {
		return fmt.Errorf("the exact confirmed vault payout is unavailable")
	}
	if paired := block.PairedAccountBlock; paired != nil {
		if paired.Hash == (znn.Hash{}) || paired.BlockType != znn.BlockTypeUserReceive ||
			paired.Address != recipient.Address || paired.FromBlockHash != sourceHash {
			return fmt.Errorf("unexpected existing recipient receive")
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"hash": paired.Hash.String()})
	}
	account := znn.NewAccount(recipient, client, 69)
	account.AutoRebid = false // Never replace an earlier transaction identity.
	received, err := account.Receive(ctx, sourceHash)
	if err != nil {
		return err
	}
	// Confirmation is polled separately by the controller after retaining this
	// exact identity; no second receive is attempted on an observation timeout.
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"hash": received.Hash.String()})
}
