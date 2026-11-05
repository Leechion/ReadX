// Package appstate 给 app_state 键值表一个带每 key 锁的统一入口。
//
// 现状（本仓库）：17 个 httpapi 文件直接对这张表做「读整包 JSON → 改 → 写回」
// （62 处引用），锁按 key 各自记忆——ideas/docsmeta 用 appStateMu、graph 另起
// graphMu、citation_network 的缓存写入完全无锁。key 不相交所以尚未构成数据
// 竞争，但这是靠约定不是机制：任何人往同一个 key 写，都得记得对应的锁。
//
// 本包把约定变成机制：
//   - 同一 key 的 Update 全局串行（每 key 一把锁），不同 key 并行；
//   - 读-改-写在锁内完成，调用方拿到的 cur 一定是最新值；
//   - Load/Save 泛型收发，JSON 样板消失。
//
// KV 接口隔离存储介质：生产实现对接 SQLite 的 app_state 表（httpapi 内约 30 行
// 适配器），测试用 MemKV。各业务文件（ideas/docsmeta/graph/citation_network…）
// 按对照文档的迁移顺序逐个换到本包，换完即删除各自的 load/replace 与配套锁。
package appstate

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// KV 是 app_state 表的最小抽象。两个方法都必须并发安全（生产实现由 SQLite
// 事务保证）；Get 的 exists 为 false 表示键不存在，与「存了空值」区分。
// updated_at 由适配器负责（沿用 nowStamp 约定）。
type KV interface {
	Get(ctx context.Context, key string) (data []byte, exists bool, err error)
	Put(ctx context.Context, key string, data []byte) error
}

// AtomicKV commits an update only if the read value is still current. A callback
// may be retried on conflict; it must not perform external writes or other effects.
type AtomicKV interface {
	Update(context.Context, string, func([]byte, bool) ([]byte, error)) error
}

// Store 是带每 key 锁的键值存取入口。零值不可用，必须经 New 创建。
type Store struct {
	kv    KV
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func New(kv KV) *Store {
	return &Store{kv: kv, locks: make(map[string]*sync.Mutex)}
}

func (s *Store) lockFor(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.locks[key]
	if !ok {
		l = &sync.Mutex{}
		s.locks[key] = l
	}
	return l
}

// Update 以读-改-写方式更新一个 key：同一 key 串行，fn 拿到的 cur 是锁内最新值。
// cur == nil && exists == false 表示键不存在；fn 返回 (nil, nil) 表示保持原值不动。
func (s *Store) Update(ctx context.Context, key string, fn func(cur []byte, exists bool) (next []byte, err error)) error {
	l := s.lockFor(key)
	l.Lock()
	defer l.Unlock()
	if kv, ok := s.kv.(AtomicKV); ok {
		return kv.Update(ctx, key, fn)
	}
	cur, exists, err := s.kv.Get(ctx, key)
	if err != nil {
		return fmt.Errorf("appstate: 读取 %s: %w", key, err)
	}
	next, err := fn(cur, exists)
	if err != nil {
		return err
	}
	if next == nil {
		return nil
	}
	if err := s.kv.Put(ctx, key, next); err != nil {
		return fmt.Errorf("appstate: 写入 %s: %w", key, err)
	}
	return nil
}

// Load 读出并反序列化一个 key。键不存在时返回零值和 false。
func Load[T any](ctx context.Context, s *Store, key string) (zero T, _ bool, _ error) {
	l := s.lockFor(key)
	l.Lock()
	defer l.Unlock()
	data, exists, err := s.kv.Get(ctx, key)
	if err != nil || !exists {
		return zero, false, err
	}
	if err := json.Unmarshal(data, &zero); err != nil {
		return zero, true, fmt.Errorf("appstate: 解析 %s: %w", key, err)
	}
	return zero, true, nil
}

// Save 序列化并写入一个 key（整包替换，语义与原 load/replace 一致）。
func Save[T any](ctx context.Context, s *Store, key string, v T) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("appstate: 序列化 %s: %w", key, err)
	}
	return s.Update(ctx, key, func([]byte, bool) ([]byte, error) { return data, nil })
}
