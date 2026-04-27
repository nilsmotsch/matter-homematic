import { DeviceMapper, MatterDeviceType } from '../../src/devices/DeviceMapper';

describe('DeviceMapper', () => {
  let mapper: DeviceMapper;

  beforeEach(() => {
    mapper = new DeviceMapper();
  });

  describe('mapChannel', () => {
    it('maps SWITCH channel to OnOffPlugInUnit', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'SWITCH', 'HM-LC-Sw1-FM', 'Test Switch', { STATE: false });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OnOffPlugInUnit);
    });

    it('maps SWITCH_VIRTUAL_RECEIVER to OnOffPlugInUnit', () => {
      const result = mapper.mapChannel('HmIP.001:3', 'SWITCH_VIRTUAL_RECEIVER', 'HmIP-PSM', 'IP Switch', { STATE: true });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OnOffPlugInUnit);
    });

    it('maps DIMMER channel to DimmableLight', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'DIMMER', 'HM-LC-Dim1-FM', 'Dimmer', { LEVEL: 0.5 });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.DimmableLight);
    });

    it('maps BLIND channel to WindowCovering', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'BLIND', 'HM-LC-Bl1', 'Blind', { LEVEL: 0.0 });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.WindowCovering);
    });

    it('maps CLIMATECONTROL_RT_TRANSCEIVER to Thermostat', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:4', 'CLIMATECONTROL_RT_TRANSCEIVER', 'HM-CC-RT-DN', 'Thermostat', { ACTUAL_TEMPERATURE: 21.5, SET_TEMPERATURE: 22.0 });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.Thermostat);
    });

    it('maps HEATING_CLIMATECONTROL_TRANSCEIVER to Thermostat', () => {
      const result = mapper.mapChannel('HmIP.001:1', 'HEATING_CLIMATECONTROL_TRANSCEIVER', 'HmIP-eTRV-2', 'IP Thermostat', { ACTUAL_TEMPERATURE: 20.0, SET_POINT_TEMPERATURE: 21.0 });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.Thermostat);
    });

    it('maps SHUTTER_CONTACT to ContactSensor', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'SHUTTER_CONTACT', 'HM-Sec-SC-2', 'Door', { STATE: false });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.ContactSensor);
    });

    it('maps MOTION_DETECTOR to OccupancySensor', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'MOTION_DETECTOR', 'HM-Sec-MDIR-2', 'Motion', { MOTION: false });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OccupancySensor);
    });

    it('maps WEATHER to TemperatureSensor', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'WEATHER', 'HM-WDS100-C6-O-2', 'Weather', { TEMPERATURE: 18.3 });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.TemperatureSensor);
    });

    it('maps KEYMATIC to DoorLock', () => {
      const result = mapper.mapChannel('BidCos-RF.LEQ1234567:1', 'KEYMATIC', 'HM-Sec-Key', 'Lock', { STATE: false });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.DoorLock);
    });

    it('returns null for unknown channel type', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN_TYPE', 'UNKNOWN', 'Unknown', {});
      expect(result).toBeNull();
    });

    it('skips MAINTENANCE channels even when device type matches a pattern', () => {
      // Regression: HM-LC-Bl1-FM:0 is the MAINTENANCE channel; without the
      // guard, device-type fallback would wrongly map it to WindowCovering.
      const result = mapper.mapChannel('VCU0000045:0', 'MAINTENANCE', 'HM-LC-Bl1-FM', '', {});
      expect(result).toBeNull();
    });

    it('skips MAINTENANCE_VIRTUAL_RECEIVER channels', () => {
      const result = mapper.mapChannel('HmIP.001:0', 'MAINTENANCE_VIRTUAL_RECEIVER', 'HmIP-PSM', '', {});
      expect(result).toBeNull();
    });

    it('infers channel type from device type when channel type is unknown', () => {
      const result = mapper.mapChannel('HmIP.001:3', 'UNKNOWN', 'HmIP-PSM', 'IP Switch', { STATE: true });
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OnOffPlugInUnit);
    });
  });

  describe('value conversions', () => {
    describe('level/brightness (HM 0.0-1.0 <-> Matter 0-254)', () => {
      beforeEach(() => {
        mapper.mapChannel('ADDR:1', 'DIMMER', 'HM-LC-Dim1', 'Dimmer', { LEVEL: 0.5 });
      });

      it('converts HM LEVEL to Matter onOff (first matching mapping)', () => {
        // The DIMMER mapping has STATE and LEVEL both keyed to hmKey 'LEVEL'.
        // convertToMatter returns the first match, which is STATE -> onOff.
        expect(mapper.convertToMatter('ADDR:1', 'LEVEL', 0.0)).toEqual({ cluster: 'onOff', attribute: 'onOff', value: false });
        expect(mapper.convertToMatter('ADDR:1', 'LEVEL', 1.0)).toEqual({ cluster: 'onOff', attribute: 'onOff', value: true });
        expect(mapper.convertToMatter('ADDR:1', 'LEVEL', 0.5)).toEqual({ cluster: 'onOff', attribute: 'onOff', value: true });
      });

      it('converts Matter level to HM level', () => {
        const result = mapper.convertToHomematic('ADDR:1', 'levelControl', 'currentLevel', 254);
        expect(result).toEqual({ key: 'LEVEL', value: 1.0 });
      });

      it('converts Matter onOff to HM level for dimmer', () => {
        expect(mapper.convertToHomematic('ADDR:1', 'onOff', 'onOff', true)).toEqual({ key: 'LEVEL', value: 1.0 });
        expect(mapper.convertToHomematic('ADDR:1', 'onOff', 'onOff', false)).toEqual({ key: 'LEVEL', value: 0 });
      });
    });

    describe('temperature (HM °C <-> Matter 0.01°C units)', () => {
      beforeEach(() => {
        mapper.mapChannel('ADDR:4', 'CLIMATECONTROL_RT_TRANSCEIVER', 'HM-CC-RT-DN', 'Thermo', { ACTUAL_TEMPERATURE: 21.5 });
      });

      it('converts HM temperature to Matter', () => {
        expect(mapper.convertToMatter('ADDR:4', 'ACTUAL_TEMPERATURE', 21.5)).toEqual({ cluster: 'thermostat', attribute: 'localTemperature', value: 2150 });
        expect(mapper.convertToMatter('ADDR:4', 'ACTUAL_TEMPERATURE', 0)).toEqual({ cluster: 'thermostat', attribute: 'localTemperature', value: 0 });
      });

      it('converts Matter temperature to HM', () => {
        const result = mapper.convertToHomematic('ADDR:4', 'thermostat', 'localTemperature', 2150);
        expect(result).toEqual({ key: 'ACTUAL_TEMPERATURE', value: 21.5 });
      });
    });

    describe('blind position - INVERTED (HM 0=closed/1=open <-> Matter 0=open/10000=closed)', () => {
      beforeEach(() => {
        mapper.mapChannel('ADDR:1', 'BLIND', 'HM-LC-Bl1', 'Blind', { LEVEL: 0.0 });
      });

      it('converts HM fully closed to Matter fully closed', () => {
        const result = mapper.convertToMatter('ADDR:1', 'LEVEL', 0.0);
        expect(result!.value).toBe(10000); // Matter 10000 = closed
      });

      it('converts HM fully open to Matter fully open', () => {
        const result = mapper.convertToMatter('ADDR:1', 'LEVEL', 1.0);
        expect(result!.value).toBe(0); // Matter 0 = open
      });

      it('converts Matter fully open to HM fully open', () => {
        const result = mapper.convertToHomematic('ADDR:1', 'windowCovering', 'currentPositionLiftPercent100ths', 0);
        expect(result!.value).toBe(1.0); // HM 1.0 = open
      });

      it('converts Matter fully closed to HM fully closed', () => {
        const result = mapper.convertToHomematic('ADDR:1', 'windowCovering', 'currentPositionLiftPercent100ths', 10000);
        expect(result!.value).toBe(0.0); // HM 0.0 = closed
      });
    });

    describe('blind tilt (HmIP-FBL venetian LEVEL_2 exposed as TiltPercent100ths)', () => {
      it('detects tilt when LEVEL_2 is a number (venetian) and maps both lift and tilt', () => {
        const result = mapper.mapChannel(
          'HMIP-FBL:4', 'BLIND_VIRTUAL_RECEIVER', 'HmIP-FBL', 'Rolladen',
          { LEVEL: 0.5, LEVEL_2: 0.25 }
        );
        expect(result).not.toBeNull();
        expect(result!.hasTilt).toBe(true);

        expect(mapper.convertToMatter('HMIP-FBL:4', 'LEVEL_2', 0.0)!.value).toBe(10000);
        expect(mapper.convertToMatter('HMIP-FBL:4', 'LEVEL_2', 1.0)!.value).toBe(0);
        expect(mapper.convertToHomematic('HMIP-FBL:4', 'windowCovering', 'currentPositionTiltPercent100ths', 0)!.value).toBe(1.0);
        expect(mapper.convertToHomematic('HMIP-FBL:4', 'windowCovering', 'currentPositionTiltPercent100ths', 10000)!.value).toBe(0.0);
      });

      it('strips LEVEL_2 when it is the empty string (roller/screen/awning mode)', () => {
        const result = mapper.mapChannel(
          'HMIPW-DRBL4:2', 'BLIND_VIRTUAL_RECEIVER', 'HmIPW-DRBL4', 'Rolladen Arbeitszimmer',
          { LEVEL: 0.0, LEVEL_2: '' }
        );
        expect(result).not.toBeNull();
        expect(result!.hasTilt).toBeUndefined();
        // No tilt conversion should be wired up
        expect(mapper.convertToMatter('HMIPW-DRBL4:2', 'LEVEL_2', 0.5)).toBeNull();
        expect(mapper.convertToHomematic('HMIPW-DRBL4:2', 'windowCovering', 'currentPositionTiltPercent100ths', 5000)).toBeNull();
        // Lift still works
        expect(mapper.convertToMatter('HMIPW-DRBL4:2', 'LEVEL', 0.0)!.value).toBe(10000);
      });

      it('does not mutate the shared mapping when stripping LEVEL_2 on one channel', () => {
        // Roller channel first — strips LEVEL_2 from its own clone
        mapper.mapChannel('ROLL:1', 'BLIND_VIRTUAL_RECEIVER', 'HmIPW-DRBL4', 'Roller', { LEVEL: 0.0, LEVEL_2: '' });
        // A later venetian channel must still get LEVEL_2 wired up
        const venetian = mapper.mapChannel('VEN:4', 'BLIND_VIRTUAL_RECEIVER', 'HmIP-FBL', 'Venetian', { LEVEL: 0.0, LEVEL_2: 0.5 });
        expect(venetian!.hasTilt).toBe(true);
        expect(mapper.convertToMatter('VEN:4', 'LEVEL_2', 0.5)!.value).toBe(5000);
      });

      describe('tiltOverride (user-configured via web UI)', () => {
        it('forces lift-only when tiltOverride=false even if LEVEL_2 is numeric', () => {
          // HmIP-FBL always reports LEVEL_2 numeric, but the user physically
          // wired a roller — they set the override in the UI to hide tilt.
          const result = mapper.mapChannel(
            'FBL-ROLLER:4', 'BLIND_VIRTUAL_RECEIVER', 'HmIP-FBL', 'Physical roller',
            { LEVEL: 0.5, LEVEL_2: 1.0 }, undefined, false,
          );
          expect(result!.hasTilt).toBeUndefined();
          expect(mapper.convertToMatter('FBL-ROLLER:4', 'LEVEL_2', 0.5)).toBeNull();
        });

        it('forces tilt when tiltOverride=true even if LEVEL_2 is the empty string', () => {
          // Contrived but symmetric: user overrides a channel we'd auto-classify
          // as roller. Still drive tilt mappings.
          const result = mapper.mapChannel(
            'FORCE-TILT:1', 'BLIND_VIRTUAL_RECEIVER', 'HmIPW-DRBL4', 'Force tilt',
            { LEVEL: 0.0, LEVEL_2: '' }, undefined, true,
          );
          expect(result!.hasTilt).toBe(true);
          expect(result!.valueMappings.LEVEL_2).toBeDefined();
        });

        it('falls back to auto-detection when tiltOverride is undefined', () => {
          const result = mapper.mapChannel(
            'AUTO:4', 'BLIND_VIRTUAL_RECEIVER', 'HmIP-FBL', 'Auto',
            { LEVEL: 0.5, LEVEL_2: 0.25 }, undefined, undefined,
          );
          expect(result!.hasTilt).toBe(true);
        });
      });
    });

    describe('contact sensor - INVERTED (HM true=open <-> Matter false=contact)', () => {
      beforeEach(() => {
        mapper.mapChannel('ADDR:1', 'SHUTTER_CONTACT', 'HM-Sec-SC-2', 'Contact', { STATE: false });
      });

      it('converts HM open (true) to Matter no-contact (false)', () => {
        const result = mapper.convertToMatter('ADDR:1', 'STATE', true);
        expect(result!.value).toBe(false);
      });

      it('converts HM closed (false) to Matter contact (true)', () => {
        const result = mapper.convertToMatter('ADDR:1', 'STATE', false);
        expect(result!.value).toBe(true);
      });
    });

    describe('door lock (HM true=unlocked <-> Matter 1=locked/2=unlocked)', () => {
      beforeEach(() => {
        mapper.mapChannel('ADDR:1', 'KEYMATIC', 'HM-Sec-Key', 'Lock', { STATE: false });
      });

      it('converts HM unlocked to Matter unlocked (2)', () => {
        const result = mapper.convertToMatter('ADDR:1', 'STATE', true);
        expect(result!.value).toBe(2);
      });

      it('converts HM locked to Matter locked (1)', () => {
        const result = mapper.convertToMatter('ADDR:1', 'STATE', false);
        expect(result!.value).toBe(1);
      });

      it('converts Matter unlocked to HM unlocked', () => {
        const result = mapper.convertToHomematic('ADDR:1', 'doorLock', 'lockState', 2);
        expect(result!.value).toBe(true);
      });

      it('converts Matter locked to HM locked', () => {
        const result = mapper.convertToHomematic('ADDR:1', 'doorLock', 'lockState', 1);
        expect(result!.value).toBe(false);
      });
    });
  });

  describe('convertToMatter / convertToHomematic', () => {
    it('returns null for unknown address', () => {
      expect(mapper.convertToMatter('NONEXISTENT:1', 'STATE', true)).toBeNull();
      expect(mapper.convertToHomematic('NONEXISTENT:1', 'onOff', 'onOff', true)).toBeNull();
    });

    it('returns null for unknown HM key', () => {
      mapper.mapChannel('ADDR:1', 'SWITCH', 'HM-LC-Sw1', 'Switch', { STATE: false });
      expect(mapper.convertToMatter('ADDR:1', 'NONEXISTENT_KEY', true)).toBeNull();
    });

    it('returns null for unknown Matter cluster/attribute', () => {
      mapper.mapChannel('ADDR:1', 'SWITCH', 'HM-LC-Sw1', 'Switch', { STATE: false });
      expect(mapper.convertToHomematic('ADDR:1', 'nonexistent', 'attr', true)).toBeNull();
    });
  });

  describe('inferChannelType (device type pattern matching)', () => {
    it('infers HmIP switch types', () => {
      const result = mapper.mapChannel('ADDR:3', 'UNKNOWN', 'HmIP-PSM', 'Switch', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OnOffPlugInUnit);
    });

    it('infers HmIP dimmer types', () => {
      const result = mapper.mapChannel('ADDR:3', 'UNKNOWN', 'HmIP-BDT', 'Dimmer', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.DimmableLight);
    });

    it('infers HmIP blind types', () => {
      const result = mapper.mapChannel('ADDR:3', 'UNKNOWN', 'HmIP-BROLL', 'Blind', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.WindowCovering);
    });

    it('infers HmIP thermostat types', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN', 'HmIP-eTRV-2', 'Thermostat', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.Thermostat);
    });

    it('infers HmIP contact sensor types', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN', 'HmIP-SWDO', 'Contact', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.ContactSensor);
    });

    it('infers HmIP motion detector types', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN', 'HmIP-SMI', 'Motion', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OccupancySensor);
    });

    it('infers HmIP door lock types', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN', 'HmIP-DLD', 'Lock', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.DoorLock);
    });

    it('infers classic HM switch types', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN', 'HM-LC-Sw1-FM', 'Switch', {});
      expect(result).not.toBeNull();
      expect(result!.matterDeviceType).toBe(MatterDeviceType.OnOffPlugInUnit);
    });

    it('returns null for completely unknown device types', () => {
      const result = mapper.mapChannel('ADDR:1', 'UNKNOWN', 'COMPLETELY-UNKNOWN-DEVICE', 'Unknown', {});
      expect(result).toBeNull();
    });
  });

  describe('initial state conversion', () => {
    it('converts initial HM values to Matter format during mapping', () => {
      const result = mapper.mapChannel('ADDR:1', 'DIMMER', 'HM-LC-Dim1', 'Dimmer', { LEVEL: 0.5 });
      expect(result!.currentState.currentLevel).toBe(127); // 0.5 * 254 = 127
    });

    it('converts initial thermostat values', () => {
      const result = mapper.mapChannel('ADDR:4', 'CLIMATECONTROL_RT_TRANSCEIVER', 'HM-CC-RT-DN', 'Thermo', {
        ACTUAL_TEMPERATURE: 21.5,
        SET_TEMPERATURE: 22.0
      });
      expect(result!.currentState.localTemperature).toBe(2150);
      expect(result!.currentState.occupiedHeatingSetpoint).toBe(2200);
    });
  });
});
