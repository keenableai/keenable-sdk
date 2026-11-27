import { count, num, objects } from "./internal.js";
import type { Money, Usage, UsageItem } from "./types.js";

const DECIMAL = /^-?[0-9]+(\.[0-9]{1,9})?$/;
const NANOS = 1_000_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A Money as `{amount, currency}`, with `amount` an exact decimal string: the
 * API's string `amount` (backend #947), else an older server's
 * `amount_decimal`, else its number written with at most nine decimals, else
 * "0". Never read through a float when a string was sent.
 */
export function toMoney(value: unknown): Money {
  const data = isRecord(value) ? value : {};
  return { amount: moneyAmount(data), currency: text(data.currency) };
}

/** A Money when the value is an object, else undefined. */
export function optionalMoney(value: unknown): Money | undefined {
  return isRecord(value) ? toMoney(value) : undefined;
}

function moneyAmount(data: Record<string, unknown>): string {
  if (typeof data.amount === "string" && DECIMAL.test(data.amount)) return data.amount;
  if (typeof data.amount_decimal === "string" && DECIMAL.test(data.amount_decimal)) return data.amount_decimal;
  const sent = num(data.amount);
  if (sent === null) return "0";
  const fixed = sent.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

/** A plain decimal string (at most nine places) as integer nano-dollars. */
function toNanos(amount: string): bigint {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const nanos = BigInt(whole) * NANOS + BigInt(fraction.padEnd(9, "0") || "0");
  return negative ? -nanos : nanos;
}

/** Integer nano-dollars as a decimal string: no trailing zeros, "0" for zero. */
function fromNanos(nanos: bigint): string {
  const negative = nanos < 0n;
  const abs = negative ? -nanos : nanos;
  const fraction = (abs % NANOS).toString().padStart(9, "0").replace(/0+$/, "");
  const out = `${abs / NANOS}${fraction ? `.${fraction}` : ""}`;
  return negative && abs !== 0n ? `-${out}` : out;
}

/** `amount / quantity` to the nano-dollar, halves away from zero. */
function divide(amount: string, quantity: number): string {
  if (quantity === 0) return "0";
  const nanos = toNanos(amount);
  const q = BigInt(quantity);
  const abs = nanos < 0n ? -nanos : nanos;
  const rounded = (abs * 2n + q) / (2n * q);
  return fromNanos(nanos < 0n ? -rounded : rounded);
}

function deprecatedFields(data: Record<string, unknown>) {
  const remaining = num(data.credits_remaining);
  return {
    sku: text(data.sku),
    amount: count(data.amount) ?? 0,
    credits: num(data.credits) ?? 0,
    paid: data.paid === true,
    ...(remaining !== null && { credits_remaining: remaining }),
  };
}

/**
 * Reads a usage object into the standard shape. The standard object (backend
 * #951) has an `items` list; anything else is the old shape
 * `{sku, amount, credits, paid, credits_remaining?, cost?, balance?}`, whose
 * one item is priced at `cost / amount` and whose total is `cost` (0 in usd
 * when the server sent no cost). Undefined unless the value is an object.
 */
export function toUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const balance = optionalMoney(value.balance);
  let items: UsageItem[];
  let total: Money;
  if (Array.isArray(value.items)) {
    items = objects(value.items).map((item) => ({
      sku: text(item.sku),
      quantity: count(item.quantity) ?? 0,
      price: toMoney(item.price),
    }));
    total = toMoney(value.total);
  } else {
    const cost = optionalMoney(value.cost);
    const quantity = count(value.amount) ?? 0;
    const hasSku = typeof value.sku === "string" && value.sku.trim() !== "";
    items =
      hasSku || cost
        ? [
            {
              sku: text(value.sku),
              quantity,
              price: cost
                ? { amount: divide(cost.amount, quantity), currency: cost.currency }
                : { amount: "0", currency: "usd" },
            },
          ]
        : [];
    total = cost ?? { amount: "0", currency: "usd" };
  }
  return { items, total, ...(balance && { balance }), ...deprecatedFields(value) };
}

/**
 * The call's usage for a fetch. The body's own usage when it is an object;
 * else (an older server, which billed each page on its own) the pages' usage
 * merged: items by sku and price, quantities added, totals summed exactly,
 * and the last page balance. Undefined when nothing carried usage.
 */
export function fetchUsage(body: unknown, pages: (Usage | undefined)[]): Usage | undefined {
  const own = toUsage(body);
  if (own) return own;
  const billed = pages.filter((u): u is Usage => u !== undefined);
  if (billed.length === 0) return undefined;
  const items: UsageItem[] = [];
  let sum = 0n;
  let balance: Money | undefined;
  for (const usage of billed) {
    for (const item of usage.items) {
      const same = items.find(
        (seen) =>
          seen.sku === item.sku &&
          seen.price.amount === item.price.amount &&
          seen.price.currency === item.price.currency,
      );
      if (same) same.quantity += item.quantity;
      else items.push({ sku: item.sku, quantity: item.quantity, price: { ...item.price } });
    }
    sum += toNanos(usage.total.amount);
    if (usage.balance) balance = usage.balance;
  }
  const currency = billed[0]?.total.currency ?? "usd";
  return {
    items,
    total: { amount: fromNanos(sum), currency },
    ...(balance && { balance }),
    sku: "",
    amount: 0,
    credits: 0,
    paid: false,
  };
}
