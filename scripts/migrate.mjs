import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const workspaceEnv = fileURLToPath(new URL('../../.env', import.meta.url));
config({ path: workspaceEnv });

if (!process.env.DIRECT_URL) {
  console.error('DIRECT_URL is required in the workspace .env for Prisma migrations.');
  process.exit(1);
}

process.env.DATABASE_URL = process.env.DIRECT_URL;
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
const result = spawnSync(
  process.execPath,
  [prismaCli, 'migrate', 'dev', '--schema', 'prisma/schema.prisma', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
