/** "1 place", "3 places"; "1 child", "2 children". Pure. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
