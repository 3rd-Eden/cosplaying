import { block } from 'cosplaying/plugin';

export const description = 'Append a byline to notify --message';

export const examples = ['cosplaying hook --model "Example" -- notify --message "text"'];

export default async function run(args, context) {
  const index = args.indexOf('--message');
  const text = index >= 0 ? args[index + 1] : undefined;
  if (text === undefined) {
    const result = await context.spawn(context.realBin, args, {
      cwd: context.cwd,
      env: context.env,
      stdio: 'inherit',
    });
    return result?.status ?? 1;
  }
  if (!context.model) {
    block(context.stderr, 'notify --message writes text and needs a model. Pass --model <name> or set COSPLAYING_MODEL.');
    return 2;
  }
  let trailer;
  try {
    trailer = context.attribution.renderTrailer();
  } catch (error) {
    block(context.stderr, error.message);
    return 2;
  }
  const next = args.slice();
  next[index + 1] = `${text}\n${trailer}`;
  const result = await context.spawn(context.realBin, next, {
    cwd: context.cwd,
    env: context.env,
    stdio: 'inherit',
  });
  return result?.status ?? 1;
}
