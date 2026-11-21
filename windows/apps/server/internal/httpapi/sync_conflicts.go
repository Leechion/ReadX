package httpapi

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type syncConflictNoteSnapshot struct {
	ID          string `json:"id"`
	DocumentKey string `json:"documentKey"`
	Page        *int   `json:"page"`
	Kind        string `json:"kind"`
	Quote       string `json:"quote"`
	Note        string `json:"note"`
	Color       string `json:"color"`
	Tags        string `json:"tags"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type syncConflictPair struct {
	ConflictID    string                    `json:"conflictId"`
	OriginalID    string                    `json:"originalId"`
	DocumentKey   string                    `json:"documentKey"`
	DocumentTitle string                    `json:"documentTitle"`
	Conflict      syncConflictNoteSnapshot  `json:"conflict"`
	Original      *syncConflictNoteSnapshot `json:"original"`
}

func (s *Server) handleSyncConflicts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}

	var conflicts []syncConflictNoteSnapshot
	err := func() error {
		rows, err := s.handle.QueryContext(ctx, `
			SELECT id, document_id, page, kind, quote, note, color, tags, created_at, updated_at
			FROM annotations
			WHERE id LIKE '%~sync-%'
			ORDER BY updated_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item syncConflictNoteSnapshot
			if scanErr := rows.Scan(
				&item.ID, &item.DocumentKey, &item.Page, &item.Kind,
				&item.Quote, &item.Note, &item.Color, &item.Tags,
				&item.CreatedAt, &item.UpdatedAt,
			); scanErr != nil {
				return scanErr
			}
			conflicts = append(conflicts, item)
		}
		return rows.Err()
	}()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("读取同步冲突失败: %v", err))
		return
	}

	pairs := make([]syncConflictPair, 0, len(conflicts))
	for _, c := range conflicts {
		origID := c.ID
		if idx := strings.Index(c.ID, "~sync-"); idx > 0 {
			origID = c.ID[:idx]
		}
		var docTitle string
		_ = s.handle.QueryRowContext(ctx, `SELECT title FROM documents WHERE id = ?`, c.DocumentKey).Scan(&docTitle)

		var orig syncConflictNoteSnapshot
		origErr := s.handle.QueryRowContext(ctx, `
			SELECT id, document_id, page, kind, quote, note, color, tags, created_at, updated_at
			FROM annotations WHERE id = ?`, origID).Scan(
			&orig.ID, &orig.DocumentKey, &orig.Page, &orig.Kind,
			&orig.Quote, &orig.Note, &orig.Color, &orig.Tags,
			&orig.CreatedAt, &orig.UpdatedAt,
		)
		var origPtr *syncConflictNoteSnapshot
		if origErr == nil {
			origPtr = &orig
		} else if !errors.Is(origErr, sql.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("读取冲突原批注失败: %v", origErr))
			return
		}
		pairs = append(pairs, syncConflictPair{
			ConflictID:    c.ID,
			OriginalID:    origID,
			DocumentKey:   c.DocumentKey,
			DocumentTitle: normalizePaperTitle(docTitle),
			Conflict:      c,
			Original:      origPtr,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"conflicts": pairs,
		"total":     len(pairs),
	})
}

func (s *Server) handleSyncConflictResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "只允许 POST")
		return
	}
	var body struct {
		ConflictID  string `json:"conflictId"`
		OriginalID  string `json:"originalId"`
		Decision    string `json:"decision"` // "keep_original" | "keep_conflict" | "keep_both" | "custom"
		MergedNote  string `json:"mergedNote"`
		MergedColor string `json:"mergedColor"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	conflictID := strings.TrimSpace(body.ConflictID)
	if conflictID == "" || !strings.Contains(conflictID, "~sync-") {
		writeError(w, http.StatusBadRequest, "无效的冲突批注 ID")
		return
	}
	originalID := strings.TrimSpace(body.OriginalID)
	if originalID == "" {
		originalID = conflictID[:strings.Index(conflictID, "~sync-")]
	}
	decision := strings.TrimSpace(body.Decision)
	switch decision {
	case "keep_original", "keep_conflict", "keep_both", "custom":
	default:
		writeError(w, http.StatusBadRequest, "decision 仅支持 keep_original / keep_conflict / keep_both / custom")
		return
	}

	ctx := r.Context()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer func() { _ = tx.Rollback() }()

	var cDocID, cQuote, cNote, cColor, cTags, cKind, cCreatedAt, cUpdatedAt, cLocator string
	var cPage sql.NullInt64
	var cStart, cEnd sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT document_id, page, quote, note, color, tags, kind, start_offset, end_offset, created_at, updated_at, locator_json
		FROM annotations WHERE id = ?`, conflictID).Scan(
		&cDocID, &cPage, &cQuote, &cNote, &cColor, &cTags, &cKind, &cStart, &cEnd, &cCreatedAt, &cUpdatedAt, &cLocator,
	)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "冲突批注不存在或已解决")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var origExists int
	_ = tx.QueryRowContext(ctx, `SELECT COUNT(1) FROM annotations WHERE id = ?`, originalID).Scan(&origExists)

	switch decision {
	case "keep_original":
		if origExists == 0 {
			writeError(w, http.StatusConflict, "原批注已不存在，无法仅保留原版")
			return
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM annotations WHERE id = ?`, conflictID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	case "keep_conflict":
		if origExists > 0 {
			if _, err := tx.ExecContext(ctx, `
				UPDATE annotations
				SET page=?, quote=?, note=?, color=?, tags=?, kind=?, start_offset=?, end_offset=?, updated_at=?, locator_json=?
				WHERE id = ?`,
				cPage, cQuote, cNote, cColor, cTags, cKind, cStart, cEnd, now, cLocator, originalID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM annotations WHERE id = ?`, conflictID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else {
			newID, genErr := randomResolvedAnnotationID()
			if genErr != nil {
				writeError(w, http.StatusInternalServerError, genErr.Error())
				return
			}
			if _, err := tx.ExecContext(ctx, `UPDATE annotations SET id = ?, updated_at = ? WHERE id = ?`, newID, now, conflictID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	case "keep_both":
		newID, genErr := randomResolvedAnnotationID()
		if genErr != nil {
			writeError(w, http.StatusInternalServerError, genErr.Error())
			return
		}
		if _, err := tx.ExecContext(ctx, `UPDATE annotations SET id = ?, updated_at = ? WHERE id = ?`, newID, now, conflictID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	case "custom":
		noteText := strings.TrimSpace(body.MergedNote)
		if origExists > 0 {
			color := strings.TrimSpace(body.MergedColor)
			if color == "" {
				if _, err := tx.ExecContext(ctx, `UPDATE annotations SET note = ?, updated_at = ? WHERE id = ?`, noteText, now, originalID); err != nil {
					writeError(w, http.StatusInternalServerError, err.Error())
					return
				}
			} else {
				if _, err := tx.ExecContext(ctx, `UPDATE annotations SET note = ?, color = ?, updated_at = ? WHERE id = ?`, noteText, color, now, originalID); err != nil {
					writeError(w, http.StatusInternalServerError, err.Error())
					return
				}
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM annotations WHERE id = ?`, conflictID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else {
			newID, genErr := randomResolvedAnnotationID()
			if genErr != nil {
				writeError(w, http.StatusInternalServerError, genErr.Error())
				return
			}
			if _, err := tx.ExecContext(ctx, `UPDATE annotations SET id = ?, note = ?, updated_at = ? WHERE id = ?`, newID, noteText, now, conflictID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"resolved": true,
		"decision": decision,
	})
}

func randomResolvedAnnotationID() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "note_" + hex.EncodeToString(raw[:]), nil
}
