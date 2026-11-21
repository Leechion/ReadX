package latex

import (
	"context"
	"errors"
	"testing"
)

func TestDiffSnapshotDetectsAddedDeletedAndModifiedFiles(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "Diff Test", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "sections/old.tex", []byte("old section\n"), ""); err != nil {
		t.Fatal(err)
	}
	snap, err := service.CreateSnapshot(ctx, project.ID, "before edit")
	if err != nil {
		t.Fatal(err)
	}

	// 1. Modify main.tex
	doc, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(doc.Content+"\n% edited\n"), doc.Revision); err != nil {
		t.Fatal(err)
	}
	// 2. Delete sections/old.tex
	if err := service.DeletePath(ctx, project.ID, "sections/old.tex"); err != nil {
		t.Fatal(err)
	}
	// 3. Add sections/new.tex
	if _, err := service.WriteFile(ctx, project.ID, "sections/new.tex", []byte("new section\n"), ""); err != nil {
		t.Fatal(err)
	}

	diff, err := service.DiffSnapshot(ctx, snap.ID)
	if err != nil {
		t.Fatalf("DiffSnapshot failed: %v", err)
	}
	if len(diff.Files) != 3 {
		t.Fatalf("expected 3 changed files, got %d: %+v", len(diff.Files), diff.Files)
	}
	byPath := map[string]SnapshotFileDiff{}
	for _, f := range diff.Files {
		byPath[f.Path] = f
	}
	if byPath["main.tex"].Status != "modified" || byPath["main.tex"].After == byPath["main.tex"].Before {
		t.Fatalf("expected modified main.tex, got %+v", byPath["main.tex"])
	}
	if byPath["sections/new.tex"].Status != "added" || byPath["sections/new.tex"].After == "" {
		t.Fatalf("expected added sections/new.tex, got %+v", byPath["sections/new.tex"])
	}
	if byPath["sections/old.tex"].Status != "deleted" || byPath["sections/old.tex"].Before == "" {
		t.Fatalf("expected deleted sections/old.tex, got %+v", byPath["sections/old.tex"])
	}
}

func TestGitInitCommitAndRemoteValidation(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "Git Test", EngineXeLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}

	// Always validate URL sanitization regardless of git binary availability.
	unsafeURLs := []string{
		"",
		"--upload-pack=touch /tmp/pwn",
		"-u origin",
		"ext::sh -c id",
		"file:///etc/passwd",
		"https://example.com/repo.git extra",
	}
	for _, bad := range unsafeURLs {
		if _, setErr := service.GitSetRemote(ctx, project.ID, bad); !errors.Is(setErr, ErrGitInvalidInput) {
			t.Fatalf("expected ErrGitInvalidInput for %q, got %v", bad, setErr)
		}
	}

	status, err := service.GitStatus(ctx, project.ID)
	if err != nil {
		t.Fatalf("GitStatus failed: %v", err)
	}
	if !status.Available {
		t.Skip("git CLI is not installed in test environment")
	}
	if status.Initialized {
		t.Fatalf("expected uninitialized repository initially")
	}

	inited, err := service.GitInit(ctx, project.ID, "main")
	if err != nil {
		t.Fatalf("GitInit failed: %v", err)
	}
	if !inited.Initialized || inited.Clean {
		t.Fatalf("expected initialized repo with untracked files, got %+v", inited)
	}

	committed, err := service.GitCommit(ctx, project.ID, "initial latex draft")
	if err != nil {
		t.Fatalf("GitCommit failed: %v", err)
	}
	if !committed.Clean || committed.LastCommit == "" {
		t.Fatalf("expected clean workspace after commit, got %+v", committed)
	}

	withRemote, err := service.GitSetRemote(ctx, project.ID, "https://github.com/example/cbct-paper.git")
	if err != nil {
		t.Fatalf("GitSetRemote failed: %v", err)
	}
	if withRemote.RemoteURL != "https://github.com/example/cbct-paper.git" {
		t.Fatalf("unexpected remote url: %s", withRemote.RemoteURL)
	}
}
