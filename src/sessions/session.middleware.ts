import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Session, SessionStore } from '../redis/session.store';

export const SESSION_HEADER = 'x-session-id';

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly sessions: SessionStore) {}

  async use(
    request: Request & { session?: Session | null },
    _response: Response,
    next: NextFunction,
  ) {
    const id = request.header(SESSION_HEADER);
    request.session = id ? await this.sessions.touch(id) : null;
    next();
  }
}
