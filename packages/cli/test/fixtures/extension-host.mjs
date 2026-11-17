import { pathToFileURL } from 'node:url';
const pi = await import(pathToFileURL(process.argv[2]).href);
const handlers = {};
pi.default({ on(name, fn) { handlers[name] = fn; } });
const command = process.argv[4];
const tool = process.argv[5] || 'bash';
const event = { toolName: 'bash', input: { command } };
const piResult = handlers.tool_call(event, { model: { id: 'Example Model' } });
const started = handlers.before_agent_start({ systemPrompt: 'SYS' });
const open = await import(pathToFileURL(process.argv[3]).href);
const api = await open.Plugin();
const args = { command };
let openError = '';
try { await api['tool.execute.before']({ tool }, { args }); }
catch (error) { openError = error.message; }
const literal = { command: 'echo ' + command };
await api['tool.execute.before']({ tool: 'bash' }, { args: literal });
const piLiteral = handlers.tool_call({ toolName: 'bash', input: { command: literal.command } }, { model: { id: 'Example Model' } });
const output = { system: 'SYS' };
await api['experimental.chat.system.transform']({}, output);
process.stdout.write(JSON.stringify({
  piBlock: piResult ? piResult.block : null,
  piReason: piResult ? piResult.reason : '',
  piLiteralBlock: piLiteral ? piLiteral.block : null,
  openError,
  openLiteral: literal.command,
  piCommand: event.input.command,
  piPrompt: started ? started.systemPrompt : '',
  openCommand: args.command,
  openSystem: output.system,
}));
