import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators';
import { FilesService } from './files.service';
import type { UploadIntentDto } from './files.service';

@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads/intent')
  @HttpCode(200)
  async intent(
    @Headers('idempotency-key') key: string,
    @Body() dto: UploadIntentDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: Principal,
  ) {
    const { result, replayed } = await this.files.intent(key, dto, user);
    if (replayed) res.setHeader('Idempotency-Replay', 'true');
    return result;
  }

  @Get('uploads/:id/parts')
  parts(@Param('id') id: string, @CurrentUser() user: Principal) {
    return this.files.parts(id, user);
  }

  @Post('uploads/:id/commit')
  @HttpCode(200)
  commit(@Param('id') id: string, @CurrentUser() user: Principal) {
    return this.files.commit(id, user);
  }

  @Get('files/:id')
  async download(
    @Param('id') id: string,
    @CurrentUser() user: Principal,
    @Res() res: Response,
  ) {
    const url = await this.files.downloadUrl(id, user);
    res.status(302).setHeader('Location', url).end();
  }
}
