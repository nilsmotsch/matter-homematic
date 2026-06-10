#!/bin/sh
# Returns the currently installed addon version. The CCU WebUI calls this
# when the user clicks "check for updates"; it doesn't fetch from the network,
# it just reports what's installed so the WebUI can show a version string.
echo "Content-Type: text/plain"
echo ""
cat /usr/local/addons/matter-homematic/VERSION 2>/dev/null || echo "0.0.0"
