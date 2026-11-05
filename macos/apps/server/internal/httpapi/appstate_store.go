package httpapi

import (
	"context"
	"database/sql"
	"errors"
)

// sqlAppStateKV 对接 SQLite 的 app_state 表（value_json + updated_at），是
// appstate.Store 在生产环境的 KV 实现。原先 17 个文件各自手写这两条 SQL，
// 现在收进这里；业务文件按迁移顺序换到 s.appStateStore 的 Update/Load/Save。
type sqlAppStateKV struct{ handle *sql.DB }

// The conditional write is atomic even against writers using raw SQL. Keep
// callbacks outside a transaction: idea validation queries this same database.
func (kv sqlAppStateKV) Update(ctx context.Context, key string, fn func([]byte, bool) ([]byte, error)) error {
	for attempt := 0; attempt < 16; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		current, exists, err := kv.Get(ctx, key)
		if err != nil {
			return err
		}
		next, err := fn(current, exists)
		if err != nil || next == nil {
			return err
		}
		var result sql.Result
		if exists {
			result, err = kv.handle.ExecContext(ctx, `UPDATE app_state SET value_json=?,updated_at=? WHERE key=? AND value_json=?`, string(next), nowStamp(), key, string(current))
		} else {
			result, err = kv.handle.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING`, key, string(next), nowStamp())
		}
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 1 {
			return nil
		}
	}
	return errors.New("元数据被并发修改，请重试")
}

func (kv sqlAppStateKV) Get(ctx context.Context, key string) ([]byte, bool, error) {
	var body string
	err := kv.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, key).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return []byte(body), true, nil
}

func (kv sqlAppStateKV) Put(ctx context.Context, key string, data []byte) error {
	_, err := kv.handle.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(data), nowStamp())
	return err
}
