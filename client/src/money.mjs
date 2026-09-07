export function toMinor(value, precision) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) throw Error('Enter a positive amount using digits and a decimal point');
  const [whole, fraction = ''] = value.trim().split('.');
  if (fraction.length > precision) throw Error(`This currency uses ${precision} decimal places`);
  const result = Number(whole) * 10 ** precision + Number(fraction.padEnd(precision, '0'));
  if (!Number.isSafeInteger(result) || result < 0 || result > 1000000000000) throw Error('Amount is too large');
  return result;
}
export const fromMinor = (value, precision) => (value / 10 ** precision).toFixed(precision);
