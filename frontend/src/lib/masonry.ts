/** Deal items left to right into `count` column stacks (row-major reading order, masonry heights). */
export function dealColumns<T>(items: T[], count: number): T[][] {
  const columns: T[][] = Array.from({ length: count }, () => []);
  items.filter(Boolean).forEach((item, index) => columns[index % count].push(item));
  return columns;
}
