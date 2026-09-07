import type {
  ClassroomParticipationReport,
  ClassroomQuestionPhase,
  ClassroomSessionPhase,
  ClassroomStudentParticipation,
} from "@/lib/classroom-domain";
import { classroomNow, type ClassroomActor } from "./classroom";
import { ClassroomWorkflowError } from "./classroom-errors";

type ParticipationRow = {
  participant_id: string;
  group_id: string | null;
  user_id: string;
  display_name: string;
  email: string;
  attendance: "on_time" | "late";
  joined_phase: ClassroomSessionPhase;
  checked_in_at: string;
  group_label: string | null;
};

type QuestionRow = {
  id: string;
  question_text: string;
  position: number;
  phase: ClassroomQuestionPhase;
};

type QuestionStateRow = {
  user_id: string;
  question_id: string;
  eligible: number;
  ranking_completed: number;
  representative_submitted: number;
};

async function requireAdminSession(db: D1Database, actor: ClassroomActor, sessionId: string): Promise<ClassroomSessionPhase> {
  if (!actor.isAdmin) {
    throw new ClassroomWorkflowError(403, "PARTICIPATION_REPORT_REQUIRED", "只有系統管理員可查看學生參與紀錄。");
  }
  const session = await db.prepare("SELECT phase FROM classroom_sessions WHERE id = ?")
    .bind(sessionId).first<{ phase: ClassroomSessionPhase }>();
  if (!session) throw new ClassroomWorkflowError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
  return session.phase;
}

export async function classroomParticipationReport(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
): Promise<ClassroomParticipationReport> {
  const sessionPhase = await requireAdminSession(db, actor, sessionId);
  const [participantRows, questionRows, stateRows, groupRows] = await Promise.all([
    db.prepare(
      `SELECT p.id AS participant_id, p.group_id, p.user_id, u.display_name, u.email, p.attendance, p.joined_phase,
              p.checked_in_at, g.label AS group_label
       FROM classroom_session_participants p
       JOIN classroom_users u ON u.id = p.user_id
       LEFT JOIN classroom_groups g ON g.id = p.group_id
       WHERE p.session_id = ?
       ORDER BY p.checked_in_at, u.display_name`,
    ).bind(sessionId).all<ParticipationRow>(),
    db.prepare(
      `SELECT id, question_text, position, phase
       FROM classroom_questions
       WHERE session_id = ? AND phase != 'draft'
       ORDER BY position`,
    ).bind(sessionId).all<QuestionRow>(),
    db.prepare(
      `SELECT p.user_id, q.id AS question_id,
              MAX(CASE WHEN m.user_id IS NOT NULL AND m.can_rank = 1 THEN 1 ELSE 0 END) AS eligible,
              MAX(CASE WHEN m.user_id IS NOT NULL AND s.id IS NOT NULL THEN 1 ELSE 0 END) AS ranking_completed,
              MAX(CASE WHEN r.updated_by_user_id = p.user_id AND r.status IN ('submitted','locked') THEN 1 ELSE 0 END) AS representative_submitted
       FROM classroom_session_participants p
       JOIN classroom_questions q ON q.session_id = p.session_id AND q.phase != 'draft'
       LEFT JOIN classroom_question_memberships m ON m.question_id = q.id AND m.user_id = p.user_id
       LEFT JOIN classroom_question_ranking_submissions s
         ON s.question_id = q.id AND s.user_id = p.user_id AND s.is_current = 1 AND s.status = 'valid'
       LEFT JOIN classroom_question_responses r ON r.question_id = q.id AND r.updated_by_user_id = p.user_id
       WHERE p.session_id = ?
       GROUP BY p.user_id, q.id`,
    ).bind(sessionId).all<QuestionStateRow>(),
    db.prepare("SELECT id, label, representative_user_id FROM classroom_groups WHERE session_id = ? ORDER BY position")
      .bind(sessionId).all<{ id: string; label: string; representative_user_id: string | null }>(),
  ]);

  const stateByStudentQuestion = new Map(
    stateRows.results.map((row) => [`${row.user_id}:${row.question_id}`, row]),
  );
  const rankingOpportunityIds = new Set(questionRows.results
    .filter((question) => ["ranking", "locked", "published", "archived"].includes(question.phase))
    .map((question) => question.id));
  const students: ClassroomStudentParticipation[] = participantRows.results.map((participant) => {
    const questions = questionRows.results.map((question) => {
      const state = stateByStudentQuestion.get(`${participant.user_id}:${question.id}`);
      return {
        questionId: question.id,
        eligible: state?.eligible === 1,
        rankingCompleted: state?.ranking_completed === 1,
        representativeSubmitted: state?.representative_submitted === 1,
      };
    });
    const eligibleQuestionCount = questions.filter((question) => question.eligible).length;
    const rankingOpportunityCount = questions.filter((question) => question.eligible && rankingOpportunityIds.has(question.questionId)).length;
    const completedRankingCount = questions.filter((question) => question.rankingCompleted).length;
    return {
      participantId: participant.participant_id,
      groupId: participant.group_id,
      userId: participant.user_id,
      displayName: participant.display_name,
      email: participant.email,
      attendance: participant.attendance,
      joinedPhase: participant.joined_phase,
      checkedInAt: participant.checked_in_at,
      groupLabel: participant.group_label,
      eligibleQuestionCount,
      rankingOpportunityCount,
      completedRankingCount,
      representativeSubmissionCount: questions.filter((question) => question.representativeSubmitted).length,
      completionRate: rankingOpportunityCount ? completedRankingCount / rankingOpportunityCount : null,
      questions,
    };
  });

  return {
    generatedAt: classroomNow(),
    sessionId,
    sessionPhase,
    groups: groupRows.results.map((group) => ({ id: group.id, label: group.label, representativeUserId: group.representative_user_id })),
    questions: questionRows.results.map((question) => ({
      id: question.id,
      text: question.question_text,
      position: question.position,
      phase: question.phase,
    })),
    students,
  };
}
