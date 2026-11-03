.PHONY: setup build test install remote

setup:
	git config core.hooksPath .githooks

build:
	CGO_ENABLED=0 go -C hud build -trimpath -ldflags '-s -w' -o ../bin/herdr-hud ./cmd/herdr-hud

test:
	go -C hud test ./...
	node --test mods/*/*.test.mjs

install:
	./scripts/install.sh $(ARGS)

remote:
	./scripts/remote-install.sh $(ARGS)
