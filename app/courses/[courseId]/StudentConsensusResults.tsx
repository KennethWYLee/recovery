import type { ClassroomRankingResult, ClassroomSessionSnapshot } from "@/lib/classroom-domain";

function RankDistribution({ result }: { result: ClassroomRankingResult }) {
  return (
    <details className="result-distribution">
      <summary>查看名次分布</summary>
      <div>
        {result.rankCounts.map((count, rankIndex) => (
          <span key={rankIndex}>
            <small>第 {rankIndex + 1} 順位</small>
            <i><b style={{ width: `${result.ratingCount ? (count / result.ratingCount) * 100 : 0}%` }} /></i>
            <strong>{count}</strong>
          </span>
        ))}
      </div>
    </details>
  );
}

export function StudentConsensusResults({ snapshot }: { snapshot: ClassroomSessionSnapshot }) {
  return (
    <section className="student-focus-card student-consensus">
      <header>
        <div>
          <p>全班排序共識</p>
          <h2>回答越上方，代表全班共識越高</h2>
        </div>
        <span>{snapshot.completion.rankedStudents} 人完成排序</span>
      </header>
      <ol>
        {snapshot.results.map((result) => {
          const group = snapshot.groups.find((item) => item.id === result.groupId);
          return (
            <li key={result.groupId}>
              <span className="consensus-answer-label">{result.label}</span>
              <p>{group?.response.content}</p>
              <footer>
                <b>共識分數 {result.averageScore.toFixed(2)}／{result.maximumScore}</b>
                <span>{result.ratingCount} 份有效排序</span>
                <span>{result.tied ? `並列第 ${result.finalRank} 位` : `第 ${result.finalRank} 位`}</span>
              </footer>
              <RankDistribution result={result} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
