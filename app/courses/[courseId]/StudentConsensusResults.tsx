import { rankingOrderExcludingGroup, rankingPosition, type ClassroomSessionSnapshot } from "@/lib/classroom-domain";

export function RankingResultLists({ snapshot, showPersonalRanking = false }: { snapshot: ClassroomSessionSnapshot; showPersonalRanking?: boolean }) {
  const consensus = [...snapshot.results].sort((left, right) => right.averageScore - left.averageScore || left.finalRank - right.finalRank);
  const teacherOrder = snapshot.teacherRanking?.orderedGroupIds ?? [];
  const personalOrder = rankingOrderExcludingGroup(snapshot.currentUser.orderedGroupIds, snapshot.currentUser.groupId);
  return <div className="published-ranking-lists">
    <section className="published-ranking-list" aria-label="全班共識排名">
      <header><h2>全班共識</h2><p>依平均得分由高到低 · {snapshot.completion.rankedStudents} 人完成排序</p></header>
      <ol>{consensus.map((result) => {
        const group = snapshot.groups.find((item) => item.id === result.groupId);
        const ownRank = rankingPosition(personalOrder, result.groupId);
        return <li key={result.groupId}>
          <header><strong>{result.tied ? "並列" : ""}第 {result.finalRank} 名</strong><b>{result.averageScore.toFixed(2)} 分</b></header>
          <span>{result.label}</span><p>{group?.response.content || "未提供回答內容"}</p>
          <small>{result.ratingCount} 份有效排序 · 最高 {result.maximumScore} 分</small>
          {showPersonalRanking && <details className="result-distribution"><summary>查看你的排序與名次分布</summary>
            <p>你的排序：{result.groupId === snapshot.currentUser.groupId ? "本組，不列入" : ownRank === null ? "未參與" : `第 ${ownRank} 名`}</p>
            <div>{result.rankCounts.map((count, index) => <span key={index}><small>第 {index + 1} 順位</small><i><b style={{ width: `${result.ratingCount ? count / result.ratingCount * 100 : 0}%` }} /></i><strong>{count}</strong></span>)}</div>
          </details>}
        </li>;
      })}</ol>
    </section>
    <section className="published-ranking-list teacher-published-ranking" aria-label="教師排序排名">
      <header><h2>教師排序</h2><p>依教師排定的名次，由第 1 名往下排列</p></header>
      {teacherOrder.length ? <ol>{teacherOrder.map((groupId, index) => {
        const group = snapshot.groups.find((item) => item.id === groupId);
        return <li key={groupId}><header><strong>第 {index + 1} 名</strong></header><span>{group?.label}</span><p>{group?.response.content || "未提供回答內容"}</p></li>;
      })}</ol> : <p className="published-ranking-empty">教師尚未提供排序。</p>}
    </section>
  </div>;
}

export function StudentConsensusResults({ snapshot }: { snapshot: ClassroomSessionSnapshot }) {
  return <RankingResultLists snapshot={snapshot} showPersonalRanking />;
}
