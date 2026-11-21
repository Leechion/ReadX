package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/securefile"
)

type workBuddyLoginStatus struct {
	State   string `json:"state,omitempty"`
	URL     string `json:"url,omitempty"`
	Pending bool   `json:"pending"`
	Error   string `json:"error,omitempty"`
}

func (s *Server) workBuddyAuthPath() string {
	return ai.WorkBuddyCredentialPath(legacy.NewPaths(s.cfg.DataRoot).ConfigFile())
}

func (s *Server) workBuddyStatus() map[string]any {
	s.workBuddyLoginMu.Lock()
	defer s.workBuddyLoginMu.Unlock()
	login := s.workBuddyLogin
	// The account can be signed in before a provider and model are saved.
	credential, err := ai.LoadWorkBuddyCredential(s.workBuddyAuthPath())
	if err != nil && !login.Pending && login.Error == "" {
		login.Error = "无法读取 WorkBuddy 登录凭据，请重新登录"
	}
	return map[string]any{
		"authenticated": strings.TrimSpace(credential.AccessToken) != "",
		"nickname":      credential.Nickname,
		"expiresAt":     credential.ExpiresAt,
		"login":         login,
	}
}

func (s *Server) handleWorkBuddyLogin(w http.ResponseWriter, r *http.Request) {
	s.workBuddyLoginMu.Lock()
	current := s.workBuddyLogin
	s.workBuddyLoginMu.Unlock()
	if current.Pending {
		writeJSON(w, http.StatusOK, current)
		return
	}
	login, err := ai.BeginWorkBuddyLogin(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.workBuddyLoginMu.Lock()
	started := !s.workBuddyLogin.Pending
	if started {
		s.workBuddyLogin = workBuddyLoginStatus{State: login.State, URL: login.URL, Pending: true}
	}
	current = s.workBuddyLogin
	s.workBuddyLoginMu.Unlock()
	writeJSON(w, http.StatusOK, current)
	if started {
		go s.completeWorkBuddyLogin(login.State)
	}
}

func (s *Server) completeWorkBuddyLogin(state string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute+10*time.Second)
	defer cancel()
	credential, err := ai.WaitWorkBuddyLogin(ctx, state)
	s.workBuddyLoginMu.Lock()
	defer s.workBuddyLoginMu.Unlock()
	if s.workBuddyLogin.State != state {
		return
	}
	if err == nil {
		authPath := s.workBuddyAuthPath()
		err = ai.SaveWorkBuddyCredential(authPath, credential)
		if err == nil {
			err = securefile.RestrictToCurrentUser(filepath.Dir(authPath))
		}
		if err == nil {
			err = securefile.RestrictToCurrentUser(authPath)
		}
	}
	s.workBuddyLogin.Pending = false
	s.workBuddyLogin.URL = ""
	if err != nil {
		s.workBuddyLogin.Error = err.Error()
	} else {
		s.workBuddyLogin.Error = ""
	}
}

func (s *Server) handleWorkBuddyLoginStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.workBuddyStatus())
}

func (s *Server) handleWorkBuddyLogout(w http.ResponseWriter, r *http.Request) {
	s.workBuddyLoginMu.Lock()
	defer s.workBuddyLoginMu.Unlock()
	authPath := s.workBuddyAuthPath()
	if err := ai.DeleteWorkBuddyCredential(authPath); err != nil && !os.IsNotExist(err) {
		writeError(w, http.StatusInternalServerError, "清除 WorkBuddy 登录失败")
		return
	}
	s.workBuddyLogin = workBuddyLoginStatus{}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
}
