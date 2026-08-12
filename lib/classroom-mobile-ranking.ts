export type ProgressiveRanking = {
  order: string[];
  selectedCount: number;
};

function normalizedSelectedCount(order: string[], selectedCount: number): number {
  if (!Number.isInteger(selectedCount)) return 0;
  return Math.min(Math.max(selectedCount, 0), order.length);
}

export function selectNextRankingChoice(
  order: string[],
  selectedCount: number,
  groupId: string,
): ProgressiveRanking {
  const count = normalizedSelectedCount(order, selectedCount);
  const source = order.indexOf(groupId);
  if (source < count || source < 0) return { order, selectedCount: count };

  const next = [...order];
  const [selected] = next.splice(source, 1);
  next.splice(count, 0, selected);
  return { order: next, selectedCount: count + 1 };
}

export function undoLastRankingChoice(order: string[], selectedCount: number): ProgressiveRanking {
  const count = normalizedSelectedCount(order, selectedCount);
  return { order, selectedCount: Math.max(0, count - 1) };
}

export function moveSelectedRankingChoice(
  order: string[],
  selectedCount: number,
  index: number,
  offset: number,
): ProgressiveRanking {
  const count = normalizedSelectedCount(order, selectedCount);
  const target = index + offset;
  if (index < 0 || index >= count || target < 0 || target >= count) {
    return { order, selectedCount: count };
  }

  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return { order: next, selectedCount: count };
}
