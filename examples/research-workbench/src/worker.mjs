import { main } from './cli.mjs';
// Browser connections never own this process. SQLite permits one active worker.
await main(['resume', ...process.argv.slice(2)]).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
