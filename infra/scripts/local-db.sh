#!/usr/bin/env bash
# Starts a local PostgreSQL 16 + PostGIS cluster without Docker (dev fallback).
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=${PGDATA_DIR:-/var/tmp/relay-pg}
PORT=${PGPORT:-5432}
case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p "$DATA"; chown -R postgres "$DATA" 2>/dev/null || true
      runuser -u postgres -- "$PGBIN/initdb" -D "$DATA" -U relay --auth=trust >/dev/null
    fi
    runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log" start >/dev/null || true
    sleep 1
    for db in relay relay_test; do
      psql -h /tmp -p "$PORT" -U relay -d postgres -tc "select 1 from pg_database where datname='$db'" | grep -q 1 || \
        psql -h /tmp -p "$PORT" -U relay -d postgres -c "create database $db" >/dev/null
    done
    echo "postgres up on :$PORT";;
  stop) runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DATA" stop;;
esac
