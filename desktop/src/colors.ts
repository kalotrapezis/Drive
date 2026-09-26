/**
 * A colour for any number of places. 1 and 2 are the risk: red and yellow. From 3 on, the hue is found by halving:
 * the k-th count takes the next point of 0, 1/2, 1/4, 3/4, 1/8, 3/8… (each new one halfway between two already
 * used) along green → magenta, so however many devices there are, every count stays as far from the others as it can.
 */
export function copiesColor(n: number): string {
  if (n <= 1) return 'hsl(358 75% 59%)'
  if (n === 2) return 'hsl(47 92% 53%)'
  let k = n - 3, f = 0, half = 0.5
  for (; k > 0; k >>= 1, half /= 2) if (k & 1) f += half // k's bits read backwards: the halving sequence
  return `hsl(${Math.round(125 + f * 190)} 75% 52%)`
}
