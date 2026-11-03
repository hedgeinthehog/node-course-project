import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User, UserRole } from '../entities/user.entity';
import { AccessClaims, AccessTokens, ACCESS_TTL_S, TokenError } from './jwt';
import { verifyPassword } from './password';

export const REFRESH_TTL_S = 30 * 24 * 3600;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface Principal {
  id: string;
  role: UserRole;
  jti: string;
  familyId: string;
  exp: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tokens: AccessTokens,
    private readonly pepper: string,
  ) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const [user]: Pick<User, 'id' | 'role' | 'passwordHash'>[] =
      await this.dataSource.query(
        `SELECT id, role, password_hash AS "passwordHash" FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('invalid email or password');
    }
    return this.dataSource.transaction((manager) =>
      this.issuePair(manager, user, randomUUID()),
    );
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<TokenPair | { reuseOf: string }> => {
        const [row]: (Pick<
          RefreshToken,
          'id' | 'userId' | 'familyId' | 'usedAt' | 'revokedAt' | 'expiresAt'
        > & { role: UserRole })[] = await manager.query(
          `SELECT t.id, t.user_id AS "userId", t.family_id AS "familyId", t.used_at AS "usedAt",
                  t.revoked_at AS "revokedAt", t.expires_at AS "expiresAt", u.role
           FROM refresh_tokens t JOIN users u ON u.id = t.user_id
           WHERE t.token_hash = $1
           FOR UPDATE OF t`,
          [this.hash(refreshToken)],
        );
        if (!row) throw new UnauthorizedException('unknown refresh token');
        if (row.revokedAt) {
          throw new UnauthorizedException('refresh token revoked');
        }
        if (row.usedAt) {
          await this.revokeFamily(manager, row.familyId);
          this.logger.warn(
            `refresh token reuse detected: family=${row.familyId} user=${row.userId}, family revoked`,
          );
          return { reuseOf: row.familyId };
        }
        if (row.expiresAt.getTime() <= Date.now()) {
          throw new UnauthorizedException('refresh token expired');
        }
        await manager.query(
          `UPDATE refresh_tokens SET used_at = now() WHERE id = $1`,
          [row.id],
        );
        return this.issuePair(
          manager,
          { id: row.userId, role: row.role },
          row.familyId,
        );
      },
    );
    if ('reuseOf' in outcome) {
      throw new UnauthorizedException('refresh token reuse detected');
    }
    return outcome;
  }

  logout(principal: Principal): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      await this.revokeFamily(manager, principal.familyId);
      await manager.query(
        `INSERT INTO access_denylist (jti, expires_at) VALUES ($1, to_timestamp($2))
         ON CONFLICT (jti) DO NOTHING`,
        [principal.jti, principal.exp],
      );
    });
  }

  async authenticate(token: string): Promise<Principal> {
    let claims: AccessClaims;
    try {
      claims = await this.tokens.verify(token);
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof TokenError ? err.message : 'invalid token',
      );
    }
    const revoked: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM access_denylist WHERE jti = $1
       UNION ALL
       SELECT 1 FROM refresh_tokens WHERE family_id = $2 AND revoked_at IS NOT NULL
       LIMIT 1`,
      [claims.jti, claims.fid],
    );
    if (revoked.length > 0) {
      throw new UnauthorizedException('token revoked');
    }
    return {
      id: claims.sub,
      role: claims.role,
      jti: claims.jti,
      familyId: claims.fid,
      exp: claims.exp,
    };
  }

  private async issuePair(
    manager: EntityManager,
    user: { id: string; role: UserRole },
    familyId: string,
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    await manager.save(
      manager.create(RefreshToken, {
        id: randomUUID(),
        userId: user.id,
        familyId,
        tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
      }),
    );
    const { token } = await this.tokens.sign(user, familyId);
    return {
      access_token: token,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
    };
  }

  private revokeFamily(manager: EntityManager, familyId: string) {
    return manager.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
  }

  private hash(refreshToken: string): string {
    return createHmac('sha256', this.pepper).update(refreshToken).digest('hex');
  }
}
