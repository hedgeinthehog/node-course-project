import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { SessionMiddleware } from './session.middleware';
import { SessionsController } from './sessions.controller';

@Module({
  imports: [RedisModule],
  controllers: [SessionsController],
})
export class SessionsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}
