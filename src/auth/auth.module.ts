import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Env } from '../config/env.schema';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AccessTokens } from './jwt';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AccessTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const tokens = AccessTokens.fromBase64(
          config.get('JWT_PRIVATE_KEY', { infer: true }),
          config.get('JWT_PUBLIC_KEY', { infer: true }),
          config.get('JWT_KID', { infer: true }),
        );
        new Logger(AccessTokens.name).log(
          `signing key kid=${tokens.kid} fingerprint=${tokens.fingerprint()}`,
        );
        return tokens;
      },
    },
    {
      provide: AuthService,
      inject: [DataSource, AccessTokens, ConfigService],
      useFactory: (
        dataSource: DataSource,
        tokens: AccessTokens,
        config: ConfigService<Env, true>,
      ) =>
        new AuthService(
          dataSource,
          tokens,
          config.get('REFRESH_TOKEN_PEPPER', { infer: true }),
        ),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AccessTokens],
})
export class AuthModule {}
