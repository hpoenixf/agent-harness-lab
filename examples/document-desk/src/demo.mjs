import { resolve } from 'node:path';
import { openDesk, scriptedGateway } from './desk.mjs';
import { assertSupportedNode } from '../../../scripts/node-version.mjs';

assertSupportedNode();
const stateIndex = process.argv.indexOf('--state');
const directory = resolve(stateIndex >= 0 ? process.argv[stateIndex + 1] : '.runs/demo');
const desk = await openDesk(directory);
try {
  const text = await desk.drive(scriptedGateway(), {
    afterEffect: process.argv.includes('--interrupt-after-save') ? call => {
      if (call.name === 'publish_report') throw new Error('Teaching interruption after durable file write');
    } : undefined,
  });
  const publication = desk.events().find(event => event.receipt?.publication)?.receipt.publication;
  process.stdout.write(JSON.stringify({ text, publication, eventCount: desk.events().length }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 75;
}
