// src/common/interceptors/fastify-file.interceptor.ts
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
 * Equivalente Fastify do `FileInterceptor` do @nestjs/platform-express.
 *
 * O @nestjs/platform-fastify não fornece FileInterceptor, então este interceptor
 * consome a requisição multipart com @fastify/multipart e reproduz o mesmo contrato
 * do Multer com `memoryStorage()`:
 *
 *  - o arquivo do campo `fieldName` é bufferizado em memória e exposto em `req.file`,
 *    que é o que o decorator `@UploadedFile()` lê;
 *  - os demais campos (texto) são colocados em `req.body`, que é o que `@Body()` lê,
 *    com campos repetidos virando array (mesmo comportamento do Multer).
 *
 * Como interceptors rodam antes dos pipes, o ValidationPipe/DTO continua recebendo
 * o body já montado.
 */
export function FastifyFileInterceptor(fieldName: string): Type<NestInterceptor> {
  @Injectable()
  class MixinFastifyFileInterceptor implements NestInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<any>> {
      const req = context.switchToHttp().getRequest<FastifyRequest>();

      // O @fastify/multipart decora a request com um MÉTODO `file()`. Sem zerar isso,
      // o @UploadedFile() devolveria essa função em requisições não-multipart, enquanto
      // o Multer devolvia undefined. Zeramos sempre para preservar o contrato anterior.
      (req as any).file = undefined;

      // Requisição não-multipart segue o fluxo normal (paridade com o FileInterceptor).
      if (typeof req.isMultipart !== 'function' || !req.isMultipart()) {
        return next.handle();
      }

      const body: Record<string, any> = { ...((req.body as Record<string, any>) ?? {}) };
      let file: UploadedFileData | undefined;

      const appendField = (name: string, value: unknown) => {
        if (body[name] === undefined) body[name] = value;
        else if (Array.isArray(body[name])) body[name].push(value);
        else body[name] = [body[name], value];
      };

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === fieldName && !file) {
              const buffer = await part.toBuffer();
              file = {
                fieldname: part.fieldname,
                originalname: part.filename,
                encoding: part.encoding,
                mimetype: part.mimetype,
                buffer,
                size: buffer.length,
              };
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
      (req as any).file = file;

      return next.handle();
    }
  }

  return mixin(MixinFastifyFileInterceptor);
}
