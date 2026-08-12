"use client";

import { useCallback, useState } from "react";
import { moveSelectedRankingChoice, selectNextRankingChoice, undoLastRankingChoice } from "@/lib/classroom-mobile-ranking";

export function useProgressiveRanking() {
  const [rankingOrder, setRankingOrder] = useState<string[]>([]);
  const [rankingSelectionCount, setRankingSelectionCount] = useState(0);
  const [dragRank, setDragRank] = useState<string | null>(null);

  const initializeRanking = useCallback((order: string[], complete: boolean) => {
    setRankingOrder(order);
    setRankingSelectionCount(complete ? order.length : 0);
  }, []);
  function chooseNextRank(groupId: string) {
    const next = selectNextRankingChoice(rankingOrder, rankingSelectionCount, groupId);
    setRankingOrder(next.order);
    setRankingSelectionCount(next.selectedCount);
  }
  function undoLastRank() {
    setRankingSelectionCount(undoLastRankingChoice(rankingOrder, rankingSelectionCount).selectedCount);
  }
  function restartRanking() { setRankingSelectionCount(0); }
  function moveSelectedRank(index: number, offset: number) {
    setRankingOrder(moveSelectedRankingChoice(rankingOrder, rankingSelectionCount, index, offset).order);
  }
  function moveRank(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= rankingOrder.length) return;
    setRankingOrder((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function dropRank(targetIndex: number) {
    if (!dragRank) return;
    setRankingOrder((current) => {
      const source = current.indexOf(dragRank);
      if (source < 0 || source === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(source, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDragRank(null);
  }

  return {
    rankingOrder, rankingSelectionCount, dragRank, setDragRank, initializeRanking,
    chooseNextRank, undoLastRank, restartRanking, moveSelectedRank, moveRank, dropRank,
  };
}
