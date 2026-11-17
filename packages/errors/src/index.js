import { LayerError } from '@mcp-layer/error';

const SCOPE = 'cosplaying';
const DOCS = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/**
 * Error for a cosplaying failure that the operator or the agent can act on.
 *
 * The class sets `scope` to `cosplaying` and `docs` to this repository. Callers put the explanation in `message`. They do not pass `scope` or `docs`.
 */
export class CosplayError extends LayerError {
  /**
   * Creates an error whose message names the failure, the bad value, and the next action.
   *
   * `%s` in `message` is replaced from `args`. The constructor fills `scope` and `docs` when the caller omits them.
   *
   * @param {import('@mcp-layer/error').LayerErrorArgs} [options] Error fields. `name` is the package, `method` is the operation, `message` is the template, `args` are the `%s` values, and `cause` is the underlying error.
   */
  constructor(options = {}) {
    super({
      ...options,
      scope: options.scope ?? SCOPE,
      docs: options.docs ?? DOCS,
    });
    this.name = 'CosplayError';
  }
}

export { docs, hashtag } from '@mcp-layer/error';
