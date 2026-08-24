import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { Test } from '@nestjs/testing';
import { FastifyFileInterceptor } from './fastify-file.interceptor';
import type { UploadedFileData } from '../types/uploaded-file';

@Controller('t')
class TmpController {
  @Post('upload')
  @UseInterceptors(FastifyFileInterceptor('imagem'))
  upload(@Body() body: any, @UploadedFile() file?: UploadedFileData) {
    return {
      body,
      file: file
        ? {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            content: file.buffer.toString('utf8'),
            isBuffer: Buffer.isBuffer(file.buffer),
          }
        : null,
    };
  }
}

describe('FastifyFileInterceptor', () => {
  let app: NestFastifyApplication;
  let base: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [TmpController] }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: 25 * 1024 * 1024 }));
    await app.register(multipart as any, { limits: { fileSize: 25 * 1024 * 1024 } });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }, 30000);

  afterAll(async () => { await app.close(); });

  it('bufferiza o arquivo e monta o body (paridade com multer memoryStorage)', async () => {
    const fd = new FormData();
    fd.append('nome_vendedor', 'Fulano');
    fd.append('carro', 'Gol');
    fd.append('ano', '2020');
    fd.append('pecas', 'farol');
    fd.append('pecas', 'retrovisor');
    fd.append('imagem', new Blob(['conteudo-da-imagem'], { type: 'image/png' }), 'foto.png');

    const res = await fetch(`${base}/t/upload`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const json: any = await res.json();

    expect(json.body.nome_vendedor).toBe('Fulano');
    expect(json.body.carro).toBe('Gol');
    expect(json.body.ano).toBe('2020');
    expect(json.body.pecas).toEqual(['farol', 'retrovisor']); // campo repetido vira array
    expect(json.body.imagem).toBeUndefined();                 // arquivo NAO vaza no body
    expect(json.file).toEqual({
      fieldname: 'imagem',
      originalname: 'foto.png',
      mimetype: 'image/png',
      size: 18,
      content: 'conteudo-da-imagem',
      isBuffer: true,
    });
  });

  it('multipart sem arquivo -> file undefined, body preenchido', async () => {
    const fd = new FormData();
    fd.append('carro', 'Onix');
    const res = await fetch(`${base}/t/upload`, { method: 'POST', body: fd });
    const json: any = await res.json();
    expect(json.file).toBeNull();
    expect(json.body.carro).toBe('Onix');
  });

  it('requisicao JSON comum passa direto pelo interceptor', async () => {
    const res = await fetch(`${base}/t/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ carro: 'Palio' }),
    });
    const json: any = await res.json();
    expect(json.body).toEqual({ carro: 'Palio' });
    expect(json.file).toBeNull();
  });

  it('arquivo em campo diferente e ignorado (drenado) sem travar', async () => {
    const fd = new FormData();
    fd.append('outro', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    fd.append('carro', 'Uno');
    const res = await fetch(`${base}/t/upload`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const json: any = await res.json();
    expect(json.file).toBeNull();
    expect(json.body.carro).toBe('Uno');
  });
});
