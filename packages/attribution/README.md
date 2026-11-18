# Attribution API

Import `cosplaying/attribution` to add a Markdown byline to a body or render a Git trailer. Inside a plugin, use `context.attribution` so the CLI supplies the current model and configured wording. Direct callers supply the model, template, and any policy link themselves. [Plugin context](../plugin/README.md#use-the-hook-context)

## Add or replace a Markdown byline

```js
import { annotateMarkdown } from 'cosplaying/attribution';

const body = annotateMarkdown('The build passed.', {
  model: 'Example Model',
  link: 'https://example.com/ai-policy',
  template: '> AI-assisted by {model}. [AI policy]({link}).',
});
```

```markdown
The build passed.

<!-- cosplaying:attribution -->
> AI-assisted by Example Model. [AI policy](https://example.com/ai-policy).
<!-- /cosplaying:attribution -->
```

On an edit, pass the existing body to `annotateMarkdown`. The function replaces one marked block at the end and adds a final newline. A block followed by other content stays in the body. The renderer escapes Markdown characters in the model name and percent-encodes whitespace, parentheses, and angle brackets in the link. Keep both markers out of the template. The renderer supplies them.

## Render a Git trailer

```js
import { renderTrailer } from 'cosplaying/attribution';

const trailer = renderTrailer('Example Model', {
  template: '{model} ({link})',
  link: 'https://example.com/ai-policy',
});
// AI-Assisted-By: Example Model (https://example.com/ai-policy)
```

Use the result as a complete trailer line. The renderer throws a `CosplayError` if the filled trailer contains a line break.

Both renderers require a model name with at least one non-whitespace character. The template can omit `{model}`. The renderer fills tags from `variables` and supplies its own values for `{model}` and `{link}`. A tag without a value becomes empty. An omitted template produces empty attribution text, so supply a template when you call these renderers directly.

<details>
<summary>Utilities and marker constants</summary>

| Export | Result |
| --- | --- |
| `normalizeIdentity(value)` | Trims and collapses whitespace. A missing or empty value yields an empty string. |
| `validateLink(link)` | Returns the normalized absolute HTTP or HTTPS URL. An omitted, null, or empty link yields an empty string. An invalid link throws `CosplayError`. |
| `stripAttribution(text)` | Removes one trailing marked block and the whitespace immediately before it. Returns the original text if there is no complete trailing block. |
| `ATTRIBUTION_MARKER` | `<!-- cosplaying:attribution -->` |
| `ATTRIBUTION_END_MARKER` | `<!-- /cosplaying:attribution -->` |

</details>

For the default templates and policy URL, see [Set the attribution text](../../README.md#set-the-attribution-text). For the scope of the disclosure, see [Attribution limits](../../README.md#attribution-limits).
