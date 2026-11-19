package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"
)

const (
	linearMCPProtocol  = "2025-06-18"
	linearMCPPageLimit = 3
)

// linearMCPEndpointOverride replaces the MCP URL in tests only. The credential's
// serverUrl is still validated before any request is made.
var linearMCPEndpointOverride string

var linearMCPIssueFields = []string{"id", "title", "status", "statusType", "priority", "team", "project", "dueDate", "url", "updatedAt"}

type mcpSession struct {
	client   *http.Client
	url      string
	token    string
	protocol string
	session  string
	nextID   int
}

type mcpMessage struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func newMCPSession(cred linearCred) (*mcpSession, error) {
	if cred.Source != linearSourceClaudeMCP || cred.Secret == "" || !linearValidMCPURL(cred.ServerURL) {
		return nil, linearError(linearErrNotConnected)
	}
	endpoint := cred.ServerURL
	if linearMCPEndpointOverride != "" {
		endpoint = linearMCPEndpointOverride
	}
	return &mcpSession{client: linearClient(), url: endpoint, token: cred.Secret}, nil
}

// start runs initialize and notifications/initialized.
func (s *mcpSession) start(ctx context.Context) error {
	result, err := s.call(ctx, "initialize", map[string]any{
		"protocolVersion": linearMCPProtocol,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "herdr-hud", "version": "1"},
	})
	if err != nil {
		return err
	}
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(result, &init)
	s.protocol = linearMCPProtocol
	if linearHeaderToken(init.ProtocolVersion) {
		s.protocol = init.ProtocolVersion
	}
	_, err = s.post(ctx, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, 0)
	return err
}

func linearHeaderToken(v string) bool {
	if v == "" || len(v) > 40 {
		return false
	}
	for _, r := range v {
		if r > unicode.MaxASCII || !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '.' || r == '_') {
			return false
		}
	}
	return true
}

func (s *mcpSession) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	s.nextID++
	body := map[string]any{"jsonrpc": "2.0", "id": s.nextID, "method": method}
	if params != nil {
		body["params"] = params
	}
	return s.post(ctx, body, s.nextID)
}

// post sends one JSON-RPC message. wantID 0 means a notification: no response
// body is required.
func (s *mcpSession) post(ctx context.Context, body map[string]any, wantID int) (json.RawMessage, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, linearError(linearErrBadResponse)
	}
	ctx, cancel := context.WithTimeout(ctx, linearRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(raw))
	if err != nil {
		return nil, linearError(linearErrBadResponse)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+s.token)
	if s.protocol != "" {
		req.Header.Set("MCP-Protocol-Version", s.protocol)
	}
	if s.session != "" {
		req.Header.Set("Mcp-Session-Id", s.session)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if id := resp.Header.Get("Mcp-Session-Id"); s.session == "" && linearSessionID(id) {
		s.session = id
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, linearError(linearErrExpired)
	case resp.StatusCode == http.StatusForbidden:
		return nil, linearError(linearErrForbidden)
	case resp.StatusCode >= 500:
		return nil, linearError(linearErrNetwork)
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return nil, linearError(linearErrBadResponse)
	}
	if wantID == 0 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, linearMaxBody))
		return nil, nil
	}
	var msg mcpMessage
	if strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		msg, err = linearSSEFind(resp.Body, wantID)
	} else {
		msg, err = linearJSONFind(resp.Body, wantID)
	}
	if err != nil {
		return nil, err
	}
	if len(msg.Error) > 0 && string(msg.Error) != "null" {
		return nil, linearError(linearErrBadResponse)
	}
	return msg.Result, nil
}

// Session ids must be visible ASCII to be echoed back as a header.
func linearSessionID(v string) bool {
	if v == "" || len(v) > 256 {
		return false
	}
	for _, r := range v {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func linearIDMatches(raw json.RawMessage, want int) bool {
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String() == strconv.Itoa(want)
	}
	var s string
	return json.Unmarshal(raw, &s) == nil && s == strconv.Itoa(want)
}

func linearPickMessage(raw []byte, want int) (mcpMessage, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return mcpMessage{}, false
	}
	var batch []mcpMessage
	if raw[0] == '[' {
		if json.Unmarshal(raw, &batch) != nil {
			return mcpMessage{}, false
		}
	} else {
		var one mcpMessage
		if json.Unmarshal(raw, &one) != nil {
			return mcpMessage{}, false
		}
		batch = []mcpMessage{one}
	}
	for _, msg := range batch {
		if linearIDMatches(msg.ID, want) {
			return msg, true
		}
	}
	return mcpMessage{}, false
}

func linearJSONFind(r io.Reader, want int) (mcpMessage, error) {
	raw, err := linearReadBody(r)
	if err != nil {
		return mcpMessage{}, err
	}
	if msg, ok := linearPickMessage(raw, want); ok {
		return msg, nil
	}
	return mcpMessage{}, linearError(linearErrBadResponse)
}

// linearSSEFind reads complete SSE events until the one answering want; it
// stops there instead of waiting for the stream to close.
func linearSSEFind(r io.Reader, want int) (mcpMessage, error) {
	reader := bufio.NewReader(&linearLimitedReader{r: r})
	var data []string
	for {
		line, err := reader.ReadString('\n')
		// The size limit wins over anything read alongside it, so no event that
		// ends past the cap is ever dispatched.
		if errors.As(err, new(linearError)) {
			return mcpMessage{}, err
		}
		if err != nil && line == "" {
			if len(data) > 0 {
				if msg, ok := linearPickMessage([]byte(strings.Join(data, "\n")), want); ok {
					return msg, nil
				}
			}
			if errors.Is(err, io.EOF) {
				return mcpMessage{}, linearError(linearErrBadResponse)
			}
			return mcpMessage{}, linearError(linearErrNetwork)
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if len(data) > 0 {
				if msg, ok := linearPickMessage([]byte(strings.Join(data, "\n")), want); ok {
					return msg, nil
				}
			}
			data = data[:0]
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
}

type mcpTool struct {
	Name        string `json:"name"`
	InputSchema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	} `json:"inputSchema"`
}

func (s *mcpSession) tools(ctx context.Context) (map[string]mcpTool, error) {
	result, err := s.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var body struct {
		Tools []mcpTool `json:"tools"`
	}
	if json.Unmarshal(result, &body) != nil {
		return nil, linearError(linearErrBadResponse)
	}
	tools := map[string]mcpTool{}
	for _, tool := range body.Tools {
		tools[tool.Name] = tool
	}
	return tools, nil
}

// callTool returns the JSON document carried in the tool result's text content.
func (s *mcpSession) callTool(ctx context.Context, name string, args map[string]any) (json.RawMessage, error) {
	result, err := s.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	var body struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Structured json.RawMessage `json:"structuredContent"`
	}
	if json.Unmarshal(result, &body) != nil || body.IsError {
		return nil, linearError(linearErrBadResponse)
	}
	for _, item := range body.Content {
		text := strings.TrimSpace(item.Text)
		if item.Type == "text" && strings.HasPrefix(text, "{") && json.Valid([]byte(text)) {
			return json.RawMessage(text), nil
		}
	}
	if len(body.Structured) > 0 && body.Structured[0] == '{' {
		return body.Structured, nil
	}
	return nil, linearError(linearErrBadResponse)
}

type linearIdentity struct {
	UserName string
	OrgName  string
	OrgURL   string
}

func (s *mcpSession) whoami(ctx context.Context) (linearIdentity, error) {
	raw, err := s.callTool(ctx, "whoami", map[string]any{})
	if err != nil {
		return linearIdentity{}, err
	}
	var body struct {
		User struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
		} `json:"user"`
		Workspace struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"workspace"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return linearIdentity{}, linearError(linearErrBadResponse)
	}
	id := linearIdentity{UserName: body.User.Name, OrgName: body.Workspace.Name, OrgURL: linearOrgURLFromURL(body.Workspace.URL)}
	if id.UserName == "" {
		id.UserName = body.User.DisplayName
	}
	return id, nil
}

// linearMCPWhoami performs a full handshake and whoami only.
func linearMCPWhoami(ctx context.Context, cred linearCred) (linearIdentity, error) {
	s, err := newMCPSession(cred)
	if err != nil {
		return linearIdentity{}, err
	}
	if err := s.start(ctx); err != nil {
		return linearIdentity{}, err
	}
	return s.whoami(ctx)
}

type mcpIssuePage struct {
	Issues []struct {
		ID         string          `json:"id"`
		Title      string          `json:"title"`
		Status     string          `json:"status"`
		StatusType string          `json:"statusType"`
		Priority   json.RawMessage `json:"priority"`
		Project    json.RawMessage `json:"project"`
		DueDate    *string         `json:"dueDate"`
		URL        string          `json:"url"`
		UpdatedAt  string          `json:"updatedAt"`
	} `json:"issues"`
	HasNextPage bool   `json:"hasNextPage"`
	Cursor      string `json:"cursor"`
}

// linearMCPIssues fetches the viewer's issues. On a later-page failure it
// returns the pages already read together with the error.
func linearMCPIssues(ctx context.Context, cred linearCred) (linearIssuesPayload, error) {
	out := linearIssuesPayload{Source: strPtr(linearSourceClaudeMCP), Issues: []linearIssue{}}
	s, err := newMCPSession(cred)
	if err != nil {
		return out, err
	}
	if err := s.start(ctx); err != nil {
		return out, err
	}
	tools, err := s.tools(ctx)
	if err != nil {
		return out, err
	}
	list, ok := tools["list_issues"]
	if !ok || list.InputSchema.Properties["assignee"] == nil {
		return out, linearError(linearErrBadResponse)
	}
	if _, ok := tools["whoami"]; ok {
		// Only status treats whoami as best effort; a failed issues fetch is never cached.
		id, err := s.whoami(ctx)
		if err != nil {
			return out, err
		}
		if id.OrgURL != "" {
			out.OrgURL = strPtr(id.OrgURL)
		}
	}
	cursor := ""
	for page := 0; page < linearMCPPageLimit; page++ {
		args := linearMCPListArgs(list, cursor)
		raw, err := s.callTool(ctx, "list_issues", args)
		if err != nil {
			return out, err
		}
		var body mcpIssuePage
		if json.Unmarshal(raw, &body) != nil || body.Issues == nil {
			return out, linearError(linearErrBadResponse)
		}
		for _, item := range body.Issues {
			issue, ok := linearNormalize(linearRawIssue{
				Identifier: item.ID, Title: item.Title, URL: item.URL, Status: item.Status, StatusType: item.StatusType,
				Priority: linearMCPPriority(item.Priority), Project: linearMCPProject(item.Project), DueDate: item.DueDate, UpdatedAt: item.UpdatedAt,
			})
			if ok {
				out.Issues = append(out.Issues, issue)
			}
		}
		if !body.HasNextPage || body.Cursor == "" || list.InputSchema.Properties["cursor"] == nil {
			break
		}
		cursor = body.Cursor
	}
	return out, nil
}

// linearMCPListArgs passes only arguments advertised by the tool's inputSchema.
func linearMCPListArgs(tool mcpTool, cursor string) map[string]any {
	want := map[string]any{"assignee": "me", "limit": 100, "orderBy": "updatedAt", "fields": linearMCPIssueFields}
	if cursor != "" {
		want["cursor"] = cursor
	}
	args := map[string]any{}
	for key, value := range want {
		if tool.InputSchema.Properties[key] != nil {
			args[key] = value
		}
	}
	return args
}

func linearMCPPriority(raw json.RawMessage) float64 {
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var obj struct {
		Value float64 `json:"value"`
	}
	_ = json.Unmarshal(raw, &obj)
	return obj.Value
}

func linearMCPProject(raw json.RawMessage) *string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return linearOptional(s)
	}
	var obj struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return linearOptional(obj.Name)
	}
	return nil
}
