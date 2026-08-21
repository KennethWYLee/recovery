import type { ClassroomCourse, ClassroomSessionSnapshot } from "@/lib/classroom-domain";

export type WorkspaceActor = {
  id: string;
  email: string;
  displayName: string;
  role: "teacher" | "student";
  isAdmin: boolean;
};

export type WorkspacePayload = {
  actor: WorkspaceActor;
  viewer: WorkspaceActor;
  testMode: boolean;
  course: ClassroomCourse;
  snapshot: ClassroomSessionSnapshot | null;
};
