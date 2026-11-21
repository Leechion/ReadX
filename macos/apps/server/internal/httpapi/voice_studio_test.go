package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
)

func TestVoiceStudioCatalogSpeechAndRecording(t *testing.T) {
	wav := make([]byte, 46)
	copy(wav, "RIFF")
	copy(wav[8:], "WAVE")
	clip := bytes.Repeat([]byte{0x12}, 2000)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("ReadX credentials reached VoiceStudio")
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /.well-known/voicestudio-speech":
			_, _ = io.WriteString(w, `{"service":"VoiceStudio","protocol":"voicestudio.speech.v1"}`)
		case "GET /engines/tts":
			_, _ = io.WriteString(w, `{"active":"omnivoice","backends":[{"id":"omnivoice","available":true,"supports_cloning":true,"supports_voice_design":true},{"id":"kittentts","display_name":"KittenTTS","available":true,"preset_voices":["Bella","Jasper"]}]}`)
		case "GET /profiles":
			_, _ = io.WriteString(w, `[{"id":"own123","name":"Bella","language":"Auto","kind":"clone","audio_url":"/profiles/own123/audio","ref_text":"private"}]`)
		case "GET /profiles/own123":
			_, _ = io.WriteString(w, `{"id":"own123"}`)
		case "GET /archetypes":
			if r.URL.Query().Get("offset") == "0" {
				_, _ = io.WriteString(w, `{"total":2,"items":[{"id":"guide","name":"Guide","language":"English","is_featured":true}]}`)
			} else {
				_, _ = io.WriteString(w, `{"total":2,"items":[{"id":"teller","name":"Storyteller","language":"Chinese"}]}`)
			}
		case "GET /archetypes/guide":
			_, _ = io.WriteString(w, `{"id":"guide","instruct":"female, low pitch"}`)
		case "POST /v1/audio/speech":
			var input struct {
				Input          string  `json:"input"`
				Voice          string  `json:"voice"`
				Model          string  `json:"model"`
				Instruct       string  `json:"instruct"`
				ResponseFormat string  `json:"response_format"`
				Speed          float64 `json:"speed"`
				Seed           int     `json:"seed"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
				return
			}
			if input.Input != "你好，ReadX" || input.Model != "omnivoice" || input.Speed != 1.5 || input.ResponseFormat != "wav" {
				t.Errorf("unexpected speech request: %+v", input)
			}
			if input.Voice == "default" {
				if input.Instruct != "female, low pitch" || input.Seed != 42 {
					t.Errorf("designed voice was lost: %+v", input)
				}
			} else if input.Voice != "own123" {
				t.Errorf("recorded voice was not addressed by ID: %+v", input)
			}
			_, _ = w.Write(wav)
		case "POST /profiles":
			mic, header, err := r.FormFile("ref_audio")
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer mic.Close()
			defer r.MultipartForm.RemoveAll()
			recording, err := io.ReadAll(mic)
			if err != nil || !bytes.Equal(recording, clip) || header.Filename != "readx-voice.webm" ||
				r.FormValue("name") != "我的声音" || r.FormValue("ref_text") != "我是阅读者" || r.FormValue("kind") != "clone" {
				t.Error("reference audio or metadata changed in transit")
			}
			_, _ = io.WriteString(w, `{"id":"own123","name":"我的声音","language":"Auto"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	_, port, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	t.Setenv("READX_VOICESTUDIO_PORT", port)
	readx, _, _ := newTestServer(t, nil)
	const route = "/v1/voice-studio/"
	if res := do(t, readx, http.MethodGet, route+"voices", ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request got %d", res.StatusCode)
	}
	catalog := decode(t, do(t, readx, http.MethodGet, route+"voices", testToken))
	voices, ok := catalog["voices"].([]any)
	if !ok || len(voices) != 5 || catalog["cloneModel"] != "omnivoice" {
		t.Fatalf("unexpected catalog: %v", catalog)
	}
	if voices[2].(map[string]any)["id"] != "Jasper" || voices[3].(map[string]any)["featured"] != true {
		t.Fatalf("catalog did not retain real presets and featured designs: %v", catalog)
	}
	if _, exposed := voices[1].(map[string]any)["ref_text"]; exposed {
		t.Fatal("catalog exposes the private reference transcript")
	}
	post := func(path, contentType string, body io.Reader) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, readx.URL+route+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set("Content-Type", contentType)
		req.AddCookie(&http.Cookie{Name: "readx", Value: "private"})
		res, err := readx.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}
	for kind, id := range map[string]string{"design": "guide", "profile": "own123"} {
		body, _ := json.Marshal(map[string]any{"text": "你好，ReadX", "voice": id, "kind": kind, "model": "omnivoice", "rate": 1.5})
		res := post("speech", "application/json", bytes.NewReader(body))
		audio, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "audio/wav" || !bytes.Equal(wav, audio) {
			t.Fatalf("%s speech: HTTP %d %s", kind, res.StatusCode, audio)
		}
	}
	multipartBody := func(consent string) (*bytes.Buffer, string) {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		for key, value := range map[string]string{"name": "我的声音", "ref_text": "我是阅读者", "own_voice": consent} {
			if err := form.WriteField(key, value); err != nil {
				t.Fatal(err)
			}
		}
		part, err := form.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="ref_audio"; filename="blob"`},
			"Content-Type":        {"audio/webm;codecs=opus"},
		})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(clip)
		_ = form.Close()
		return &body, form.FormDataContentType()
	}
	body, mimeType := multipartBody("")
	if res := post("recordings", mimeType, body); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("recording without confirmation got %d", res.StatusCode)
	}
	body, mimeType = multipartBody("yes")
	result := post("recordings", mimeType, body)
	if result.StatusCode != http.StatusCreated || decode(t, result)["id"] != "own123" {
		t.Fatalf("recording failed: HTTP %d", result.StatusCode)
	}
	missing := post("speech", "application/json", strings.NewReader(`{"text":"test","voice":"deleted","kind":"profile","model":"omnivoice","rate":1}`))
	if missing.StatusCode != http.StatusBadGateway {
		t.Fatalf("deleted profile unexpectedly synthesized: %d", missing.StatusCode)
	}
}

func TestVoiceStudioDoesNotFollowRedirects(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("VoiceStudio redirect was followed")
	}))
	t.Cleanup(destination.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(upstream.Close)
	_, port, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	t.Setenv("READX_VOICESTUDIO_PORT", port)
	readx, _, _ := newTestServer(t, nil)
	res := do(t, readx, http.MethodGet, "/v1/voice-studio/voices", testToken)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unexpected upstream accepted: HTTP %d", res.StatusCode)
	}
}
