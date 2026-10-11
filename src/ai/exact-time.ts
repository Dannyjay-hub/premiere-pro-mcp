/** Node-only exact arithmetic. Host scripts continue to use ES3 decimal strings. */
export const PREMIERE_TICKS_PER_SECOND = 254016000000n;
export interface RationalRate { numerator: number; denominator: number }
export type Rounding = "floor" | "ceil" | "nearest";

export function ticks(value: unknown, label = "ticks"): bigint {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]{0,39})$/.test(value) || value === "-0") throw new Error(`${label} must be a canonical decimal tick string (maximum 40 digits)`);
  return BigInt(value);
}
export function rate(value: RationalRate): RationalRate {
  if (!value || !Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator) || value.numerator <= 0 || value.denominator <= 0 || value.numerator > 1000000 || value.denominator > 1000000) throw new Error("rate requires positive integer numerator/denominator up to 1000000");
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
}
export function divide(numerator: bigint, denominator: bigint, rounding: Rounding = "nearest"): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  if (!["floor", "ceil", "nearest"].includes(rounding)) throw new Error("rounding must be floor, ceil or nearest");
  const quotient = numerator / denominator, remainder = numerator % denominator;
  if (!remainder) return quotient;
  if (rounding === "floor") return quotient - (numerator < 0n ? 1n : 0n);
  if (rounding === "ceil") return quotient + (numerator > 0n ? 1n : 0n);
  return quotient + ((remainder < 0n ? -remainder : remainder) * 2n >= denominator ? (numerator < 0n ? -1n : 1n) : 0n);
}
/** Decimal seconds are exact; numeric convenience input retains its decimal spelling. */
export function secondsToTicks(value: string | number, rounding: Rounding = "nearest"): string {
  const spelling = typeof value === "number" && Number.isFinite(value) && /e/i.test(String(value)) && Math.abs(value) < 1e21 ? value.toFixed(18).replace(/\.?0+$/, "") : String(value);
  if (!/^-?(0|[1-9][0-9]{0,20})(\.[0-9]{1,18})?$/.test(spelling)) throw new Error("seconds must be a finite plain decimal with at most 18 fractional digits");
  const negative = spelling.startsWith("-");
  const [whole, fraction = ""] = (negative ? spelling.slice(1) : spelling).split(".");
  return divide(BigInt(whole + fraction) * PREMIERE_TICKS_PER_SECOND * (negative ? -1n : 1n), 10n ** BigInt(fraction.length), rounding).toString();
}
export function frameToTicks(frame: string, frameRate: RationalRate, rounding: Rounding = "nearest"): string {
  const normalized = rate(frameRate);
  return divide(ticks(frame, "frame" ) * PREMIERE_TICKS_PER_SECOND * BigInt(normalized.denominator), BigInt(normalized.numerator), rounding).toString();
}
export function ticksToFrame(value: string, frameRate: RationalRate, rounding: Rounding = "nearest"): string {
  const normalized = rate(frameRate);
  return divide(ticks(value) * BigInt(normalized.numerator), PREMIERE_TICKS_PER_SECOND * BigInt(normalized.denominator), rounding).toString();
}
export function sampleToTicks(sample: string, sampleRate: number, rounding: Rounding = "nearest"): string {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000) throw new Error("sample_rate must be an integer from 1 to 768000");
  return divide(ticks(sample, "sample") * PREMIERE_TICKS_PER_SECOND, BigInt(sampleRate), rounding).toString();
}
function timecodeRate(frameRate: RationalRate, dropFrame: boolean): { nominal: bigint; drop: bigint } {
  const r = rate(frameRate), nominal = Math.round(r.numerator / r.denominator);
  if (nominal < 1 || nominal > 240) throw new Error("timecode frame rate must lie between 1 and 240");
  if (dropFrame && !(r.denominator === 1001 && (r.numerator === 30000 || r.numerator === 60000))) throw new Error("drop-frame timecode supports only 30000/1001 or 60000/1001");
  return { nominal: BigInt(nominal), drop: dropFrame ? BigInt(nominal / 15) : 0n };
}
/** Unwrapped hours, signed display offsets, exclusive ends remain frame positions. */
export function frameToTimecode(frame: string, frameRate: RationalRate, dropFrame = false): string {
  let count = ticks(frame, "frame");
  const negative = count < 0n; if (negative) count = -count;
  const { nominal, drop } = timecodeRate(frameRate, dropFrame);
  if (drop) {
    const perMinute = nominal * 60n - drop, perTen = nominal * 600n - drop * 9n;
    const blocks = count / perTen, rest = count % perTen;
    count += drop * 9n * blocks + (rest >= drop ? drop * ((rest - drop) / perMinute) : 0n);
  }
  const frames = count % nominal, totalSeconds = count / nominal;
  const pad = (n: bigint) => n.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${pad(totalSeconds / 3600n)}:${pad(totalSeconds / 60n % 60n)}:${pad(totalSeconds % 60n)}${drop ? ";" : ":"}${pad(frames)}`;
}
export function timecodeToFrame(value: string, frameRate: RationalRate, dropFrame = false): string {
  const match = /^(-?)([0-9]{2,10}):([0-5][0-9]):([0-5][0-9])([:;])([0-9]{2,3})$/.exec(value);
  if (!match || (match[5] === ";") !== dropFrame) throw new Error("timecode separator or fields do not match declared policy");
  const { nominal, drop } = timecodeRate(frameRate, dropFrame);
  const hours = BigInt(match[2]), minutes = BigInt(match[3]), seconds = BigInt(match[4]), frames = BigInt(match[6]);
  if (frames >= nominal || (drop && minutes % 10n !== 0n && seconds === 0n && frames < drop)) throw new Error("timecode names a skipped or out-of-range frame");
  const totalMinutes = hours * 60n + minutes;
  const count = ((hours * 3600n + minutes * 60n + seconds) * nominal + frames) - drop * (totalMinutes - totalMinutes / 10n);
  return ((match[1] ? -1n : 1n) * count).toString();
}

export const RATE_PARAMETER = { type: "object", additionalProperties: false, description: "Exact rational frames per second; e.g. 30000/1001.", properties: { numerator: { type: "integer", minimum: 1, maximum: 1000000, description: "Positive numerator." }, denominator: { type: "integer", minimum: 1, maximum: 1000000, description: "Positive denominator." } }, required: ["numerator", "denominator"] };
