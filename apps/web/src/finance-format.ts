export function formatMoney(amountMinor: number, currency: string, locale: 'es-ES' | 'en-GB' = 'es-ES'): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    return formatUnconvertedMoney(amountMinor, null);
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: normalized, maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amountMinor / 100) + ' ' + normalized;
  }
}

export function formatNullableMoney(amountMinor: number | null, currency: string): string {
  return amountMinor === null ? 'Desconocido' : formatMoney(amountMinor, currency);
}

export function formatUnconvertedMoney(amountMinor: number, currency: string | null | undefined): string {
  if (currency && /^[A-Za-z]{3}$/.test(currency)) return formatMoney(amountMinor, currency);
  return new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amountMinor / 100) + ' (divisa desconocida)';
}

/** Formats an ISO civil date without converting midnight UTC into a different local day. */
export function formatCivilDate(value: string, locale: 'es-ES' | 'en-GB' = 'es-ES'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(parsed);
}

/** Keeps unknown balances distinct from a true zero and labels raw values when conversion is unavailable. */
export function formatAccountBalance(
  originalBalanceMinor: number | null,
  displayBalanceMinor: number | null | undefined,
  displayCurrency: string,
  sourceCurrency: string | null | undefined,
): string {
  if (originalBalanceMinor === null) return 'Saldo desconocido';
  if (displayBalanceMinor !== null && displayBalanceMinor !== undefined) {
    return formatMoney(displayBalanceMinor, displayCurrency);
  }
  return formatUnconvertedMoney(originalBalanceMinor, sourceCurrency);
}
