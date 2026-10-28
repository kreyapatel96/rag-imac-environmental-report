import { describe, expect, it } from "vitest";
import { compute, runCalculation } from "../src/lib/calc";

describe("compute", () => {
  it("percent_less = how much lower actual is than the reference", () => {
    expect(compute("percent_less", [150, 200]).result).toBe(25);
    expect(compute("percent_less", [30, 100]).result).toBe(70);
  });
  it("difference, sum, ratio, percent_of", () => {
    expect(compute("difference", [10.5, 4.2]).result).toBe(6.3);
    expect(compute("sum", [0.1, 0.2, 0.3]).result).toBe(0.6);
    expect(compute("ratio", [9, 3]).result).toBe(3);
    expect(compute("percent_of", [55, 100]).result).toBe(55);
  });
  it("rejects division by zero, wrong arity and unknown operations", () => {
    expect(() => compute("percent_less", [1, 0])).toThrow(/zero/);
    expect(() => compute("difference", [1])).toThrow();
    expect(() => compute("sqrt", [4])).toThrow(/unsupported/);
  });
  it("runCalculation compares with the reported result", () => {
    const base = { label: "x", operation: "percent_less", unit: "%", inputs: [] as never[] };
    const ok = runCalculation({ ...base, inputs: [{ label: "a", value: 150, unit: "kWh", chunkId: "c", verified: true }, { label: "b", value: 200, unit: "kWh", chunkId: "c", verified: true }], reportedResult: { value: 25, unit: "%" } });
    expect(ok.result).toBe(25);
    expect(ok.matchesReported).toBe(true);
    const bad = runCalculation({ ...base, inputs: ok.inputs, reportedResult: { value: 40, unit: "%" } });
    expect(bad.matchesReported).toBe(false);
  });
});
