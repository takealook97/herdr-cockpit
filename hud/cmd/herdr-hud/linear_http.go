package main

import (
	"errors"
	"io"
	"net/http"
	"time"
)

// Fixed public error codes. Nothing else (bodies, URLs, headers, stderr) is ever
// reported, so a response that echoes credentials cannot reach the output.
const (
	linearErrNotConnected = "not_connected"
	linearErrExpired      = "expired"
	linearErrForbidden    = "forbidden"
	linearErrNetwork      = "network"
	linearErrBadResponse  = "bad_response"
	linearErrInvalidKey   = "invalid_key"
	linearErrStoreFailed  = "store_failed"
	// linearErrBusy: the credential lock was unavailable, so nothing was read.
	linearErrBusy = "busy"
)

const (
	linearRequestTimeout = 10 * time.Second
	linearMaxBody        = 4 << 20
)

type linearError string

func (e linearError) Error() string { return string(e) }

var errLinearRedirect = errors.New("linear: redirect refused")

// linearHTTPTransport is a test seam; nil uses the default transport.
var linearHTTPTransport http.RoundTripper

// linearClient never follows redirects, so an Authorization header is only ever
// sent to the validated endpoint.
func linearClient() *http.Client {
	return &http.Client{
		Transport:     linearHTTPTransport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errLinearRedirect },
	}
}

// linearCode maps any error to a fixed public code.
func linearCode(err error) string {
	var code linearError
	switch {
	case err == nil:
		return ""
	case errors.As(err, &code):
		return string(code)
	case errors.Is(err, errLinearRedirect):
		return linearErrBadResponse
	}
	return linearErrNetwork
}

// linearReadBody reads at most linearMaxBody bytes; larger bodies are rejected.
func linearReadBody(r io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, linearMaxBody+1))
	if err != nil {
		return nil, linearError(linearErrNetwork)
	}
	if len(raw) > linearMaxBody {
		return nil, linearError(linearErrBadResponse)
	}
	return raw, nil
}

// linearLimitedReader delivers at most linearMaxBody bytes. Once the cap is
// reached, any further byte yields the limit error without the byte itself, so
// a buffered reader can never hand out data past the cap.
type linearLimitedReader struct {
	r io.Reader
	n int
}

func (l *linearLimitedReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	remaining := linearMaxBody - l.n
	if remaining <= 0 {
		var probe [1]byte
		n, err := l.r.Read(probe[:])
		if n > 0 {
			return 0, linearError(linearErrBadResponse)
		}
		return 0, err
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	n, err := l.r.Read(p)
	l.n += n
	return n, err
}
