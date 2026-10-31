'use strict';
const { createPool, migrate } = require('../server/db');

async function main() {
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied ${applied.length} database migration(s).` : 'Database schema is current.');
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => {
  // Connection errors can contain database host/user details; never print URLs.
  console.error(`Database migration failed (${error.code || 'unknown_error'}).`);
  process.exitCode = 1;
});
module.exports = { main };
