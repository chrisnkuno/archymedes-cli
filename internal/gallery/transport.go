package gallery

import (
	"bytes"
	"image/png"
	"io"
	"net/http"
	"strconv"
	"time"
)

// maxArtWidth bounds what a friday-art:// request may ask for: sharp on any screen, quick to draw.
const maxArtWidth = 2400

// HTTPClient is an HTTP client that also answers friday-art://<id>?w=<width> by drawing that
// generated picture as a PNG, 16:10. The Gallery loads full-resolution pictures through a URL
// fetcher; this lets generated ones go the same way as photographs, with no network. timeout 0
// means 15 seconds.
func HTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.RegisterProtocol(ArtScheme, artTransport{})
	return &http.Client{Transport: transport, Timeout: timeout}
}

type artTransport struct{}

func (artTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	p, ok := ByID(req.URL.Host)
	if !ok || !p.Generated() {
		return reply(req, http.StatusNotFound, "", nil), nil
	}
	width, err := strconv.Atoi(req.URL.Query().Get("w"))
	if err != nil || width <= 0 {
		width = 960
	}
	width = min(width, maxArtWidth)
	var buf bytes.Buffer
	if err := png.Encode(&buf, p.Art(width, width*10/16)); err != nil {
		return nil, err
	}
	return reply(req, http.StatusOK, "image/png", buf.Bytes()), nil
}

func reply(req *http.Request, status int, contentType string, body []byte) *http.Response {
	header := http.Header{}
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	return &http.Response{
		Status: http.StatusText(status), StatusCode: status, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: header, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: req,
	}
}
