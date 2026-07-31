import { env } from "cloudflare:workers";
import { canonicalJson, cleanOperationsText, isOrganizationRole, normalizeEmail, type OrganizationRole } from "@/lib/operations-domain";
import {
  isNtubEmail,
  isReadOnlyOrganizationRole,
  provisioningRoleForIdentity,
  randomSchoolViewerDisplayName,
  type ExternalOperationsIdentity,
  type OperationsActor,
  type OperationsEnvironment,
} from "@/lib/operations-auth";

export const OPERATIONS_ORGANIZATION_ID = "ops-singleton";

export class IdempotencyKeyMismatchError extends Error {
  constructor() {
    super("The idempotency key was already used with a different request.");
    this.name = "IdempotencyKeyMismatchError";
  }
}

export function operationsEnvironment(): CloudflareEnv & OperationsEnvironment {
  return env as unknown as CloudflareEnv & OperationsEnvironment;
}

export function operationsDb(): D1Database {
  const bindings = operationsEnvironment();
  if (!bindings.DB) throw new Error("Cloudflare D1 binding DB is unavailable.");
  return bindings.DB;
}

export function operationsId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function operationsNow(): string {
  return new Date().toISOString();
}

export async function operationsSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadOrProvisionOperationsActor(
  identity: ExternalOperationsIdentity,
  requestId: string,
): Promise<OperationsActor | null> {
  const db = operationsDb();
  const bindings = operationsEnvironment();
  const email = normalizeEmail(identity.email);
  if (!email) return null;
  const userId = `usr-${(await operationsSha256(email)).slice(0, 24)}`;
  const membershipId = `mem-${(await operationsSha256(`${OPERATIONS_ORGANIZATION_ID}|${userId}`)).slice(0, 24)}`;
  const now = operationsNow();
  const provisioningRole: OrganizationRole | null = provisioningRoleForIdentity(
    identity,
    bindings.CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL,
  );
  const configuredOrganizationName = cleanOperationsText(bindings.CONTINUITY_OPS_ORGANIZATION_NAME, 120);
  const configuredOrganizationTimeZone = (() => {
    if (typeof bindings.CONTINUITY_OPS_ORGANIZATION_TIMEZONE !== "string") return "";
    const candidate = bindings.CONTINUITY_OPS_ORGANIZATION_TIMEZONE.trim();
    if (!candidate || candidate.length > 64) return "";
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
    } catch {
      return "";
    }
  })();

  const existingMembership = await db.prepare(
    `SELECT m.id, m.role, m.status AS membership_status, u.status AS user_status,
            u.display_name
     FROM ops_users u
     JOIN ops_memberships m ON m.user_id = u.id
     WHERE u.id = ? AND u.email = ? AND m.organization_id = ?`,
  ).bind(userId, email, OPERATIONS_ORGANIZATION_ID).first<{
    id: string;
    role: string;
    membership_status: string;
    user_status: string;
    display_name: string;
  }>();

  // Suspension is an explicit administrative decision. Domain-based
  // provisioning must never reactivate either the user or the membership.
  if (existingMembership && (
    existingMembership.user_status !== "active" ||
    existingMembership.membership_status !== "active" ||
    !isOrganizationRole(existingMembership.role)
  )) return null;

  // A verified external identity is not generally an invitation. The only
  // automatic exceptions are the configured bootstrap/local operator and an
  // exact @ntub.edu.tw identity, which receives a read-only role.
  if (!existingMembership && !provisioningRole) return null;

  const existingRole = existingMembership && isOrganizationRole(existingMembership.role)
    ? existingMembership.role
    : null;
  const newNtubReadOnlyMember = !existingMembership && isNtubEmail(email) &&
    isReadOnlyOrganizationRole(provisioningRole) && identity.source === "forwarded_identity";
  const preserveSchoolViewerName = Boolean(
    existingMembership && isNtubEmail(email) && isReadOnlyOrganizationRole(existingRole),
  );
  const displayName = newNtubReadOnlyMember
    ? randomSchoolViewerDisplayName()
    : preserveSchoolViewerName
      ? existingMembership?.display_name ?? identity.displayName
      : identity.displayName;

  const statements: D1PreparedStatement[] = [];
  if (!existingMembership && provisioningRole) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO ops_users
          (id, email, display_name, identity_source, status, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(userId, email, displayName, identity.source, now, now),
    );
  }
  statements.push(preserveSchoolViewerName || newNtubReadOnlyMember
    ? db.prepare(
      `UPDATE ops_users SET last_seen_at = ?
       WHERE id = ? AND email = ? AND status = 'active'`,
    ).bind(now, userId, email)
    : db.prepare(
      `UPDATE ops_users SET display_name = ?, last_seen_at = ?
       WHERE id = ? AND email = ? AND status = 'active'`,
    ).bind(displayName, now, userId, email));
  if (configuredOrganizationName.length >= 2) {
    statements.push(
      db.prepare("UPDATE ops_organizations SET name = ? WHERE id = ? AND name <> ?")
        .bind(configuredOrganizationName, OPERATIONS_ORGANIZATION_ID, configuredOrganizationName),
    );
  }
  if (configuredOrganizationTimeZone) {
    statements.push(
      db.prepare("UPDATE ops_organizations SET timezone = ? WHERE id = ? AND timezone <> ?")
        .bind(configuredOrganizationTimeZone, OPERATIONS_ORGANIZATION_ID, configuredOrganizationTimeZone),
    );
  }
  if (!existingMembership && provisioningRole) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO ops_memberships
          (id, organization_id, user_id, role, status, created_at, updated_at)
         SELECT ?, ?, u.id, ?, 'active', ?, ?
         FROM ops_users u WHERE u.id = ? AND u.email = ? AND u.status = 'active'`,
      ).bind(
        membershipId,
        OPERATIONS_ORGANIZATION_ID,
        provisioningRole,
        now,
        now,
        userId,
        email,
      ),
    );
  }
  if (newNtubReadOnlyMember) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO ops_audit_events
          (id, organization_id, actor_user_id, actor_role, action, resource_type,
           resource_id, outcome, reason_code, request_id, details_json, occurred_at)
         SELECT ?, m.organization_id, m.user_id, m.role, 'access.member.auto_provision',
                'membership', m.id, 'success', NULL, ?, ?, ?
         FROM ops_memberships m JOIN ops_users u ON u.id = m.user_id
         WHERE m.id = ? AND m.organization_id = ? AND m.status = 'active'
           AND m.role IN ('observer', 'auditor') AND u.status = 'active'`,
      ).bind(
        `audit-auto-${membershipId.slice(4)}`,
        requestId,
        canonicalJson({ accessMode: "read_only", emailDomain: "ntub.edu.tw" }),
        now,
        membershipId,
        OPERATIONS_ORGANIZATION_ID,
      ),
    );
  }
  await db.batch(statements);

  const row = await db.prepare(
    `SELECT u.id, u.email, u.display_name, m.id AS membership_id, m.role,
            o.id AS organization_id, o.name AS organization_name, o.timezone AS organization_timezone
     FROM ops_users u
     JOIN ops_memberships m ON m.user_id = u.id
     JOIN ops_organizations o ON o.id = m.organization_id
     WHERE u.id = ? AND u.status = 'active' AND m.status = 'active'
       AND o.status = 'active' AND m.organization_id = ?`,
  ).bind(userId, OPERATIONS_ORGANIZATION_ID).first<{
    id: string;
    email: string;
    display_name: string;
    membership_id: string;
    role: string;
    organization_id: string;
    organization_name: string;
    organization_timezone: string;
  }>();
  if (!row || !isOrganizationRole(row.role)) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    membershipId: row.membership_id,
    role: row.role,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationTimeZone: row.organization_timezone,
  };
}

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[\x21-\x7E]{8,128}$/.test(normalized) ? normalized : "";
}

export async function executeIdempotentBatch<T>(options: {
  db: D1Database;
  actor: OperationsActor;
  actionScope: string;
  idempotencyKey: string;
  requestPayload: unknown;
  responseData: T;
  statements: D1PreparedStatement[];
  now?: string;
}): Promise<{ data: T; replayed: boolean }> {
  const now = options.now ?? operationsNow();
  const keyHash = await operationsSha256(options.idempotencyKey);
  const requestHash = await operationsSha256(canonicalJson(options.requestPayload));
  const receiptId = `receipt-${(await operationsSha256(
    `${options.actor.organizationId}|${options.actor.id}|${options.actionScope}|${keyHash}`,
  )).slice(0, 40)}`;
  const existing = await readReceipt<T>(options.db, options.actor, options.actionScope, keyHash, now);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new IdempotencyKeyMismatchError();
    return { data: existing.data, replayed: true };
  }

  const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  const boundedExpiredReceiptCleanup = options.db.prepare(
    `DELETE FROM ops_idempotency_receipts
     WHERE id IN (
       SELECT id FROM ops_idempotency_receipts
       WHERE organization_id = ? AND expires_at <= ?
       ORDER BY expires_at, id
       LIMIT 100
     )`,
  ).bind(options.actor.organizationId, now);
  const expiredReceiptDelete = options.db.prepare(
    `DELETE FROM ops_idempotency_receipts
     WHERE organization_id = ? AND actor_user_id = ? AND action_scope = ?
       AND idempotency_key_hash = ? AND expires_at <= ?`,
  ).bind(
    options.actor.organizationId,
    options.actor.id,
    options.actionScope,
    keyHash,
    now,
  );
  const receiptStatement = options.db.prepare(
    `INSERT INTO ops_idempotency_receipts
      (id, organization_id, actor_user_id, action_scope, idempotency_key_hash,
       request_hash, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    receiptId,
    options.actor.organizationId,
    options.actor.id,
    options.actionScope,
    keyHash,
    requestHash,
    JSON.stringify(options.responseData),
    now,
    expiresAt,
  );

  try {
    await options.db.batch([boundedExpiredReceiptCleanup, expiredReceiptDelete, receiptStatement, ...options.statements]);
    return { data: options.responseData, replayed: false };
  } catch (error) {
    const raced = await readReceipt<T>(options.db, options.actor, options.actionScope, keyHash, now);
    if (raced) {
      if (raced.requestHash !== requestHash) throw new IdempotencyKeyMismatchError();
      return { data: raced.data, replayed: true };
    }
    throw error;
  }
}

/**
 * Reads a matching, unexpired receipt before state-dependent validation. This
 * keeps a legitimate retry deterministic even when the first request changed
 * the resource state that later validation would inspect.
 */
export async function readIdempotentReplay<T>(options: {
  db: D1Database;
  actor: OperationsActor;
  actionScope: string;
  idempotencyKey: string;
  requestPayload: unknown;
  now?: string;
}): Promise<T | null> {
  const now = options.now ?? operationsNow();
  const keyHash = await operationsSha256(options.idempotencyKey);
  const requestHash = await operationsSha256(canonicalJson(options.requestPayload));
  const existing = await readReceipt<T>(options.db, options.actor, options.actionScope, keyHash, now);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw new IdempotencyKeyMismatchError();
  return existing.data;
}

export function auditInsert(
  db: D1Database,
  actor: OperationsActor,
  values: {
    requestId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    occurredAt: string;
    details?: Record<string, unknown>;
    outcome?: "success" | "denied" | "failure";
    reasonCode?: string | null;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO ops_audit_events
      (id, organization_id, actor_user_id, actor_role, action, resource_type,
       resource_id, outcome, reason_code, request_id, details_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    operationsId("audit"),
    actor.organizationId,
    actor.id,
    actor.role,
    values.action,
    values.resourceType,
    values.resourceId,
    values.outcome ?? "success",
    values.reasonCode ?? null,
    values.requestId,
    values.details ? canonicalJson(values.details) : null,
    values.occurredAt,
  );
}

async function readReceipt<T>(
  db: D1Database,
  actor: OperationsActor,
  actionScope: string,
  keyHash: string,
  activeAt: string,
): Promise<{ requestHash: string; data: T } | null> {
  const row = await db.prepare(
    `SELECT request_hash, response_json FROM ops_idempotency_receipts
     WHERE organization_id = ? AND actor_user_id = ? AND action_scope = ?
       AND idempotency_key_hash = ? AND expires_at > ?`,
  ).bind(actor.organizationId, actor.id, actionScope, keyHash, activeAt).first<{
    request_hash: string;
    response_json: string;
  }>();
  if (!row) return null;
  return { requestHash: row.request_hash, data: JSON.parse(row.response_json) as T };
}
