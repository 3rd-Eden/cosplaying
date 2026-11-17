# @cosplaying/attribution

Private workspace package. Import it as `cosplaying/attribution`.

## What it does

Renders the markdown byline and the single-line `AI-Assisted-By` trailer, and replaces one trailing managed markdown block.

## Scope

In scope: the marker comments, markdown escaping of the model, percent-encoding of the link, and absolute `http:` or `https:` links. `replaces` fills `{name}` tags from the model, the link, and `variables`.

A missing or empty model throws. An empty link stays empty. Any other link must parse as an absolute `http:` or `https:` URL. A template that already contains the attribution markers throws, because the renderer could not find its own block later. A rendered trailer that contains a line break throws, because Git stores `AI-Assisted-By` as one line. This package does not load settings, choose a model, write files, or decide whether a comment or commit needs a disclosure.

## Public API

- `ATTRIBUTION_MARKER` is `<!-- cosplaying:attribution -->`. `ATTRIBUTION_END_MARKER` is `<!-- /cosplaying:attribution -->`.
- `normalizeIdentity(value)` trims and collapses internal whitespace. A missing, null, or empty value becomes an empty string.
- `validateLink(link)` returns `''` for `undefined`, `null`, or `''`. Any other value must be an `http:` or `https:` URL. The result is `url.href`.
- `stripAttribution(value)` removes one trailing managed block and the whitespace before it. The trimmed text must end with the closing marker. An opening marker must precede that marker. Any other text is returned unchanged.
- `annotateMarkdown(value, { model, template, link, variables })` removes one trailing block and whitespace from the end of the body. It adds a blank line after a non-empty body. Then it adds the opening marker, template text, closing marker, and final newline. The model is escaped for Markdown. Whitespace, parentheses, and angle brackets in the link are percent-encoded. `{name}` tags are filled by `replaces` from the checked model, the checked link, and `variables`.
- `renderTrailer(model, { template, link, variables })` returns `AI-Assisted-By: ` plus one rendered line. A result with a carriage return or newline throws.

The renderer functions do not supply default templates or links. For default wording, direct callers must supply a template. The CLI supplies its configured template, link, and variables.

The `{model}` tag is optional. `replaces` fills the supplied values without a fixed list of tag names.

## Related packages

`replaces` fills `{name}` tags. `cosmiconfig` supplies the template, link, and variables over the defaults. `@cosplaying/cli` passes `annotateMarkdown` and `renderTrailer` to a plugin with the invocation model and the loaded settings. `@cosplaying/plugin` can copy file text and call a renderer; it does not format the byline. Failures throw `CosplayError`.
