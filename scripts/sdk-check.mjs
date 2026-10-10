import { readFileSync } from 'node:fs';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const sdkPkg = JSON.parse(readFileSync(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url), 'utf8'));
const versionList = [...new Set((SUPPORTED_PROTOCOL_VERSIONS ?? []).map(String))].filter(Boolean);

console.log(`SDK version: ${sdkPkg.version}`);
console.log(`Supported protocol versions: ${versionList.join(', ') || 'none'}`);

if (!versionList.includes('2025-11-25')) {
  console.error('SDK does not advertise protocol 2025-11-25');
  process.exit(1);
}

console.log('OK');
