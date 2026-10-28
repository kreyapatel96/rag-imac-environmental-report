import type { CalculationResult } from "./types";

export type Operation = "difference" | "percent_less" | "percent_of" | "sum" | "ratio";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Deterministic arithmetic for derived values; the LLM never does the math. */
export function compute(
  operation: string,
  values: number[],
): { result: number; formula: string } {
  const [a, b] = values;
  switch (operation as Operation) {
    case "sum":
      if (values.length < 2) throw new Error("sum needs at least 2 inputs");
      return { result: round(values.reduce((s, v) => s + v, 0)), formula: values.join(" + ") };
    case "difference":
      need2(values);
      return { result: round(a - b), formula: `${a} − ${b}` };
    case "ratio":
      need2(values);
      if (b === 0) throw new Error("division by zero");
      return { result: round(a / b), formula: `${a} ÷ ${b}` };
    case "percent_of":
      need2(values);
      if (b === 0) throw new Error("division by zero");
      return { result: round((a / b) * 100), formula: `${a} ÷ ${b} × 100` };
    case "percent_less":
      // inputs: [actual, reference] → how much lower actual is than reference, in %
      need2(values);
      if (b === 0) throw new Error("division by zero");
      return { result: round(((b - a) / b) * 100), formula: `(${b} − ${a}) ÷ ${b} × 100` };
    default:
      throw new Error(`unsupported operation "${operation}"`);
  }
}

function need2(values: number[]) {
  if (values.length !== 2) throw new Error("operation needs exactly 2 inputs");
}

export function runCalculation(
  c: Omit<CalculationResult, "result" | "formula" | "matchesReported" | "error">,
): CalculationResult {
  try {
    const { result, formula } = compute(
      c.operation,
      c.inputs.map((i) => i.value),
    );
    const rep = c.reportedResult;
    const matches = rep ? Math.abs(rep.value - result) <= Math.max(0.05, Math.abs(result) * 0.005) : null;
    return { ...c, result, formula, matchesReported: matches };
  } catch (e) {
    return { ...c, result: null, formula: "", matchesReported: null, error: (e as Error).message };
  }
}
