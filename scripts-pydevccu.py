"""Local pydevccu test double for the Matter bridge.

Serves HmIP-FBL and HmIPW-DRBL4 blind fakes on port 2010 (HmIP-RF),
matching the bridge's config.ccu.interfaces.HmIP-RF.port. Runs until
Ctrl-C or SIGTERM.
"""
import signal
import sys
import time

import pydevccu

DEVICES = [
    # Lights / switches
    "HMIP-PSM",      # metering plug switch → SWITCH_VIRTUAL_RECEIVER
    "HmIP-BSM",      # brand switch with measuring → SWITCH_VIRTUAL_RECEIVER
    "HmIP-BDT",      # brand dimmer → DIMMER (LEVEL 0–1)
    # Blinds
    "HmIP-FBL",      # venetian blind actuator → BLIND_VIRTUAL_RECEIVER + tilt
    "HmIPW-DRBL4",   # 4-ch wired blind (mixed roller/venetian modes)
]


def main() -> int:
    server = pydevccu.Server(addr=("127.0.0.1", 2010), devices=DEVICES)
    server.start()
    print(f"pydevccu listening on 127.0.0.1:2010 — devices: {', '.join(DEVICES)}", flush=True)

    stop = {"flag": False}
    def shutdown(_sig, _frame):
        stop["flag"] = True
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while not stop["flag"]:
        time.sleep(0.5)

    server.stop()
    print("pydevccu stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
