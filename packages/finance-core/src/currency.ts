import { isIsoDate } from './date-range.js';

export interface ExchangeRate {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /** Positive decimal string, avoiding binary floating-point arithmetic. */
  readonly rate: string;
  /** Rate becomes applicable on this civil date and later dates. */
  readonly effectiveDate: string;
  /** Provenance label; the built-in settings UI records rates as "manual". */
  readonly source: string;
}

export interface CurrencyConversion {
  readonly amountMinor: number | null;
  readonly fromCurrency: string | null;
  readonly toCurrency: string;
  readonly rate: string | null;
  readonly effectiveDate: string | null;
  readonly source: string | null;
  readonly inverseRate: boolean;
  readonly warning?: string;
}

export interface ExchangeRateUsage {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: string;
  readonly effectiveDate: string;
  readonly source: string;
  readonly inverseRate: boolean;
  readonly transactionCount: number;
}

interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function rateFraction(value: string): Fraction | null {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/.test(value)) return null;
  const [whole = '0', fractional = ''] = value.split('.');
  const denominator = 10n ** BigInt(fractional.length);
  const numerator = BigInt(whole + fractional);
  return numerator > 0n ? { numerator, denominator } : null;
}

function selectRate(
  fromCurrency: string,
  toCurrency: string,
  date: string,
  rates: readonly ExchangeRate[],
): { rate: ExchangeRate; inverseRate: boolean; fraction: Fraction } | null {
  const candidates = rates
    .filter((candidate) => candidate.effectiveDate <= date && isIsoDate(candidate.effectiveDate))
    .map((rate) => {
      const rateFrom = normalizeCurrencyCode(rate.fromCurrency);
      const rateTo = normalizeCurrencyCode(rate.toCurrency);
      const fraction = rateFraction(rate.rate);
      if (!rateFrom || !rateTo || !fraction || rateFrom === rateTo) return null;
      if (rateFrom === fromCurrency && rateTo === toCurrency) {
        return { rate, inverseRate: false, fraction };
      }
      if (rateFrom === toCurrency && rateTo === fromCurrency) {
        return {
          rate,
          inverseRate: true,
          fraction: { numerator: fraction.denominator, denominator: fraction.numerator },
        };
      }
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) =>
      right.rate.effectiveDate.localeCompare(left.rate.effectiveDate) ||
      Number(left.inverseRate) - Number(right.inverseRate),
    );
  return candidates[0] ?? null;
}

/** Converts integer minor units with rational arithmetic and half-away-from-zero rounding. */
export function convertAmountMinor(
  amountMinor: number,
  fromInput: string | null | undefined,
  toInput: string,
  date: string,
  rates: readonly ExchangeRate[],
): CurrencyConversion {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('Transaction amount must be a safe integer in minor units.');
  const fromCurrency = normalizeCurrencyCode(fromInput);
  const toCurrency = normalizeCurrencyCode(toInput);
  if (!toCurrency) throw new RangeError('Target currency must be a three-letter ISO currency code.');
  if (!isIsoDate(date)) throw new RangeError('Conversion date must use YYYY-MM-DD.');

  if (!fromCurrency) {
    return {
      amountMinor: null, fromCurrency: null, toCurrency, rate: null, effectiveDate: null, source: null,
      inverseRate: false,
      warning: 'Divisa de origen desconocida; el importe no se consolida en el análisis.',
    };
  }
  if (fromCurrency === toCurrency) {
    return {
      amountMinor, fromCurrency, toCurrency, rate: '1', effectiveDate: date, source: 'identity', inverseRate: false,
    };
  }

  const applicable = selectRate(fromCurrency, toCurrency, date, rates);
  if (!applicable) {
    return {
      amountMinor: null, fromCurrency, toCurrency, rate: null, effectiveDate: null, source: null,
      inverseRate: false,
      warning: 'Falta un tipo de cambio local válido de ' + fromCurrency + ' a ' + toCurrency + ' para ' + date + '; el importe no se consolida.',
    };
  }

  const product = BigInt(amountMinor) * applicable.fraction.numerator;
  const denominator = applicable.fraction.denominator;
  const absoluteProduct = product < 0n ? -product : product;
  const roundedAbsolute = (absoluteProduct + denominator / 2n) / denominator;
  const rounded = product < 0n ? -roundedAbsolute : roundedAbsolute;
  const converted = Number(rounded);
  if (!Number.isSafeInteger(converted)) throw new RangeError('Converted amount exceeds the safe integer range.');

  return {
    amountMinor: converted,
    fromCurrency,
    toCurrency,
    rate: applicable.rate.rate,
    effectiveDate: applicable.rate.effectiveDate,
    source: applicable.rate.source,
    inverseRate: applicable.inverseRate,
  };
}
