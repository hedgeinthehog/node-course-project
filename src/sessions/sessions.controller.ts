import {
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '../auth/auth.service';
import { CurrentUser, Public } from '../auth/decorators';
import { Session, SessionStore } from '../redis/session.store';

export interface SessionDto {
  session_id: string;
  user_id: number;
  expires_in: number;
}

const toSessionDto = (session: Session): SessionDto => ({
  session_id: session.id,
  user_id: session.userId,
  expires_in: session.expiresIn,
});

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionStore) {}

  @Post()
  async create(@CurrentUser() user: Principal): Promise<SessionDto> {
    return toSessionDto(await this.sessions.create(Number(user.id)));
  }

  @Public()
  @Get('me')
  me(@Req() request: Request & { session?: Session | null }): SessionDto {
    if (!request.session) {
      throw new UnauthorizedException('session not found or expired');
    }
    return toSessionDto(request.session);
  }
}
