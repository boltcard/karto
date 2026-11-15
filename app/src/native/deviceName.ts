// The name cardd lists this phone under (cardd device list), from
// expo-device's modelName, e.g. "Pixel 9a".

const MAX = 40;

export function deviceName(modelName: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const name = (modelName ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, MAX) : 'Android phone';
}
