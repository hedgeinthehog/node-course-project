import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../entities/user.entity';
import { AuthService } from './auth.service';
import {
  AuthenticatedRequest,
  bearerToken,
  PUBLIC_KEY,
  ROLES_KEY,
} from './decorators';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.header('authorization'));
    if (!token) throw new UnauthorizedException('missing bearer token');
    request.user = await this.auth.authenticate(token);

    const roles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      targets,
    );
    if (roles && !roles.includes(request.user.role)) {
      throw new ForbiddenException(
        `requires role ${roles.join(' or ')}, you are ${request.user.role}`,
      );
    }
    return true;
  }
}
