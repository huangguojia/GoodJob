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
export INITIAL_ADMIN_PASSWORD="$(read_secret /run/secrets/initial_admin_password)"
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

exec "$@"
