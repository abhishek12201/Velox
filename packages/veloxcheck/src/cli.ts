import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

interface CheckSummary {
  url: string;
  protocolVersion: string | undefined;
  strict: boolean;
  checks: CheckResult[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function invalidArguments(tool: { inputSchema: unknown }): Record<string, unknown> {
  const schema = asRecord(tool.inputSchema);
  const properties = asRecord(schema?.properties);
  if (properties) {
    const required = Array.isArray(schema?.required) ? schema.required : [];
    if (required.length > 0) return { as_of: '2026-06-01T00:00:00.000Z' };
    const first = Object.entries(properties).find(([name]) => name !== 'as_of');
    if (first) {
      const property = asRecord(first[1]);
      const wrongValue = property?.type === 'string' ? 1
        : property?.type === 'number' || property?.type === 'integer' ? 'invalid'
          : property?.type === 'boolean' ? 'invalid'
            : null;
      return { as_of: '2026-06-01T00:00:00.000Z', [first[0]]: wrongValue };
    }
  }
  return { as_of: '2026-06-01T00:00:00.000Z', __veloxcheck_invalid_argument__: true };
}

function hasErrorMessage(value: unknown): boolean {
  const result = asRecord(value);
  if (result?.isError !== true) return false;
  const contentMessage = Array.isArray(result.content) && result.content.some((entry) => {
    const item = asRecord(entry);
    return item?.type === 'text' && typeof item.text === 'string' && Boolean(item.text.trim());
  });
  const structuredMessage = typeof asRecord(result.structuredContent)?.message === 'string';
  return Boolean(contentMessage || structuredMessage);
}

export async function runVeloxCheck(url: string, strict = false): Promise<CheckSummary> {
  const summary: CheckSummary = { url, protocolVersion: undefined, strict, checks: [] };
  const add = (check: string, passed: boolean, detail: string) => summary.checks.push({ check, passed, detail });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'veloxcheck', version: '1.0.0' }, { capabilities: {} });
  let connected = false;
  let deletionAttempted = false;

  try {
    await client.connect(transport);
    connected = true;
    summary.protocolVersion = transport.protocolVersion;
    add(
      'initialize protocol',
      transport.protocolVersion === LATEST_PROTOCOL_VERSION,
      `negotiated ${transport.protocolVersion ?? 'no version'}; expected ${LATEST_PROTOCOL_VERSION}`,
    );

    const { tools } = await client.listTools();
    add('tools/list non-empty', tools.length > 0, `${tools.length} tool(s) listed`);
    for (const tool of tools) {
      const inputSchema = asRecord(tool.inputSchema);
      const annotations = asRecord(tool.annotations);
      const validDescription = typeof tool.description === 'string' && tool.description.trim().length >= 20;
      const validInput = inputSchema?.type === 'object';
      const validAnnotations = ['readOnlyHint', 'destructiveHint', 'idempotentHint']
        .every((key) => typeof annotations?.[key] === 'boolean');
      add(
        `tool ${tool.name} metadata`,
        validDescription && validInput && validAnnotations,
        `description ${validDescription ? 'ok' : 'too short/missing'}, input schema ${validInput ? 'object' : 'not object'}, annotations ${validAnnotations ? 'complete' : 'incomplete'}`,
      );
      const outputSchema = asRecord(tool.outputSchema);
      add(
        `tool ${tool.name} output schema`,
        outputSchema?.type === 'object',
        outputSchema?.type === 'object' ? 'object output schema present' : 'missing object output schema',
      );
    }

    let unknownPassed = false;
    let unknownDetail = 'server accepted an unknown tool';
    try {
      const result = await client.callTool({ name: '__veloxcheck_unknown_tool__', arguments: { as_of: '2026-06-01T00:00:00.000Z' } });
      unknownPassed = hasErrorMessage(result);
      unknownDetail = unknownPassed ? 'unknown tool returned a protocol error' : 'unknown tool did not return an error message';
    } catch (error) {
      const message = errorMessage(error);
      unknownPassed = message.trim().length > 0;
      unknownDetail = unknownPassed ? `protocol error: ${message}` : 'protocol error had no message';
    }
    add('unknown tool error', unknownPassed, unknownDetail);

    const candidate = tools.find((tool) => {
      const schema = asRecord(tool.inputSchema);
      return Array.isArray(schema?.required) && schema.required.length > 0;
    }) ?? tools.find((tool) => Object.keys(asRecord(tool.inputSchema)?.properties as Record<string, unknown> ?? {}).length > 0);
    let invalidPassed = false;
    let invalidDetail = 'no tool found to probe invalid arguments';
    if (candidate) {
      try {
        const result = await client.callTool({ name: candidate.name, arguments: invalidArguments(candidate) });
        invalidPassed = hasErrorMessage(result);
        invalidDetail = invalidPassed ? 'invalid arguments returned an error message' : 'invalid arguments were accepted or had no message';
      } catch (error) {
        const message = errorMessage(error);
        invalidPassed = message.trim().length > 0;
        invalidDetail = invalidPassed ? `protocol error: ${message}` : 'protocol error had no message';
      }
    }
    add('invalid arguments error', invalidPassed, invalidDetail);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://veloxcheck.invalid' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      const passed = strict ? response.status === 403 : response.status >= 400;
      add('foreign Origin rejected', passed, `HTTP ${response.status}${strict ? ' (strict requires 403)' : ''}`);
    } catch (error) {
      add('foreign Origin rejected', false, errorMessage(error));
    }

    try {
      deletionAttempted = true;
      await transport.terminateSession();
      add('DELETE session', true, 'session terminated');
    } catch (error) {
      add('DELETE session', false, errorMessage(error));
    }
  } catch (error) {
    add('initialize client', false, errorMessage(error));
  } finally {
    if (connected && !deletionAttempted) {
      try {
        await transport.terminateSession();
        add('DELETE session', true, 'session terminated during cleanup');
      } catch (error) {
        add('DELETE session', false, `cleanup failed: ${errorMessage(error)}`);
      }
    }
    await client.close();
  }

  return summary;
}

function renderTable(summary: CheckSummary): string {
  const rows = summary.checks.map(({ check, passed, detail }) => [passed ? 'PASS' : 'FAIL', check, detail]);
  const widths = [4, 0, 0];
  widths[0] = Math.max('Result'.length, ...rows.map((row) => row[0].length));
  widths[1] = Math.max('Check'.length, ...rows.map((row) => row[1].length));
  widths[2] = Math.max('Detail'.length, ...rows.map((row) => row[2].length));
  const line = `+${'-'.repeat(widths[0] + 2)}+${'-'.repeat(widths[1] + 2)}+${'-'.repeat(widths[2] + 2)}+`;
  const format = (row: string[]) => `| ${row[0].padEnd(widths[0])} | ${row[1].padEnd(widths[1])} | ${row[2].padEnd(widths[2])} |`;
  return [
    `Veloxcheck: ${summary.url}`,
    `Protocol: ${summary.protocolVersion ?? 'not negotiated'}${summary.strict ? ' (strict)' : ''}`,
    line,
    format(['Result', 'Check', 'Detail']),
    line,
    ...rows.map(format),
    line,
  ].join('\n');
}

function parseArgs(args: string[]): { url: string; json: boolean; strict: boolean } {
  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url || args.some((arg) => !arg.startsWith('--') && arg !== url)) {
    throw new Error('Usage: veloxcheck <url> [--json] [--strict]');
  }
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && !['--json', '--strict'].includes(arg));
  if (unknownFlags.length > 0) throw new Error(`Unknown option: ${unknownFlags.join(', ')}`);
  return { url, json: args.includes('--json'), strict: args.includes('--strict') };
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = await runVeloxCheck(options.url, options.strict);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(renderTable(summary));
    if (summary.checks.some((check) => !check.passed)) process.exitCode = 1;
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
