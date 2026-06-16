/* eslint-disable -- generated from TypeScript source; run npm run build:tavern */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}
function normalizeLoadBatchSize(value, fallback = 20) {
  const clamped = clampInteger(value, fallback, 5, 50);
  return Math.min(50, Math.max(5, Math.round(clamped / 5) * 5));
}
function normalizeTavernDisplaySettings(value = {}) {
  const settings = asRecord(value);
  return {
    hiddenOutsideCount: clampInteger(settings.hiddenOutsideCount, 5, 1, 20),
    loadBatchSize: normalizeLoadBatchSize(settings.loadBatchSize, 20)
  };
}
export {
  normalizeTavernDisplaySettings
};
