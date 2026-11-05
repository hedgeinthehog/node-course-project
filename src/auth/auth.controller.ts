import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService, TokenPair } from './auth.service';
import { CurrentUser, Public } from './decorators';
import type { Principal } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { email: string; password: string }): Promise<TokenPair> {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refresh_token: string }): Promise<TokenPair> {
    return this.auth.refresh(body.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  logout(@CurrentUser() user: Principal): Promise<void> {
    return this.auth.logout(user);
  }
}
