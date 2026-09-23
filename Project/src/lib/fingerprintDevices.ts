export type SelectedFingerprintDevice = {
  uid: string;
  label: string;
};

export function readCapturedFingerprintSample(samplesPayload: string): string {
  const captured: unknown = JSON.parse(samplesPayload);
  if (!Array.isArray(captured) || captured.length === 0) {
    throw new Error('The reader returned an empty fingerprint sample');
  }
  const sample = captured[0];
  if (typeof sample === 'string' && sample.trim()) return sample.trim();
  if (sample && typeof sample === 'object') {
    // ADC versions may return a BioSample object ({ Data, Format, ... })
    // instead of its already encoded representation. Keep the wrapper so the
    // server can validate it and safely extract the nested feature data.
    return Fingerprint.strToB64Url(JSON.stringify(sample));
  }
  throw new Error('The reader returned an unsupported fingerprint sample');
}

export async function selectPreferredFingerprintDevice(
  api: Fingerprint.WebApi,
  deviceUids: string[],
): Promise<SelectedFingerprintDevice | null> {
  const devices = await Promise.all(deviceUids.map(async (uid) => {
    try {
      return { uid, info: await api.getDeviceInfo(uid) };
    } catch {
      return { uid, info: null };
    }
  }));

  // The external U.are.U 4000B is optical. The laptop's integrated Goodix
  // reader is capacitive, so optical is the safest deterministic preference.
  const selected = devices.find(({ info }) => info?.eDeviceTech === Fingerprint.DeviceTechnology.Optical)
    ?? devices.find(({ info }) => info?.eDeviceModality === Fingerprint.DeviceModality.Area)
    ?? devices[0];

  if (!selected) return null;
  const label = selected.info?.eDeviceTech === Fingerprint.DeviceTechnology.Optical
    ? 'External optical reader'
    : selected.info?.eDeviceTech === Fingerprint.DeviceTechnology.Capacitive
      ? 'Integrated capacitive reader'
      : 'Fingerprint reader';
  return { uid: selected.uid, label };
}
