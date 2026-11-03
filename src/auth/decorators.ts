import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../entities/user.entity';
import type { Principal } from './auth.service';

export const PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';

export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export type AuthenticatedRequest = Request & { user?: Principal };

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) throw new Error('route is not authenticated');
    return request.user;
  },
);

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
}
