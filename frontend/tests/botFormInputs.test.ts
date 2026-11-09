/**
 * The bot form's number inputs must accept the values the form actually holds.
 *
 * A browser blocks submission, silently, when a number input's value breaks
 * its own `min`/`step` constraint: with `min` set, the valid values are
 * `min + n·step`. "Max. investment per order" had `min={0.01}` with
 * `step={0.1}` (or 1), so its default 5 was invalid — the Create Bot form
 * could not be submitted at its defaults. The same rule applies to EditBot,
 * which shares the component and loads whatever the API stored (the API
 * accepts e.g. a 2.25 % stop or a 50.5 % entry volume).
 *
 * The backend zod schema is the authority on ranges; these inputs keep `min`
 * as a hint and must not add a stricter grid than the API's.
 *
 * Source-level, in the idiom of `protectiveOrders.test.ts`: there is no DOM
 * harness here, so the constraints are read from the component and checked
 * with the browser's step-mismatch rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultBotForm, type BotFormState } from "../src/lib/botForm.js";

const component = fs.readFileSync(
  path.join(import.meta.dirname, "..", "src", "components", "BotFormFields.tsx"), "utf8");

interface NumberInput { field: keyof BotFormState; min: number | null; steps: Array<number | "any"> }

/** Every `type="number"` input: the form field it shows, its min, and its step(s). */
function numberInputs(): NumberInput[] {
  const found: NumberInput[] = [];
  let at = component.indexOf('type="number"');
  while (at !== -1) {
    const start = component.lastIndexOf("<", at);
    const end = component.indexOf("/>", at);
    const tag = component.slice(start, end);
    const field = /value=\{(?:String\()?form\.(\w+)/.exec(tag)?.[1] as keyof BotFormState | undefined;
    assert.ok(field, `a number input without a recognisable value: ${tag.slice(0, 80)}`);
    const min = /min=\{([\d.]+)\}/.exec(tag);
    const stepAttr = /step=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag);
    let steps: Array<number | "any"> = [1]; // the HTML default
    if (stepAttr?.[1] !== undefined) {
      steps = [stepAttr[1] === "any" ? "any" : Number(stepAttr[1])];
    } else if (stepAttr?.[2] !== undefined) {
      // A literal, or `cond ? a : b`: every branch the browser can see.
      const branches = /\?\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(stepAttr[2].trim());
      steps = branches ? [Number(branches[1]), Number(branches[2])] : [Number(stepAttr[2])];
    }
    found.push({ field, min: min ? Number(min[1]) : null, steps });
    at = component.indexOf('type="number"', end);
  }
  return found;
}

/** The browser's rule: under `min`, or off the `min + n·step` grid, blocks submit. */
function constraintError(value: number, input: NumberInput, step: number | "any"): string | null {
  if (input.min !== null && value < input.min) return `${value} is below min ${input.min}`;
  if (step === "any") return null;
  const base = input.min ?? 0;
  const n = (value - base) / step;
  return Math.abs(n - Math.round(n)) < 1e-9 ? null : `${value} is off the ${base} + n·${step} grid`;
}

function assertAccepts(field: keyof BotFormState, value: number): void {
  const inputs = numberInputs().filter((i) => i.field === field);
  assert.ok(inputs.length > 0, `no number input shows ${field}`);
  for (const input of inputs) {
    for (const step of input.steps) {
      const error = constraintError(value, input, step);
      assert.equal(error, null, `${field}: ${error} (step ${step}) — the browser would block submit`);
    }
  }
}

test("every number input in the bot form is found and bound to a form field", () => {
  const fields = numberInputs().map((i) => i.field).sort();
  assert.deepEqual(fields, [
    "entryVolumePct", "maxActiveSmartTrades", "maxInvestmentPct", "stopLossPct", "takeProfitPct",
  ]);
});

test("Create Bot: the default values satisfy every number input's constraints", () => {
  for (const input of numberInputs()) {
    assertAccepts(input.field, defaultBotForm[input.field] as number);
  }
});

test("Edit Bot: values the API accepts and stores are not blocked by a stricter step grid", () => {
  // Each is valid for the backend schema in routes/bots.ts.
  const stored: Array<[keyof BotFormState, number[]]> = [
    ["maxInvestmentPct", [0.01, 5, 7.5, 2.25, 250]],
    ["entryVolumePct", [1, 50.5, 100]],
    ["takeProfitPct", [0.25, 5, 12.5]],
    ["stopLossPct", [0.25, 2.75, 3]],
    ["maxActiveSmartTrades", [1, 2, 10]],
  ];
  for (const [field, values] of stored) {
    for (const value of values) assertAccepts(field, value);
  }
});
