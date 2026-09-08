import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ValidatorError {
  status?: number;
  message?: string;
  errors?: { path: string; message: string }[];
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'Unexpected error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      detail = exception.message;
    } else if (isValidatorError(exception)) {
      status = exception.status ?? status;
      detail = exception.message ?? detail;
    }

    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: `https://marketplace.example/problems/${status}`,
        title: TITLES[status] ?? 'Error',
        status,
        detail,
        instance: req.originalUrl,
      });
  }
}

function isValidatorError(e: unknown): e is ValidatorError {
  return typeof e === 'object' && e !== null && 'status' in e && 'errors' in e;
}
