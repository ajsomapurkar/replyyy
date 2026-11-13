import type { RideStatus } from '@relay/contracts';
import { AppError } from '../../common/errors.js';

export type Actor = 'PASSENGER' | 'DRIVER' | 'OPERATOR' | 'SYSTEM';

/** Single source of truth for allowed transitions and who may request them. */
const TRANSITIONS: Record<RideStatus, Partial<Record<RideStatus, Actor[]>>> = {
  REQUESTED: { DISPATCHING: ['SYSTEM'], CANCELLED: ['PASSENGER', 'OPERATOR', 'SYSTEM'], EXCEPTION: ['SYSTEM', 'OPERATOR'] },
  DISPATCHING: {
    ACCEPTED: ['DRIVER', 'SYSTEM'],
    REASSIGNING: ['SYSTEM', 'OPERATOR', 'DRIVER'],
    NO_DRIVER: ['SYSTEM'],
    CANCELLED: ['PASSENGER', 'OPERATOR', 'SYSTEM'],
    EXCEPTION: ['SYSTEM', 'OPERATOR'],
  },
  REASSIGNING: { DISPATCHING: ['SYSTEM'], NO_DRIVER: ['SYSTEM'], CANCELLED: ['PASSENGER', 'OPERATOR', 'SYSTEM'], EXCEPTION: ['SYSTEM', 'OPERATOR'] },
  ACCEPTED: {
    ARRIVING: ['DRIVER'],
    REASSIGNING: ['DRIVER', 'OPERATOR', 'SYSTEM'],
    CANCELLED: ['PASSENGER', 'OPERATOR'],
    EXCEPTION: ['SYSTEM', 'OPERATOR'],
  },
  ARRIVING: {
    ONGOING: ['DRIVER'],
    REASSIGNING: ['DRIVER', 'OPERATOR', 'SYSTEM'],
    CANCELLED: ['PASSENGER', 'OPERATOR'],
    EXCEPTION: ['SYSTEM', 'OPERATOR'],
  },
  ONGOING: { COMPLETED: ['DRIVER', 'OPERATOR'], CANCELLED: ['OPERATOR'], EXCEPTION: ['SYSTEM', 'OPERATOR'] },
  EXCEPTION: {
    REASSIGNING: ['OPERATOR', 'SYSTEM'],
    ACCEPTED: ['OPERATOR', 'SYSTEM'],
    ARRIVING: ['OPERATOR', 'SYSTEM'],
    ONGOING: ['OPERATOR', 'SYSTEM'],
    COMPLETED: ['OPERATOR'],
    CANCELLED: ['OPERATOR', 'PASSENGER'],
  },
  NO_DRIVER: { REASSIGNING: ['PASSENGER', 'OPERATOR', 'SYSTEM'], CANCELLED: ['PASSENGER', 'OPERATOR', 'SYSTEM'] },
  COMPLETED: {},
  CANCELLED: {},
};

export function canTransition(from: RideStatus, to: RideStatus, actor: Actor): boolean {
  return TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
}

export function assertTransition(from: RideStatus, to: RideStatus, actor: Actor) {
  if (!canTransition(from, to, actor)) {
    throw new AppError(409, 'INVALID_TRANSITION', `Ride cannot move from ${from} to ${to} (${actor.toLowerCase()})`, { from, to, actor });
  }
}

export function allowedNext(from: RideStatus, actor: Actor): RideStatus[] {
  return (Object.entries(TRANSITIONS[from] ?? {}) as [RideStatus, Actor[]][]).filter(([, a]) => a.includes(actor)).map(([s]) => s);
}
