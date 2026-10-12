export function add(a: number, b: number): number {
  return a + b;
}

export function sum(values: number[]): number {
  return values.reduce(add, 0);
}
