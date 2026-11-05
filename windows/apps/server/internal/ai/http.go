package ai

import (
	"errors"
	"net/http"
	"strings"
)

// NewHTTPClient allows configured local model endpoints, but never forwards
// credentials to a different origin through an upstream redirect.
// Callers supply operation deadlines through the request context.
func NewHTTPClient() *http.Client {
	return &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("AI 服务重定向次数过多")
		}
		if len(via) > 0 && (!strings.EqualFold(req.URL.Scheme, via[0].URL.Scheme) || !strings.EqualFold(req.URL.Host, via[0].URL.Host)) {
			return errors.New("AI 服务不允许跨来源重定向，请直接配置目标服务地址")
		}
		return nil
	}}
}
