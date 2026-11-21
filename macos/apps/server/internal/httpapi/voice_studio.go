package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxVoiceRecording = 6 << 20

// ReadX sends text and reference recordings only to the local VoiceStudio
// service. Do not forward browser cookies, bearer tokens, proxy or redirect.
var voiceStudioHTTP = &http.Client{
	Transport: &http.Transport{
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

type studioVoice struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Language string `json:"language,omitempty"`
	Kind     string `json:"kind"`
	Model    string `json:"model,omitempty"`
	Engine   string `json:"engine,omitempty"`
	Featured bool   `json:"featured,omitempty"`
}

type studioEngine struct {
	ID      string   `json:"id"`
	Name    string   `json:"display_name"`
	Ready   bool     `json:"available"`
	Clone   bool     `json:"supports_cloning"`
	Design  bool     `json:"supports_voice_design"`
	Presets []string `json:"preset_voices"`
}

type studioEngines struct {
	Active   string         `json:"active"`
	Backends []studioEngine `json:"backends"`
}

type studioDesign struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Language string `json:"language"`
	Instruct string `json:"instruct"`
	Featured bool   `json:"is_featured"`
}

type voiceStudioService string

func localVoiceStudio(ctx context.Context) (voiceStudioService, error) {
	port := os.Getenv("READX_VOICESTUDIO_PORT")
	if port == "" {
		port = "3900"
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil || number == 0 {
		return "", errors.New("VoiceStudio 端口无效")
	}
	service := voiceStudioService(fmt.Sprintf("http://127.0.0.1:%d", number))
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var identity struct {
		Service  string `json:"service"`
		Protocol string `json:"protocol"`
	}
	err = service.get(probeCtx, "/.well-known/voicestudio-speech", &identity)
	if err != nil || identity.Service != "VoiceStudio" || identity.Protocol != "voicestudio.speech.v1" {
		return "", fmt.Errorf("无法连接本机 VoiceStudio（端口 %d）。请启动 VoiceStudio，等模型服务就绪后重试", number)
	}
	return service, nil
}

func (s voiceStudioService) call(ctx context.Context, method, path, contentType string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, string(s)+path, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := voiceStudioHTTP.Do(req)
	if err != nil {
		return nil, errors.New("VoiceStudio 未响应，请检查本机服务后重试")
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return res, nil
	}
	defer res.Body.Close()
	var failure struct {
		Detail string `json:"detail"`
		Error  struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 8<<10)).Decode(&failure)
	if failure.Error.Code == "model_licence_required" {
		return nil, errors.New("请先在 VoiceStudio 的模型目录中查看并确认模型许可，再回到 ReadX 朗读")
	}
	if failure.Error.Message != "" {
		failure.Detail = failure.Error.Message
	}
	if failure.Detail != "" {
		return nil, fmt.Errorf("VoiceStudio：%.700s", failure.Detail)
	}
	return nil, fmt.Errorf("VoiceStudio 请求失败（HTTP %d）", res.StatusCode)
}

func (s voiceStudioService) get(ctx context.Context, path string, target any) error {
	res, err := s.call(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return decodeStudioJSON(res.Body, target)
}

func decodeStudioJSON(body io.Reader, target any) error {
	if err := json.NewDecoder(io.LimitReader(body, 4<<20)).Decode(target); err != nil {
		return errors.New("无法读取 VoiceStudio 的响应")
	}
	return nil
}

func (e studioEngines) compatibleModel(supports func(studioEngine) bool) string {
	var fallback string
	for _, backend := range e.Backends {
		if !backend.Ready || !supports(backend) {
			continue
		}
		if backend.ID == e.Active {
			return backend.ID
		}
		// The OpenAI compatibility route resolves bare "omnivoice" to the
		// active engine. Use a distinct engine ID for an inactive fallback.
		if fallback == "" && backend.ID != "omnivoice" {
			fallback = backend.ID
		}
	}
	return fallback
}

func (s *Server) handleVoiceStudioVoices(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	studio, err := localVoiceStudio(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	var engines studioEngines
	if err := studio.get(ctx, "/engines/tts", &engines); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	clone := engines.compatibleModel(func(e studioEngine) bool { return e.Clone })
	design := engines.compatibleModel(func(e studioEngine) bool {
		return e.Design && (e.ID == "omnivoice" || strings.HasPrefix(e.ID, "omnivoice-"))
	})
	var profiles []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Language string `json:"language"`
		Kind     string `json:"kind"`
		AudioURL string `json:"audio_url"`
	}
	if err := studio.get(ctx, "/profiles", &profiles); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	voices := []studioVoice{{ID: "default", Name: "VoiceStudio 默认", Kind: "default", Model: "tts-1"}}
	occupied := strings.Fields("default alloy ash ballad cedar coral echo fable marin nova onyx sage shimmer verse")
	for _, profile := range profiles {
		model := clone
		if profile.Kind == "design" && profile.AudioURL == "" {
			model = design
		}
		voices = append(voices, studioVoice{ID: profile.ID, Name: profile.Name, Language: profile.Language, Kind: "profile", Model: model})
		occupied = append(occupied, profile.ID, profile.Name)
	}
	for _, engine := range engines.Backends {
		if !engine.Ready {
			continue
		}
		for _, name := range engine.Presets {
			conflict := false
			for _, other := range occupied {
				if strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(other)) {
					conflict = true
					break
				}
			}
			if !conflict {
				voices = append(voices, studioVoice{ID: name, Name: name, Kind: "preset", Model: engine.ID, Engine: engine.Name})
			}
		}
	}
	for offset := 0; ; {
		var page struct {
			Total int            `json:"total"`
			Items []studioDesign `json:"items"`
		}
		if err := studio.get(ctx, fmt.Sprintf("/archetypes?limit=500&offset=%d", offset), &page); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		for _, voice := range page.Items {
			voices = append(voices, studioVoice{ID: voice.ID, Name: voice.Name, Language: voice.Language, Kind: "design", Model: design, Featured: voice.Featured})
		}
		offset += len(page.Items)
		if offset >= page.Total || len(page.Items) == 0 || offset >= 5000 {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"voices": voices, "cloneModel": clone})
}

func (s *Server) handleVoiceStudioSpeech(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text  string  `json:"text"`
		Kind  string  `json:"kind"`
		Voice string  `json:"voice"`
		Model string  `json:"model"`
		Rate  float64 `json:"rate"`
	}
	if decodeJSONLimit(w, r, &body, 32<<10) != nil {
		return
	}
	body.Text = strings.TrimSpace(body.Text)
	if body.Text == "" || utf8.RuneCountInString(body.Text) > 1200 ||
		strings.TrimSpace(body.Voice) == "" || len(body.Voice) > 256 || !validStudioID(body.Model) ||
		body.Rate < 0.5 || body.Rate > 2 ||
		(body.Kind != "default" && body.Kind != "profile" && body.Kind != "design" && body.Kind != "preset") {
		writeError(w, http.StatusBadRequest, "朗读文本、音色或语速超出支持范围")
		return
	}
	if (body.Kind == "design" || body.Kind == "profile") && !validStudioID(body.Voice) {
		writeError(w, http.StatusBadRequest, "VoiceStudio 音色编号无效")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	studio, err := localVoiceStudio(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	payload := map[string]any{"input": body.Text, "voice": body.Voice, "model": body.Model, "speed": body.Rate, "response_format": "wav"}
	if body.Kind == "design" {
		var voice studioDesign
		if err := studio.get(ctx, "/archetypes/"+body.Voice, &voice); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		payload["voice"], payload["instruct"], payload["seed"] = "default", voice.Instruct, 42
	} else if body.Kind == "profile" {
		// Make sure a deleted profile cannot silently become a default voice.
		var profile struct {
			ID string `json:"id"`
		}
		if err := studio.get(ctx, "/profiles/"+body.Voice, &profile); err != nil || profile.ID != body.Voice {
			writeError(w, http.StatusBadGateway, "这个 VoiceStudio 音色已不可用。请刷新列表后重选")
			return
		}
	}
	data, _ := json.Marshal(payload)
	res, err := studio.call(ctx, http.MethodPost, "/v1/audio/speech", "application/json", bytes.NewReader(data))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer res.Body.Close()
	const maxSpeech = 24 << 20
	sound, err := io.ReadAll(io.LimitReader(res.Body, maxSpeech+1))
	if err != nil || len(sound) < 44 || len(sound) > maxSpeech ||
		string(sound[:4]) != "RIFF" || string(sound[8:12]) != "WAVE" {
		writeError(w, http.StatusBadGateway, "VoiceStudio 未返回可播放的 WAV 音频")
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(sound)
}

func validStudioID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, char := range id {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

func (s *Server) handleVoiceStudioRecording(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxVoiceRecording+(16<<10))
	if err := r.ParseMultipartForm(maxVoiceRecording + (16 << 10)); err != nil {
		writeError(w, http.StatusBadRequest, "录音无法读取或超过 6 MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	name := strings.TrimSpace(r.FormValue("name"))
	text := strings.TrimSpace(r.FormValue("ref_text"))
	if r.PostFormValue("own_voice") != "yes" || name == "" || utf8.RuneCountInString(name) > 60 || text == "" || utf8.RuneCountInString(text) > 600 {
		writeError(w, http.StatusBadRequest, "请确认录制的是自己的声音，并填写音色名称和录音原文")
		return
	}
	recording, header, err := r.FormFile("ref_audio")
	if err != nil {
		writeError(w, http.StatusBadRequest, "缺少录音")
		return
	}
	defer recording.Close()
	mediaType, _, _ := mime.ParseMediaType(header.Header.Get("Content-Type"))
	extensions := map[string]string{"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/wav": ".wav"}
	ext := extensions[mediaType]
	if ext == "" || header.Size < 1000 || header.Size > maxVoiceRecording {
		writeError(w, http.StatusBadRequest, "录音格式不支持、太短或超过 6 MB")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	studio, err := localVoiceStudio(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	var upload bytes.Buffer
	form := multipart.NewWriter(&upload)
	if err := writeStudioRecording(form, name, text, ext, recording); err != nil {
		writeError(w, http.StatusBadRequest, "无法读取录音")
		return
	}
	res, err := studio.call(ctx, http.MethodPost, "/profiles", form.FormDataContentType(), &upload)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer res.Body.Close()
	var profile studioVoice
	if err := decodeStudioJSON(res.Body, &profile); err != nil || !validStudioID(profile.ID) {
		writeError(w, http.StatusBadGateway, "无法确认新音色是否保存。请刷新音色列表")
		return
	}
	profile.Kind = "profile"
	writeJSON(w, http.StatusCreated, profile)
}

func writeStudioRecording(form *multipart.Writer, name, text, ext string, recording io.Reader) error {
	for key, value := range map[string]string{"name": name, "ref_text": text, "kind": "clone"} {
		if err := form.WriteField(key, value); err != nil {
			return err
		}
	}
	part, err := form.CreateFormFile("ref_audio", "readx-voice"+ext)
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, recording); err != nil {
		return err
	}
	return form.Close()
}
