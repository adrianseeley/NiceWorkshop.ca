#!/usr/bin/env bash
set -euo pipefail

# Creates a disposable loopback-only database; never starts a system service.
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POSTGRES_BIN="${NICE_TEST_POSTGRES_BIN:-$(brew --prefix postgresql@17)/bin}"
mkdir -p "$PROJECT_ROOT/tmp"
CLUSTER_ROOT="$(mktemp -d "$PROJECT_ROOT/tmp/test-postgres.XXXXXX")"
CLUSTER_DATA="$CLUSTER_ROOT/data"

cleanup() {
  if [[ -d "$CLUSTER_DATA" ]] && "$POSTGRES_BIN/pg_ctl" -D "$CLUSTER_DATA" status >/dev/null 2>&1; then
    "$POSTGRES_BIN/pg_ctl" -D "$CLUSTER_DATA" -m immediate -w stop >/dev/null || true
  fi
  rm -rf "$CLUSTER_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TEST_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
"$POSTGRES_BIN/initdb" -D "$CLUSTER_DATA" --auth=trust --username=nice_test --locale=C --encoding=UTF8 --no-instructions >/dev/null
"$POSTGRES_BIN/pg_ctl" -D "$CLUSTER_DATA" -l "$CLUSTER_ROOT/server.log" \
  -o "-h 127.0.0.1 -p $TEST_PORT -k $CLUSTER_ROOT" -w start >/dev/null
cd "$PROJECT_ROOT"
NICE_TEST_POSTGRES_PORT="$TEST_PORT" node -e '
const { Client } = require("pg");
(async () => {
  const client = new Client({ host: "127.0.0.1", port: Number(process.env.NICE_TEST_POSTGRES_PORT), user: "nice_test", database: "postgres", ssl: false });
  try { await client.connect(); await client.query("CREATE DATABASE niceworkshop_test"); }
  finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });'
if [[ "$#" == 0 ]]; then set -- test/db.test.js; fi
TEST_DATABASE_URL="postgres://nice_test@127.0.0.1:$TEST_PORT/niceworkshop_test" \
  TEST_DATABASE_SSL=disable node --test "$@"
