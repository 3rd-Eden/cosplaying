# Error API

Import `CosplayError` from `cosplaying/errors` for failures that a user or coding agent can correct. Put the failure, the input that caused it, and the corrective action in the message.

```js
import { CosplayError } from 'cosplaying/errors';

throw new CosplayError({
  name: 'plugin',
  method: 'readNote',
  message: 'Could not read %s. Check that the file exists and retry.',
  args: ['note.md'],
});
```

Use `name` for the component and `method` for the operation. `args` replaces each `%s` in order. Set `cause` when you catch a lower-level error and want to retain it.

`CosplayError` extends `LayerError` from `@mcp-layer/error`. It supplies the `cosplaying` scope and the package documentation base URL. At a throw site, use those defaults. The example starts with `cosplaying/plugin(readNote):` and includes a documentation link. For troubleshooting steps by component, see the [error catalog](../../docs/errors.md).

<details>
<summary>Fields and documentation references</summary>

- `error.name` is `CosplayError`. `error.package` is `cosplaying/<name>` for an unscoped name or the original name for a scoped name. `error.method` and `error.cause` retain their input values.
- The base class applies `vars` to `{key}` placeholders before it applies `args`. It also copies extra fields to the error.
- `hashtag(text)` returns `#` followed by six uppercase hexadecimal digits.
- `docs(options)` builds `error.docs` from the documentation base, the unscoped component name, and `README.md`. The default base is `https://github.com/3rd-Eden/cosplay/tree/main/packages`.
- `error.reference` is calculated from the component, method, and message template joined by hyphens. The generated URL uses `#error-` followed by the lowercase reference digits.

</details>

The generated Pi and OpenCode files run inside their respective agents. OpenCode uses a plain `Error` when it cannot rewrite a registered command. Pi returns a block response. Both direct the agent to retry through `cosplaying hook` with the current model. [Harness adapters](../adapters/README.md)
