#!/bin/bash
# Calendar wrapper for launchd services
#
# macOS TCC blocks calendar access when icalBuddy is spawned as a child
# of Bun under launchd. This wrapper runs icalBuddy directly (it has
# Calendar permission in TCC) and caches the output for the Bun script
# to read via the ICALBUDDY_CACHE_FILE env var.

ICALBUDDY="/opt/homebrew/bin/icalBuddy"
CACHE_FILE="/tmp/.claude-relay-calendar-cache.txt"

if [ -x "$ICALBUDDY" ]; then
  "$ICALBUDDY" -f -ea -nc -b "- " -po "title,datetime,location,notes,attendees" eventsToday \
    > "$CACHE_FILE" 2>/dev/null
  export ICALBUDDY_CACHE_FILE="$CACHE_FILE"
fi

exec "$@"
