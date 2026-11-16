# @cosplaying/errors

Private workspace package. Import it as `cosplaying/errors`.

## What it does

Re-exports `LayerError`, `MCPLayerError`, `docs`, and `hashtag` from `@mcp-layer/error`. A user-facing failure throws `LayerError`. The explanation is the `message`. The call also passes `scope`, `docs`, `args`, and `cause`.

## Scope

In scope: those four exports. `LayerError` builds `scope/name(method): ` plus the message, then a link from `docs` and `hashtag`. This repo passes `scope` `cosplaying` and `docs` `github.com/3rd-Eden/cosplay/tree/main/packages`. `name` is the slug in that link. `method` is the function that failed. `message` states what happened, the bad value, and the next action. `args` fills each `%s`. `cause` is the caught error.

The wording of `message` stays at the throw site. This package does not add a support-channel line. `@cosplaying/adapters` writes the Pi and OpenCode extension files, and those files throw a plain `Error`. They do not import this package.

## Public API

- `LayerError` and `MCPLayerError` are the same class. `new LayerError({ name, method, message, scope, docs, args, cause })` sets `error.name` to `LayerError`. `error.package` is `scope/name` when `name` has no `@` prefix, and `name` when it does. `error.method` is `method`. The thrown message is `error.package(method): ` plus `message` after replacement, a blank line, and `For more information visit: ` plus the docs URL. `cause` is `error.cause`. Any other field is copied onto the error. Omitted `scope` is `@mcp-layer`. Omitted `docs` is `github.com/3rd-Eden/mcp-layer/tree/main/packages`.
- `args` replaces each `%s` in order. `vars` replaces `{key}` from that object when it has keys, before `args`. Callers in this repo pass `args`.
- `hashtag(text)` returns `#` and six uppercase hex digits from the sine color hash of `text`.
- `docs({ name, method, message, docs, scope })` returns the URL `LayerError` stores on `error.docs`. The base is `docs` when it starts with `http://` or `https://`, and `https://` plus `docs` otherwise. The path is that base, the slug, and `README.md`. The slug is `name`. When `name` starts with `@`, the slug is the segment after `/`, or `name` without `@` when that segment is missing. The fragment is `#error-` plus the lowercase hashtag of `name`, `method`, and the message template joined by `-`. `error.reference` is `#` plus those six digits in uppercase.

## Related packages

`@mcp-layer/error` implements the class, the hashtag, and the docs URL. `@cosplaying/cli`, `@cosplaying/hooks`, `@cosplaying/plugin`, and `@cosplaying/attribution` import `LayerError` from `@mcp-layer/error` and construct it with this repo's `scope`, `docs`, `args`, and `cause`. `@cosplaying/adapters` does not throw `LayerError`. Its Pi and OpenCode files tell the model to retry through `cosplaying hook` with the current model.
