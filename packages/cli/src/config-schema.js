import { z } from 'zod';

const templates = z.object({
  markdown: z.string().optional(),
  trailer: z.string().optional(),
  session: z.string().optional(),
});

/**
 * One settings file. Unknown keys are dropped. The transform is the flat
 * settings object those files merge into.
 */
export const fileSchema = z.object({
  link: z.string().optional(),
  plugins: z.array(z.string()).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  attribution: z.object({
    link: z.string().optional(),
    template: z.string().optional(),
    templates: templates.optional(),
  }).optional(),
}).transform((file) => {
  const attribution = file.attribution ?? {};
  const body = attribution.templates ?? {};
  return defined({
    link: attribution.link ?? file.link,
    markdown: body.markdown ?? attribution.template,
    trailer: body.trailer,
    session: body.session,
    plugins: file.plugins,
    variables: file.variables,
  });
});

/** Settings after defaults and config files are merged. */
export const configSchema = z.object({
  markdown: z.string(),
  trailer: z.string(),
  link: z.string(),
  session: z.string().optional(),
  plugins: z.array(z.string()),
  variables: z.record(z.string(), z.string()),
});

/**
 * @param {z.ZodError} error
 * @returns {string}
 */
export function schemaIssues(error) {
  return error.issues.map((issue) => {
    const where = issue.path.join('.');
    return where ? `${where}: ${issue.message}` : issue.message;
  }).join('; ');
}

/**
 * @param {Record<string, unknown>} value
 */
function defined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
