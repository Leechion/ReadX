//go:build windows

package httpapi

import (
	"net/http"
	"net/url"
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func sourceProxyForURL(target *url.URL) (*url.URL, bool) {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return nil, false
	}
	defer key.Close()
	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err != nil || enabled != 1 {
		return nil, false
	}
	value, _, err := key.GetStringValue("ProxyServer")
	if err != nil {
		return nil, false
	}
	proxy := strings.TrimSpace(value)
	if strings.Contains(proxy, "=") {
		proxy = ""
		for _, entry := range strings.Split(value, ";") {
			scheme, address, ok := strings.Cut(entry, "=")
			if ok && strings.EqualFold(strings.TrimSpace(scheme), target.Scheme) {
				proxy = strings.TrimSpace(address)
			}
		}
	}
	if proxy == "" {
		return nil, false
	}
	if !strings.Contains(proxy, "://") {
		proxy = "http://" + proxy
	}
	parsed, err := url.Parse(proxy)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "socks5") {
		return nil, false
	}
	return parsed, true
}

func sourceProxyFromEnvironment(request *http.Request) (*url.URL, error) {
	// ProxyFromEnvironment also reads process environment variables, not request
	// headers. If the caller explicitly configured one, preserve Go's NO_PROXY rules.
	if hasSourceProxyEnvironment() || strings.TrimSpace(os.Getenv("NO_PROXY")) != "" || strings.TrimSpace(os.Getenv("no_proxy")) != "" {
		return http.ProxyFromEnvironment(request)
	}
	proxy, _ := sourceProxyForURL(request.URL)
	return proxy, nil
}

func hasSourceProxyEnvironment() bool {
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return true
		}
	}
	return false
}
