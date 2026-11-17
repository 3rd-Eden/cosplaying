import { collapseWhiteSpace } from 'collapse-white-space';
import { CosplayError } from 'cosplaying/errors';
import replaces from 'replaces';

/** @type {string} */
export const ATTRIBUTION_MARKER = '<!-- cosplaying:attribution -->';

/** @type {string} */
export const ATTRIBUTION_END_MARKER = '<!-- /cosplaying:attribution -->';

/**
 * Turns a model name into the single line that attribution text can show.
 *
 * An empty value stays empty. The byline must not invent the words `undefined` or `null` when the caller has no model.
 *
 * @param {unknown} value Model name or other identity text. A non-string is treated as empty.
 * @returns {string} Trimmed text with internal whitespace collapsed to single spaces. An empty string when `value` is empty.
 */
export function normalizeIdentity(value) {
  return collapseWhiteSpace(value || '', { trim: true });
}

/**
 * Escapes characters that would change the meaning of the model name in Markdown.
 *
 * The byline is visible disclosure. A model name must appear as text, not as emphasis, a link, or a code span.
 *
 * @param {string} value Model name after whitespace is collapsed.
 * @returns {string} The same text with `\`, `` ` ``, `*`, `_`, `{`, `}`, `[`, `]`, `<`, `>`, `!`, and `|` escaped.
 */
function escapeMarkdownText(value) {
  return value.replace(/[\\`*_{}\[\]<>!|]/g, '\\$&');
}

/**
 * Encodes characters that would break the policy URL inside a Markdown link.
 *
 * Spaces and parentheses are encoded. The rest of an already valid URL is left readable.
 *
 * @param {string} value Absolute policy URL. An empty string is allowed.
 * @returns {string} URL text safe to place between `](` and `)`. An empty string when `value` is empty.
 */
function escapeMarkdownLink(value) {
  if (!value) return '';
  return value.replace(/[\s()<>]/g, (character) => ({
    '(': '%28',
    ')': '%29',
    '<': '%3C',
    '>': '%3E',
  })[character] || encodeURIComponent(character));
}

/**
 * Checks that a policy link is an absolute HTTP or HTTPS URL.
 *
 * Attribution text includes this link so a reader can open the deployer policy. Any other scheme is rejected.
 *
 * @param {string} [link] Link from settings. Omitted, null, and empty are accepted as "no link".
 * @returns {string} The normalized URL, including its canonical form. An empty string when no link was supplied.
 * @throws {CosplayError} The value is not an absolute `http:` or `https:` URL.
 */
export function validateLink(link) {
  if (link === undefined || link === null || link === '') return '';
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new CosplayError({
      name: 'attribution',
      method: 'validateLink',
      message: 'attribution link must be an absolute HTTP or HTTPS URL, for example https://example.com/ai-policy. Replace the link with an absolute http:// or https:// URL.',
    });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new CosplayError({
      name: 'attribution',
      method: 'validateLink',
      message: 'attribution link must be an absolute HTTP or HTTPS URL, for example https://example.com/ai-policy. Replace the link with an absolute http:// or https:// URL.',
    });
  }
  return url.href;
}

/**
 * Replaces `{name}` tags in an attribution template.
 *
 * The first capture is the modifier. These templates do not use one. The second capture is the key. A key with no value is left empty.
 *
 * @param {string} template Template text from settings or from the built-in default.
 * @param {Record<string, string>} values Replacement values. Keys are the names inside `{name}`.
 * @returns {string} Template with each known `{name}` replaced. Unknown names become empty.
 */
function fill(template, values) {
  return replaces(template, /\{()([^{}]+)\}/g, values);
}

/**
 * Removes one cosplaying attribution block from the end of a document.
 *
 * A second write must replace the previous block. A block that is not at the end is left in place so other text is not cut.
 *
 * @param {string} value Markdown or other text that may already end with the attribution markers.
 * @returns {string} `value` without a final block that starts with the attribution marker and ends with the end marker. The original text when that block is absent.
 */
export function stripAttribution(value) {
  const trimmed = value.trimEnd();
  if (!trimmed.endsWith(ATTRIBUTION_END_MARKER)) return value;
  const closeAt = trimmed.lastIndexOf(ATTRIBUTION_END_MARKER);
  const openAt = trimmed.lastIndexOf(ATTRIBUTION_MARKER, closeAt);
  if (openAt < 0) return value;
  let cut = openAt;
  while (cut > 0 && /\s/.test(value[cut - 1])) cut -= 1;
  return value.slice(0, cut);
}

/**
 * Appends the visible attribution block to Markdown text.
 *
 * The block is the disclosure a deployer can show when EU AI Act Article 50(4) applies. This function does not decide whether that article applies. A previous block at the end is replaced. The renderer adds the marker comments. A template that already contains them is rejected so a later edit does not cut the wrong span.
 *
 * @param {string} value Original Markdown. It can be empty.
 * @param {object} [options]
 * @param {unknown} [options.model] Model name. An empty name is rejected so the block does not name nobody.
 * @param {string} [options.template] Markdown template. `{model}`, `{link}`, and keys in `variables` are replaced. An omitted template is empty.
 * @param {string} [options.link] Policy URL. It must be absolute `http` or `https` when it is set.
 * @param {Record<string, string>} [options.variables] Extra `{name}` values from settings.
 * @returns {string} Original text, then a blank line, then the marked attribution block and a trailing newline.
 * @throws {CosplayError} The model is empty, the link is not an HTTP(S) URL, or the template contains a cosplaying marker comment.
 */
export function annotateMarkdown(value, { model, template, link, variables = {} } = {}) {
  const source = (template ?? '').replace(/\r\n?/g, '\n').trim();
  if (source.includes(ATTRIBUTION_MARKER) || source.includes(ATTRIBUTION_END_MARKER)) {
    throw new CosplayError({
      name: 'attribution',
      method: 'annotateMarkdown',
      message: 'attribution template must not contain cosplaying marker comments. Remove <!-- cosplaying:attribution --> and <!-- /cosplaying:attribution --> from the template. The renderer adds those markers.',
    });
  }
  const safeModel = escapeMarkdownText(normalizeIdentity(model));
  if (!safeModel) {
    throw new CosplayError({
      name: 'attribution',
      method: 'annotateMarkdown',
      message: 'attribution identity is required for text writes. Pass --model <name> or set COSPLAYING_MODEL. Do not guess the model. Run the command as cosplaying hook --model <name> -- <command>, or export COSPLAYING_MODEL.',
    });
  }
  const safeLink = escapeMarkdownLink(validateLink(link));
  const rendered = fill(source, { ...variables, model: safeModel, link: safeLink });
  const body = stripAttribution(value).replace(/[ \t\r\n]+$/, '');
  const footer = `${ATTRIBUTION_MARKER}\n${rendered}\n${ATTRIBUTION_END_MARKER}`;
  return `${body}${body ? '\n\n' : ''}${footer}\n`;
}

/**
 * Builds the single-line Git trailer that names the model.
 *
 * The trailer is `AI-Assisted-By`. It is not an Article 50(2) machine-readable mark, and this project does not claim that compliance. A line break is rejected because a Git trailer is one line.
 *
 * @param {unknown} model Model name. An empty name is rejected so the trailer does not name nobody.
 * @param {object} [options]
 * @param {string} [options.template] Trailer template. `{model}`, `{link}`, and keys in `variables` are replaced. An omitted template is empty.
 * @param {string} [options.link] Policy URL. It must be absolute `http` or `https` when it is set.
 * @param {Record<string, string>} [options.variables] Extra `{name}` values from settings. A value that contains a line break makes the result invalid.
 * @returns {string} One line of the form `AI-Assisted-By: <rendered template>`.
 * @throws {CosplayError} The model is empty, the link is not an HTTP(S) URL, or the rendered trailer contains a line break.
 */
export function renderTrailer(model, { template, link, variables = {} } = {}) {
  const safeModel = normalizeIdentity(model);
  if (!safeModel) {
    throw new CosplayError({
      name: 'attribution',
      method: 'renderTrailer',
      message: 'attribution identity is required for commits. Pass --model <name> or set COSPLAYING_MODEL. Do not guess the model. Run the command as cosplaying hook --model <name> -- <command>, or export COSPLAYING_MODEL.',
    });
  }
  const safeLink = validateLink(link);
  const rendered = fill((template ?? '').trim(), { ...variables, model: safeModel, link: safeLink });
  if (/[\r\n]/.test(rendered)) {
    throw new CosplayError({
      name: 'attribution',
      method: 'renderTrailer',
      message: 'rendered trailer attribution must be a single line. Remove line breaks from variables used in the trailer template.',
    });
  }
  return `AI-Assisted-By: ${rendered}`;
}
