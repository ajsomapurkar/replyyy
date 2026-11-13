import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@relay/contracts';
import type { Ctx } from '../../common/context.js';
import { AppError, forbidden, notFound } from '../../common/errors.js';
import type { AuthUser } from '../rides/rides.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** DEMO authentication: pick a seeded account. Not identity verification. */
export async function createDemoSession(ctx: Ctx, userId: string) {
  const { rows } = await ctx.db.query(`select id, role, display_name, is_bot from users where id=$1 and status='ACTIVE'`, [userId]);
  const u = rows[0];
  if (!u || u.is_bot) throw notFound('Demo account');
  const token = randomBytes(24).toString('base64url');
  await ctx.db.query(`insert into sessions (token, user_id, expires_at) values ($1,$2, now()+interval '12 hours')`, [token, userId]);
  return { token, user: await userFromId(ctx, userId) };
}

export async function userFromId(ctx: Ctx, id: string): Promise<AuthUser> {
  const { rows } = await ctx.db.query(`select u.id, u.role, u.display_name, u.is_bot, d.id driver_id from users u left join drivers d on d.user_id=u.id where u.id=$1`, [id]);
  const u = rows[0];
  return { id: u.id, role: u.role, displayName: u.display_name, driverId: u.driver_id, isBot: u.is_bot };
}

export async function userFromToken(ctx: Ctx, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const { rows } = await ctx.db.query(`select user_id from sessions where token=$1 and expires_at > now()`, [token]);
  return rows[0] ? userFromId(ctx, rows[0].user_id) : null;
}

export async function demoAccounts(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select u.id, u.role, u.display_name, u.email, v.make_model, d.availability_status from users u
       left join drivers d on d.user_id=u.id left join vehicles v on v.id=d.vehicle_id
      where not u.is_bot order by array_position(array['PASSENGER','DRIVER','OPERATOR','ADMIN'], u.role), u.display_name`,
  );
  return rows.map((r) => ({ id: r.id, role: r.role, name: r.display_name, email: r.email, vehicle: r.make_model, availability: r.availability_status }));
}

export function authHook(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    const user = await userFromToken(ctx, token);
    if (user) req.user = user;
  };
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (roles.length && !roles.includes(req.user.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
  };
}
