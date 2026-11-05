package proctree

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProcessTreeHelper(t *testing.T) {
	mode := os.Getenv("READX_TREE_TEST")
	if mode == "" {
		return
	}
	if mode == "parent" {
		child := exec.Command(os.Args[0], "-test.run=^TestProcessTreeHelper$")
		child.Env = append(os.Environ(), "READX_TREE_TEST=child")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		os.Stdout.WriteString("ready\n")
	}
	for {
		if mode == "child" {
			_ = os.WriteFile(os.Getenv("READX_TREE_MARKER"), []byte(time.Now().String()), 0600)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCancellationStopsDescendants(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "heartbeat")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProcessTreeHelper$")
	cmd.Env = append(os.Environ(), "READX_TREE_TEST=parent", "READX_TREE_MARKER="+marker)
	Configure(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err = bufio.NewReader(stdout).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err = os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err = cmd.Wait(); err == nil {
		t.Fatal("cancelled process succeeded")
	}
	before, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	after, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("descendant kept writing after cancellation")
	}
}
