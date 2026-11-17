import { collapseWhiteSpace } from 'collapse-white-space';
import { CosplayError } from 'cosplaying/errors';
import replaces from 'replaces';

/** @type {string} */
export const ATTRIBUTION_MARKER = '<!-- cosplaying:attribution -->';

/** @type {string} */
export const ATTRIBUTION_END_MARKER = '<!-- /cosplaying:attribution -->';

/**
 * Trims a model or link and collapses internal whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeIdentity(value) {
  return collapseWhiteSpace(value || '', { trim: true });
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeMarkdownText(value) {
  return value.replace(/[\\`*_{}\[\]<>!|]/g, '\\$&');
}

/**
 * @param {string} value
 * @returns {string}
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
 * @param {string} [link]
 * @returns {string}
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
 * The first group is the replaces modifier. These tags have none.
 * The second group is the key.
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
function fill(template, values) {
  return replaces(template, /\{()([^{}]+)\}/g, values);
}

/**
 * Removes one trailing managed attribution block.
 * @param {string} value
 * @returns {string}
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
 * @param {string} value
 * @param {{model?: unknown, template?: string, link?: string, variables?: Record<string, string>}} options
 * @returns {string}
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
 * @param {unknown} model
 * @param {{template?: string, link?: string, variables?: Record<string, string>}} options
 * @returns {string}
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
