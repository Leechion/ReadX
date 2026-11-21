//go:build !windows

package httpapi

import (
	"net/http"
	"net/url"
)

func sourceProxyForURL(_ *url.URL) (*url.URL, bool) { return nil, false }
func sourceProxyFromEnvironment(request *http.Request) (*url.URL, error) {
	return http.ProxyFromEnvironment(request)
}
