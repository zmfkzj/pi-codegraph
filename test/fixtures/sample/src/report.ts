import { sum } from "./math";

export function totalReport(values: number[]): string {
  return `total=${sum(values)}`;
}
