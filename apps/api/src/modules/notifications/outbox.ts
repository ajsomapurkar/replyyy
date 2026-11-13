import type { EventType, Role } from '@relay/contracts';
import type { Queryable } from '../../database/db.js';

export interface Audience {
  roles?: Role[];
  userIds?: (string | null | undefined)[];
}
export const OPS: Role[] = ['OPERATOR', 'ADMIN'];

/** Write an event to the outbox inside the caller's transaction (published by the outbox worker). */
export async function emit(c: Queryable, type: EventType, entityId: string, version: number, payload: unknown, audience: Audience) {
  const aud = { roles: audience.roles ?? OPS, userIds: (audience.userIds ?? []).filter(Boolean) };
  await c.query(`insert into outbox_events (type, entity_id, version, payload, audience) values ($1,$2,$3,$4,$5)`, [
    type,
    entityId,
    version,
    JSON.stringify(payload),
    JSON.stringify(aud),
  ]);
}
