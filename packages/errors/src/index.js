import { LayerError } from '@mcp-layer/error';

const SCOPE = 'cosplaying';
const DOCS = 'github.com/3rd-Eden/cosplay/tree/main/packages';

/**
 * Project error. `scope` and `docs` match this repository.
 * Callers pass `name`, `method`, `message`, and any `args` or `cause`.
 */
export class CosplayError extends LayerError {
  /**
   * @param {import('@mcp-layer/error').LayerErrorArgs} [options]
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
