import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
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
  constructor(
    private readonly sessions: SessionStore,
    private readonly dataSource: DataSource,
  ) {}

  @Post()
  async create(@Body() dto: { user_id: number }): Promise<SessionDto> {
    const exists = await this.dataSource
      .getRepository(User)
      .existsBy({ id: String(dto.user_id) });
    if (!exists) throw new NotFoundException(`User ${dto.user_id} not found`);
    return toSessionDto(await this.sessions.create(dto.user_id));
  }

  @Get('me')
  me(@Req() request: Request & { session?: Session | null }): SessionDto {
    if (!request.session) {
      throw new UnauthorizedException('session not found or expired');
    }
    return toSessionDto(request.session);
  }
}
