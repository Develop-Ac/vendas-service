// src/common/interceptors/fastify-files.interceptor.ts
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
  mixin,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { UploadedFileData } from '../types/uploaded-file';

/**
 * Equivalente Fastify do `FilesInterceptor` do @nestjs/platform-express, para múltiplos
 * arquivos no mesmo campo (ex.: `anexos`). Mesma lógica do FastifyFileInterceptor, mas
 * empilha todos os arquivos do campo em `req.files` (o que `@UploadedFiles()` lê) em vez
 * de manter só o primeiro.
 */
export function FastifyFilesInterceptor(fieldName: string): Type<NestInterceptor> {
  @Injectable()
  class MixinFastifyFilesInterceptor implements NestInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<any>> {
      const req = context.switchToHttp().getRequest<FastifyRequest>();

      (req as any).files = [];

      if (typeof req.isMultipart !== 'function' || !req.isMultipart()) {
        return next.handle();
      }

      const body: Record<string, any> = { ...((req.body as Record<string, any>) ?? {}) };
      const files: UploadedFileData[] = [];

      const appendField = (name: string, value: unknown) => {
        if (body[name] === undefined) body[name] = value;
        else if (Array.isArray(body[name])) body[name].push(value);
        else body[name] = [body[name], value];
      };

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === fieldName) {
              const buffer = await part.toBuffer();
              files.push({
                fieldname: part.fieldname,
                originalname: part.filename,
                encoding: part.encoding,
                mimetype: part.mimetype,
                buffer,
                size: buffer.length,
              });
            } else {
              // Drena arquivos de outros campos para não travar o stream.
              await part.toBuffer();
            }
          } else {
            appendField(part.fieldname, part.value);
          }
        }
      } catch (err: any) {
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new PayloadTooLargeException('Arquivo excede o tamanho máximo permitido.');
        }
        if (err?.code?.startsWith?.('FST_')) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      req.body = body;
      (req as any).files = files;

      return next.handle();
    }
  }

  return mixin(MixinFastifyFilesInterceptor);
}
