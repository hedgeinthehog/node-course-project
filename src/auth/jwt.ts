import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
} from 'node:crypto';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import type { UserRole } from '../entities/user.entity';

export const JWT_ALGORITHM = 'ES256';
export const JWT_ISSUER = 'marketplace-api';
export const JWT_AUDIENCE = 'marketplace';
export const ACCESS_TTL_S = 600;

export interface AccessClaims {
  sub: string;
  role: UserRole;
  fid: string;
  jti: string;
  exp: number;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export class AccessTokens {
  private readonly keyring: Map<string, KeyObject>;

  constructor(
    private readonly privateKey: KeyObject,
    publicKey: KeyObject,
    readonly kid: string,
  ) {
    this.keyring = new Map([[kid, publicKey]]);
  }

  static fromBase64(privateB64: string, publicB64: string, kid: string) {
    const pem = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
    return new AccessTokens(
      createPrivateKey(pem(privateB64)),
      createPublicKey(pem(publicB64)),
      kid,
    );
  }

  static fingerprint(key: KeyObject): string {
    const publicKey = key.type === 'private' ? createPublicKey(key) : key;
    return createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
      .replace(/(.{4})/g, '$1:')
      .slice(0, 39);
  }

  fingerprint(): string {
    return AccessTokens.fingerprint(this.privateKey);
  }

  async sign(user: { id: string; role: UserRole }, familyId: string) {
    const jti = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_S;
    const token = await new SignJWT({ role: user.role, fid: familyId })
      .setProtectedHeader({ alg: JWT_ALGORITHM, kid: this.kid, typ: 'JWT' })
      .setSubject(user.id)
      .setJti(jti)
      .setIssuedAt()
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime(exp)
      .sign(this.privateKey);
    return { token, jti, exp };
  }

  async verify(token: string): Promise<AccessClaims> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new TokenError('malformed token');
    }
    const key = kid ? this.keyring.get(kid) : undefined;
    if (!key) throw new TokenError(`unknown signing key ${kid ?? '(no kid)'}`);
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.fid !== 'string' ||
        typeof payload.role !== 'string' ||
        typeof payload.exp !== 'number'
      ) {
        throw new TokenError('token is missing required claims');
      }
      return {
        sub: payload.sub,
        role: payload.role as UserRole,
        fid: payload.fid,
        jti: payload.jti,
        exp: payload.exp,
      };
    } catch (err) {
      throw new TokenError(
        err instanceof TokenError ? err.message : 'invalid token',
      );
    }
  }
}
