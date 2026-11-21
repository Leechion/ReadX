// Command server 是 ReadX 的本地后端：只绑定回环地址、每次启动随机 bearer token、
// SQLite 持久化，并把就绪信息（端口 + token）按行打印到 stdout 供 Electron 壳解析。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"cbctv2/server/internal/config"
	"cbctv2/server/internal/db"
	"cbctv2/server/internal/httpapi"
)

// minTokenLength 防止有人误传 "1" 这类 token 把鉴权变成装饰。
const minTokenLength = 32

type options struct {
	host           string
	port           int
	dataRoot       string
	token          string
	staticDir      string
	devInfoPath    string
	exitOnStdinEOF bool
}

func main() {
	log.SetPrefix("cbct-v2 server: ")
	log.SetFlags(log.Ltime)
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		log.Fatalf("启动失败: %v", err)
	}
}

// run 把全部启动逻辑做成可测函数：stdin/stdout 注入，便于测试就绪协议与 stdin 关闭停机。
func run(args []string, stdin io.Reader, stdout io.Writer) error {
	set := flag.NewFlagSet("server", flag.ContinueOnError)
	set.SetOutput(os.Stderr) // 就绪协议走 stdout，flag 报错绝不能混进去
	var o options
	set.StringVar(&o.host, "host", "127.0.0.1", "监听地址，只允许回环")
	set.IntVar(&o.port, "port", 0, "监听端口，0 表示让系统分配")
	set.StringVar(&o.dataRoot, "data-root", "", "数据根目录（默认使用 v2 仓库根目录，兼容已有 queue.json / papers/）")
	set.StringVar(&o.token, "token", os.Getenv("CBCT_SERVER_TOKEN"), "本地 bearer token，留空则随机生成")
	set.StringVar(&o.staticDir, "static", "", "前端构建产物目录（apps/web/dist），留空则只提供 API")
	set.StringVar(&o.devInfoPath, "dev-info", "", "把就绪信息写入该 JSON 文件，供 Vite dev proxy 读取")
	set.BoolVar(&o.exitOnStdinEOF, "exit-on-stdin-eof", false, "stdin 关闭（父进程退出）即停机，避免孤儿进程")
	if err := set.Parse(args); err != nil {
		return err
	}
	if set.NArg() > 0 {
		return fmt.Errorf("不接受位置参数: %v", set.Args())
	}

	host, err := config.NormalizeHost(o.host)
	if err != nil {
		return err
	}
	workingDir, err := os.Getwd()
	if err != nil {
		return err
	}
	root, err := config.ResolveDataRoot(o.dataRoot, workingDir)
	if err != nil {
		return err
	}
	token := o.token
	if token == "" {
		if token, err = config.NewToken(); err != nil {
			return err
		}
	} else if len(token) < minTokenLength {
		return fmt.Errorf("token 太短（%d < %d），请留空以随机生成", len(token), minTokenLength)
	}
	staticDir := ""
	if o.staticDir != "" {
		abs, err := filepath.Abs(o.staticDir)
		if err != nil {
			return err
		}
		if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
			return fmt.Errorf("静态目录不存在或不是目录：%s", abs)
		}
		staticDir = abs
	}

	cfg := config.Config{
		DataRoot:       root,
		Host:           host,
		Port:           o.port,
		Token:          token,
		StaticDir:      staticDir,
		DevInfoPath:    o.devInfoPath,
		ExitOnStdinEOF: o.exitOnStdinEOF,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	handle, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		return err
	}
	defer func() {
		if err := handle.Close(); err != nil {
			log.Printf("关闭数据库失败: %v", err)
		}
	}()

	listener, err := net.Listen("tcp", cfg.Addr())
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", cfg.Addr(), err)
	}
	var activeConns atomic.Int64
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return fmt.Errorf("监听地址不是 TCP: %s", listener.Addr().String())
	}
	cfg.Port = tcpAddr.Port

	apiServer := httpapi.New(cfg, handle)
	defer apiServer.CloseRealtime()
	defer apiServer.CloseCompanion()
	httpServer := &http.Server{
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      0, // SSE 流式响应需要不写死超时（S3 用），靠 ctx 取消收尾
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(os.Stderr, "http: ", log.Ltime),
		// ConnState 必须非 nil：没有它 http.Server 走「不跟踪连接」的快速路径，
		// Shutdown 就不会主动关闭空闲的 keep-alive 连接，本地客户端留下的池化连接
		// 会把退出拖到 IdleTimeout（2 分钟）——正是上一次测试里 5s 超时的原因。
		ConnState: func(_ net.Conn, state http.ConnState) {
			switch state {
			case http.StateNew, http.StateActive:
				activeConns.Add(1)
			case http.StateClosed, http.StateHijacked:
				activeConns.Add(-1)
			}
		},
	}

	serveErr := make(chan error, 1)
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	ready := map[string]any{
		"port":     tcpAddr.Port,
		"host":     host,
		"token":    token,
		"dataRoot": root,
		"dbPath":   cfg.DBPath(),
		"pid":      os.Getpid(),
	}
	// The launcher starts Vite as soon as it reads READY. Its credentials file
	// must already exist at that point, even on a slow Windows filesystem.
	if cfg.DevInfoPath != "" {
		if err := writeDevInfo(cfg.DevInfoPath, ready); err != nil {
			_ = httpServer.Close()
			return fmt.Errorf("写 dev-info 失败: %w", err)
		}
	}
	if err := emitReady(stdout, ready); err != nil {
		_ = httpServer.Shutdown(context.Background())
		return err
	}
	log.Printf("就绪：http://%s:%d（数据根 %s）", host, tcpAddr.Port, root)

	if cfg.ExitOnStdinEOF {
		go func() {
			// 丢弃式读取：父进程关闭管道即 EOF；父进程被杀同样让管道断开。
			_, _ = io.Copy(io.Discard, stdin)
			stop()
		}()
	}

	select {
	case <-ctx.Done():
		log.Print("收到退出信号，正在关闭")
	case err := <-serveErr:
		if err != nil {
			return fmt.Errorf("HTTP 服务异常: %w", err)
		}
	}

	shutdownStart := time.Now()
	apiServer.CloseRealtime()
	apiServer.CloseCompanion()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		// 本地应用退出优先于把连接用到自然结束：硬关监听并留下计数，方便定位卡住的请求。
		log.Printf("优雅关闭未完成（%v），强制关闭；当时活动连接 %d", err, activeConns.Load())
		if closeErr := httpServer.Close(); closeErr != nil {
			return fmt.Errorf("强制关闭 HTTP 服务失败: %w", closeErr)
		}
	}
	<-serveErr
	log.Printf("已关闭，退出耗时 %s", time.Since(shutdownStart).Round(time.Millisecond))
	return nil
}

// emitReady 打印单行 JSON 协议；Electron 主进程按 config.ReadyPrefix 前缀解析。
func emitReady(stdout io.Writer, payload map[string]any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("序列化就绪信息失败: %w", err)
	}
	buffered := bufio.NewWriter(stdout)
	if _, err := buffered.WriteString(config.ReadyPrefix); err != nil {
		return err
	}
	if _, err := buffered.Write(body); err != nil {
		return err
	}
	if err := buffered.WriteByte('\n'); err != nil {
		return err
	}
	return buffered.Flush()
}

// writeDevInfo 原子写入，避免 Vite 读到半截 JSON。
func writeDevInfo(path string, payload map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, append(body, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}
