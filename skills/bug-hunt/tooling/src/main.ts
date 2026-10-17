import { main } from './cli';

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
