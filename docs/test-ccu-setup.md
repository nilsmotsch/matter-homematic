# Test CCU on a Raspberry Pi (RaspberryMatic)

This sets up a clean, isolated CCU instance on a Pi 5 (or any aarch64-capable Pi) so you can install and uninstall the matter-homematic addon over and over without risking your production CCU.

## What you need

- Raspberry Pi 5 (or Pi 4, Pi 3B+, Zero 2 W — anything 64-bit RaspberryMatic supports)
- microSD card (8 GB minimum, 16 GB recommended), separate from any card you currently use
- Power supply, network cable or Wi-Fi credentials
- A workstation with Raspberry Pi Imager installed (`brew install --cask raspberry-pi-imager` on macOS)

A radio module (HM-MOD-RPI-PCB or RPI-RF-MOD) is **not required** for testing the addon installer flow — pydevccu inside RaspberryMatic provides simulated devices.

## Flash RaspberryMatic

1. Open Raspberry Pi Imager.
2. **Choose Device**: Raspberry Pi 5 (or your model).
3. **Choose OS** → *Other specific-purpose OS* → *Home assistants and home automation* → **RaspberryMatic** → pick the image matching your hardware.
4. **Choose Storage**: select the new microSD card. Verify carefully — Imager will overwrite it.
5. Skip the "Customize" prompt (RaspberryMatic doesn't use Pi Imager's user/SSH/Wi-Fi customizations; configure those through the CCU WebUI after first boot).
6. Click **Write** and wait.

## First boot

1. Insert the SD card into the Pi, plug in network and power.
2. Wait ~3 minutes for the first boot. Find the IP via your router or `arp -a | grep -i 'b8:27:eb\|dc:a6:32\|d8:3a:dd'`.
3. Open `http://<pi-ip>/` in a browser. You should see the CCU WebUI.
4. Set a hostname (e.g. `test-ccu`) under *Einstellungen → Systemsteuerung → Netzwerkeinstellungen*.

## Install pydevccu (optional, for simulated devices)

If you want fake Homematic devices to bridge against, install the pydevccu addon on the test CCU. Otherwise, point matter-homematic at your production CCU's IP for read-only testing.

## Install the matter-homematic addon

1. On your dev workstation: `npm run build:addon` to produce `dist-addon/matter-homematic-<version>.tar.gz`.
2. In the test CCU WebUI: *Einstellungen → Systemsteuerung → Zusatzsoftware*.
3. Click **Durchsuchen / Browse**, pick the tarball, click **Installieren**.
4. The CCU will reboot. After it comes back up, a *Matter Homematic* tile appears in *Systemsteuerung*.
5. Click the tile → redirects to `http://test-ccu:8080/`. Edit the config to point at your CCU (or pydevccu), pick devices to expose, and use the WebUI's restart button.

## Iterating

- Re-uploading a new tarball through the WebUI installer triggers an *update* (no reboot required, exit code 0 from `update_script`).
- `/usr/local/etc/config/addons/matter-homematic/` survives addon updates — Matter fabric pairings persist.
- SSH access (enable via WebUI *Sicherheit / Security*) gives you `/var/log/messages` for syslog (`logger -t homematic` lines from rc.d) and the bridge's own log at `/usr/local/etc/config/addons/matter-homematic/matter-homematic.log`.
- Manual service control once SSH'd in:
  ```
  /usr/local/etc/config/rc.d/matter-homematic restart
  /usr/local/etc/config/rc.d/matter-homematic info
  ```

## Cleaning up

To completely remove the addon: in the WebUI *Zusatzsoftware* page, click *Deinstallieren* on the matter-homematic entry. This invokes `rc.d/matter-homematic uninstall`, which removes `/usr/local/addons/matter-homematic/`, the rc.d entry, the WebUI tile, and the addon config dir.
