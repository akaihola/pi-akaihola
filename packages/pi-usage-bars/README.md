# @akaihola/pi-usage-bars

Pi extension that shows Claude quota usage bars in the status bar using Claude Code Mux OAuth tokens.

## Install

Install the published package:

```sh
pi install npm:@akaihola/pi-usage-bars
```

For local development in this repo:

```sh
pi install -l ./packages/pi-usage-bars
```

For a one-off smoke test without persisting settings:

```sh
pi -e ./packages/pi-usage-bars
```

## Notes

- Reads tokens from `~/.claude-code-mux/oauth_tokens.json`
- Refreshes Anthropic OAuth tokens automatically when needed
- Adds a `/usage` command to refresh and inspect the current quota state
