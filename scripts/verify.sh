#!/bin/sh
# The whole check tier in one command: lint, typecheck, tests, whitespace. One
# summary line per check; exit status is non-zero if any failed. Run it before
# handing off a change and after each merge.
#
# Everything runs in the dev container from docker/compose.dev.yml (-T so it works
# from scripts and CI). Nothing is installed on the host. PostgreSQL suites run
# against a disposable test database on the dev PostgreSQL service; the browser
# suite skips when the container has no Chrome and is covered by CI.
#
# In a git worktree, export COMPOSE_PROJECT_NAME so the worktree gets its own
# containers and volumes instead of sharing the main checkout's.
set -u
cd "$(dirname "$0")/.." || exit 1

project=${COMPOSE_PROJECT_NAME:-dispatch-route-review-dev}
test_db=dispatch_route_review_test
test_url="postgresql://dispatch_route_review:dispatch_route_review@postgres:5432/$test_db"

compose() {
    docker compose -p "$project" --project-directory . -f docker/compose.dev.yml "$@"
}

# Checks run in the dependencies service: same image and mounts as the app, but
# none of the app's DATABASE_URL or AUTH_MODE values, matching CI's environment.
# (The app service's dev DATABASE_URL would be cached into the test pool and the
# PostgreSQL suites would then hit the unmigrated dev database.)
in_container() {
    compose run --rm -T --no-deps "$@" dependencies sh -lc "corepack enable && $cmd"
}

status=0

run() {
    name=$1
    shift
    if out=$("$@" 2>&1); then
        echo "verify: $name: ok ($(printf '%s\n' "$out" | tail -1))"
    else
        status=1
        printf '%s\n' "$out" | tail -40
        echo "verify: $name: FAILED"
    fi
}

# Preparation must succeed before any check means anything.
if ! out=$(compose up -d --wait postgres 2>&1 && compose run --rm -T dependencies 2>&1); then
    printf '%s\n' "$out" | tail -40
    echo "verify: prepare: FAILED"
    exit 1
fi
if ! compose exec -T postgres psql -U dispatch_route_review -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '$test_db'" | grep -q 1; then
    # pgcrypto is created here, once, because parallel test files racing to run
    # CREATE EXTENSION IF NOT EXISTS on a fresh database can race on catalog
    # inserts even with IF NOT EXISTS, causing duplicate-key failures.
    compose exec -T postgres createdb -U dispatch_route_review "$test_db" \
        && compose exec -T postgres psql -U dispatch_route_review -d "$test_db" -v ON_ERROR_STOP=1 \
            -qc "CREATE EXTENSION IF NOT EXISTS pgcrypto" || {
        echo "verify: prepare: FAILED (could not create $test_db)"
        exit 1
    }
fi

cmd="pnpm lint";      run lint      in_container
cmd="pnpm typecheck"; run typecheck in_container
cmd="pnpm test";      run tests     in_container -e TEST_DATABASE_URL="$test_url"
run whitespace git diff HEAD --check
exit $status
