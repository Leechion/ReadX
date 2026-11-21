package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"time"
)

const companionShareTTL = 4 * time.Hour

type lanCompanionState struct {
	listener  net.Listener
	srv       *http.Server
	token     string
	port      int
	urls      []string
	docCount  int
	startedAt time.Time
	expiresAt time.Time
	html      string
}

type lanShareStatus struct {
	Active    bool     `json:"active"`
	Port      int      `json:"port,omitempty"`
	Token     string   `json:"token,omitempty"`
	URLs      []string `json:"urls,omitempty"`
	DocCount  int      `json:"docCount,omitempty"`
	StartedAt string   `json:"startedAt,omitempty"`
	ExpiresAt string   `json:"expiresAt,omitempty"`
}

func (s *Server) handleLANShare(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.companionMu.Lock()
		state := s.currentCompanionLocked()
		status := state.toStatus()
		s.companionMu.Unlock()
		writeJSON(w, http.StatusOK, status)
	case http.MethodPost:
		var body readonlyShareRequest
		if decodeJSON(w, r, &body) != nil {
			return
		}
		html, statusCode, errMsg := s.buildReadonlyShareHTML(r.Context(), body)
		if errMsg != "" {
			writeError(w, statusCode, errMsg)
			return
		}
		state, err := startLANCompanion(body.Keys, html)
		if err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("启动局域网伴侣服务失败: %v", err))
			return
		}
		s.companionMu.Lock()
		prev := s.companion
		s.companion = state
		status := state.toStatus()
		s.companionMu.Unlock()
		if prev != nil {
			prev.close()
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodDelete:
		s.CloseCompanion()
		writeJSON(w, http.StatusOK, lanShareStatus{Active: false})
	default:
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / POST / DELETE")
	}
}

// CloseCompanion 关闭当前活动的局域网只读伴侣服务（应用退出时调用）。
func (s *Server) CloseCompanion() {
	s.companionMu.Lock()
	state := s.companion
	s.companion = nil
	s.companionMu.Unlock()
	if state != nil {
		state.close()
	}
}

func (s *Server) currentCompanionLocked() *lanCompanionState {
	if s.companion == nil {
		return nil
	}
	if time.Now().UTC().After(s.companion.expiresAt) {
		expired := s.companion
		s.companion = nil
		go expired.close()
		return nil
	}
	return s.companion
}

func (c *lanCompanionState) toStatus() lanShareStatus {
	if c == nil {
		return lanShareStatus{Active: false}
	}
	return lanShareStatus{
		Active:    true,
		Port:      c.port,
		Token:     c.token,
		URLs:      append([]string(nil), c.urls...),
		DocCount:  c.docCount,
		StartedAt: c.startedAt.UTC().Format(time.RFC3339),
		ExpiresAt: c.expiresAt.UTC().Format(time.RFC3339),
	}
}

func (c *lanCompanionState) close() {
	if c == nil {
		return
	}
	if c.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = c.srv.Shutdown(ctx)
		cancel()
	}
	if c.listener != nil {
		_ = c.listener.Close()
	}
}

func startLANCompanion(keys []string, html string) (*lanCompanionState, error) {
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw[:])

	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return nil, err
	}
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return nil, errors.New("无法解析局域网监听端口")
	}

	now := time.Now().UTC()
	state := &lanCompanionState{
		listener:  listener,
		token:     token,
		port:      tcpAddr.Port,
		urls:      buildLANCompanionURLs(tcpAddr.Port, token),
		docCount:  countUniqueKeys(keys),
		startedAt: now,
		expiresAt: now.Add(companionShareTTL),
		html:      html,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		if time.Now().UTC().After(state.expiresAt) {
			http.Error(w, "此次局域网只读分享已过期", http.StatusGone)
			return
		}
		provided := r.URL.Query().Get("token")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(state.token)) != 1 {
			http.Error(w, "缺少或无效的访问口令", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		_, _ = fmt.Fprint(w, state.html)
	})

	state.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		if serveErr := state.srv.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			_ = serveErr
		}
	}()
	return state, nil
}

func buildLANCompanionURLs(port int, token string) []string {
	ifaces, err := net.Interfaces()
	ips := []string{}
	seen := map[string]bool{}
	if err == nil {
		for _, iface := range ifaces {
			if (iface.Flags&net.FlagUp) == 0 || (iface.Flags&net.FlagLoopback) != 0 {
				continue
			}
			addrs, addrErr := iface.Addrs()
			if addrErr != nil {
				continue
			}
			for _, addr := range addrs {
				var ip net.IP
				switch v := addr.(type) {
				case *net.IPNet:
					ip = v.IP
				case *net.IPAddr:
					ip = v.IP
				}
				if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
					continue
				}
				v4 := ip.To4()
				if v4 == nil {
					continue
				}
				str := v4.String()
				if !seen[str] {
					seen[str] = true
					ips = append(ips, str)
				}
			}
		}
	}
	sort.Strings(ips)
	if len(ips) == 0 {
		ips = append(ips, "127.0.0.1")
	}
	urls := make([]string, 0, len(ips))
	for _, ip := range ips {
		urls = append(urls, fmt.Sprintf("http://%s:%d/?token=%s", ip, port, token))
	}
	return urls
}

func countUniqueKeys(keys []string) int {
	seen := map[string]bool{}
	for _, k := range keys {
		if k != "" {
			seen[k] = true
		}
	}
	return len(seen)
}
