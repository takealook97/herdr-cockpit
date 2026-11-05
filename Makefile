.PHONY: setup build test install remote

setup:
	git config core.hooksPath .githooks

build:
	CGO_ENABLED=0 go -C hud build -trimpath -ldflags '-s -w' -o ../bin/herdr-hud ./cmd/herdr-hud

test:
	go -C hud test ./...
	node --test mods/*/*.test.mjs
	@if [ "$$(uname -s)" = Darwin ] && command -v swiftc >/dev/null 2>&1; then \
		bin=$$(mktemp /tmp/herdr-laugh-tests.XXXXXX) && \
		trap 'rm -f "$$bin"' EXIT && \
		swiftc hud/listen-macos/LaughFilter.swift hud/listen-macos/tests/LaughFilterTests.swift -o "$$bin" && "$$bin" && \
		swiftc hud/listen-macos/LaughFilter.swift hud/listen-macos/TranscriptKeeper.swift hud/listen-macos/tests/TranscriptKeeperTests.swift -o "$$bin" && "$$bin"; \
	fi

install:
	./scripts/install.sh $(ARGS)

remote:
	./scripts/remote-install.sh $(ARGS)
