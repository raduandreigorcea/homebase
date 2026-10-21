#!/bin/sh
# Runs when the package is removed (not when it is updated): the background service the app registered
# in each user's folder would otherwise keep pointing at files that are gone. Settings and history in
# ~/.local/share/homebase are kept.
# deb passes "remove" or "purge" on removal and "upgrade" on update; rpm passes 0 on removal and 1 on update.
case "$1" in remove|purge|0) ;; *) exit 0 ;; esac

pkill -f /usr/lib/Homebase/server/server.py 2>/dev/null
for home in /home/* /root; do
  dir="$home/.config/systemd/user"
  # Only the service file this app wrote (it says so on its first line), never one the user made.
  if [ -f "$dir/homebase.service" ] && head -n 1 "$dir/homebase.service" | grep -q "managed by the Homebase app"; then
    rm -f "$dir/homebase.service" "$dir/default.target.wants/homebase.service"
  fi
done
exit 0
