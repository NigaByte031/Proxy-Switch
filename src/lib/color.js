/**
 * Colour maths behind the custom accent: parsing what the picker gives, a WCAG
 * contrast check, and the brand tokens derived from the one colour chosen. Pure
 * and dependency-free, so the settings page and the unit tests share it.
 */

/** The colour a fresh "custom" accent starts from: the shipped emerald. */
export const DEFAULT_CUSTOM_ACCENT = '#0e9f6e';

/** Splits `#rgb` or `#rrggbb` (the `#` optional) into `{r, g, b}`; null otherwise. */
export function parseHex(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return {
      r: parseInt(text[0] + text[0], 16),
      g: parseInt(text[1] + text[1], 16),
      b: parseInt(text[2] + text[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(text)) {
    return {
      r: parseInt(text.slice(0, 2), 16),
      g: parseInt(text.slice(2, 4), 16),
      b: parseInt(text.slice(4, 6), 16),
    };
  }
  return null;
}

const clampChannel = (value) => Math.max(0, Math.min(255, Math.round(value)));

/** `{r, g, b}` -> `#rrggbb`. */
export function toHex(rgb) {
  const part = (value) => clampChannel(value).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** The sanitiser: any spelling the picker accepts becomes `#rrggbb`, or null. */
export function normalizeHex(value) {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

/** Blends two colours; `weight` is how much of `b` the result carries (0..1). */
export function mixHex(a, b, weight) {
  const from = parseHex(a);
  const to = parseHex(b);
  if (!from || !to) return normalizeHex(a) ?? normalizeHex(b) ?? DEFAULT_CUSTOM_ACCENT;
  const ratio = Math.max(0, Math.min(1, Number(weight) || 0));
  return toHex({
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  });
}

/** Relative luminance as WCAG defines it (`#rrggbb` in, 0..1 out). */
export function relativeLuminance(value) {
  const rgb = parseHex(value);
  if (!rgb) return 0;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, from 1 (alike) to 21 (opposites). */
export function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Black or white, whichever reads more plainly on the given colour. */
export function readableTextColour(value) {
  return contrastRatio(value, '#000000') >= contrastRatio(value, '#ffffff')
    ? '#000000'
    : '#ffffff';
}

/**
 * The brand tokens a custom accent writes inline. The chosen colour is the accent;
 * its darker blends head the gradient, and the label colour is the one that stays
 * legible on it. The theme-tinted tokens are derived in `base.css`, not here.
 */
export function customAccentTokens(value) {
  const base = normalizeHex(value) ?? DEFAULT_CUSTOM_ACCENT;
  const brandOne = mixHex(base, '#000000', 0.16);
  const brandTwo = mixHex(base, '#000000', 0.3);
  return {
    '--accent': base,
    '--accent-2': mixHex(base, '#000000', 0.08),
    '--brand-1': brandOne,
    '--brand-2': brandTwo,
    '--brand-contrast': readableTextColour(brandOne),
  };
}

/** What the picker says under the colour: the normalised value and its contrast. */
export function describeCustomAccent(value) {
  const hex = normalizeHex(value);
  if (!hex) return null;
  return {
    hex,
    label: readableTextColour(hex),
    onWhite: contrastRatio(hex, '#ffffff'),
    onBlack: contrastRatio(hex, '#000000'),
  };
}
