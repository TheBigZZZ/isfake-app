import fs from 'fs';
import { Client } from 'pg';

async function main() {
  const sql = fs.readFileSync('scripts/check_function_privileges.sql', 'utf8');
  const conn = process.env.PG_CONNECTION_STRING;
  if (!conn) {
    console.error('Missing PG_CONNECTION_STRING environment variable. Set a GitHub Secret named PG_CONNECTION_STRING.');
    process.exit(2);
  }

  const client = new Client({ connectionString: conn });
  try {
    await client.connect();
    const res = await client.query(sql);
    console.log(JSON.stringify(res.rows, null, 2));
    await client.end();
    process.exit(0);
  } catch (err) {
    console.error('Privilege check failed:', err.message || err);
    try {
      await client.end();
    } catch {
      // ignore end errors
    }
    process.exit(1);
  }
}

main();
