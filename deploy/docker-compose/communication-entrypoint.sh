#!/bin/sh
set -eu

read_secret() {
  value="$(cat "$1")"
  [ -n "$value" ] || { echo "Secret is empty: $1" >&2; exit 1; }
  printf '%s' "$value"
}

set -a
. /run/secrets/crm_runtime_env
set +a

export DB_APP_PASSWORD="$(read_secret /run/secrets/mysql_password)"
export SESSION_MASTER_KEY="$(read_secret /run/secrets/communication_session_key)"
export DATABASE_URL="$(node -e '
  const url = new URL("mysql://placeholder/");
  url.username = process.env.DB_USER;
  url.password = process.env.DB_APP_PASSWORD;
  url.hostname = process.env.DB_HOST;
  url.port = process.env.DB_PORT;
  url.pathname = `/${process.env.DB_NAME}`;
  process.stdout.write(url.toString());
')"
unset DB_APP_PASSWORD

if [ "${MIGRATE_FROM_POSTGRES:-false}" = "true" ]; then
  export LEGACY_POSTGRES_PASSWORD="$(read_secret /run/secrets/postgres_password)"
  export SOURCE_DATABASE_URL="$(node -e '
    const url = new URL("postgresql://placeholder/");
    url.username = process.env.LEGACY_POSTGRES_USER;
    url.password = process.env.LEGACY_POSTGRES_PASSWORD;
    url.hostname = process.env.LEGACY_POSTGRES_HOST;
    url.port = process.env.LEGACY_POSTGRES_PORT;
    url.pathname = `/${process.env.LEGACY_POSTGRES_DB}`;
    process.stdout.write(url.toString());
  ')"
  unset LEGACY_POSTGRES_PASSWORD
fi

exec "$@"
