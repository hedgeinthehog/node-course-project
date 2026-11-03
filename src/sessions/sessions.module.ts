import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SessionMiddleware } from './session.middleware';
import { SessionsController } from './sessions.controller';

@Module({
  imports: [RedisModule, AuthModule],
  controllers: [SessionsController],
})
export class SessionsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}
