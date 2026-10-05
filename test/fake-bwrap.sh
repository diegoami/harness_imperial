#!/bin/sh
# A fake bwrap (HARNESS_BWRAP) for the tests: logs its arguments, one per line, to $FAKE_BWRAP_LOG,
# then runs what follows `--`.
if [ -n "$FAKE_BWRAP_LOG" ]; then printf '%s\n' "$@" >> "$FAKE_BWRAP_LOG"; echo '===' >> "$FAKE_BWRAP_LOG"; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
