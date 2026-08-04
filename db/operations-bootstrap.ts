import migration0001 from "./migrations/0001_continuity_ops_v2.sql?raw";
import migration0003 from "./migrations/0003_assignment_role_integrity.sql?raw";
import migration0004 from "./migrations/0004_service_lifecycle_accountability.sql?raw";
import migration0005 from "./migrations/0005_request_observability.sql?raw";
import {
  createFreshOperationsSchemaPlan,
  createCachedOperationsSchemaEnsurer,
  operationsSchemaPlanDigest,
  type OperationsSchemaBootstrapCaller,
  type OperationsSchemaBootstrapResult,
} from "./operations-bootstrap-core";

export const OPERATIONS_SCHEMA_BOOTSTRAP_PLAN = createFreshOperationsSchemaPlan(
  migration0001,
  migration0003,
  migration0004,
  migration0005,
);

const planDigest = operationsSchemaPlanDigest(OPERATIONS_SCHEMA_BOOTSTRAP_PLAN);
const ensureCachedOperationsSchema = createCachedOperationsSchemaEnsurer(
  OPERATIONS_SCHEMA_BOOTSTRAP_PLAN,
  planDigest,
);

/**
 * Ensures only a brand-new D1 database, or an exact database already prepared
 * by migrations 0001-0005, can become ready. The caller is responsible for
 * deriving `verified` from the trusted platform identity boundary.
 */
export async function ensureOperationsSchema(options: {
  db: D1Database;
  caller: OperationsSchemaBootstrapCaller | null | undefined;
  configuredBootstrapEmail: unknown;
  now?: string;
}): Promise<OperationsSchemaBootstrapResult> {
  return ensureCachedOperationsSchema(options);
}

export type {
  OperationsSchemaBootstrapCaller,
  OperationsSchemaBootstrapResult,
} from "./operations-bootstrap-core";
