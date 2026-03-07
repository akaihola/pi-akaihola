# @akaihola/pi-session-meta

Pi extension that exposes the active session file path, UUID, slug, and a reusable metadata block.

## Install

Install the published package:

```sh
pi install npm:@akaihola/pi-session-meta
```

For local development in this repo:

```sh
pi install -l ./packages/pi-session-meta
```

For a one-off smoke test without persisting settings:

```sh
pi -e ./packages/pi-session-meta
```

## Commands

- `/session-meta` shows the current session metadata
- `/session-stamp` inserts a reusable session metadata block into the editor
