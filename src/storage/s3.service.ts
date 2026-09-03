// src/storage/s3.service.ts
import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand, // apenas para consistência, não é obrigatório pro presign
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import * as http from 'http';
import * as https from 'https';
import { UploadedFileData } from '../common/types/uploaded-file';

type S3Opts = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketDefault: string;
  forcePathStyle?: boolean;
  tlsInsecure?: boolean;
};

@Injectable()
export class S3Service {
  private client: S3Client;
  private bucketDefault: string;
  private readonly endpoint: string;
  private readonly tlsInsecure: boolean;
  /**
   * URL pré-assinada é validada pelo relógio do próprio MinIO. O @aws-sdk/s3-request-presigner
   * desta versão não lê `systemClockOffset` (só o client "direto" faz isso, e mesmo assim só
   * reage depois de já levar um erro). Então, se a VM que roda essa API estiver com o relógio
   * atrasado em relação ao MinIO, a URL nasce assinada com uma data "no passado" e o
   * `X-Amz-Expires` (contado a partir dessa data) se esgota antes mesmo de chegar no usuário.
   * A saída é medir esse desvio uma vez no startup (via header Date de uma resposta do MinIO)
   * e somá-lo ao `expiresIn` pedido, pra a janela de validade real bater com o TTL desejado.
   */
  private clockOffsetMs = 0;
  private clockOffsetReady: Promise<void>;

  constructor() {
    const opts: S3Opts = {
      endpoint: process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || 'http://localhost:9000',
      region: process.env.S3_REGION || 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY || process.env.MINIO_ROOT_USER || 'admin',
      secretAccessKey: process.env.S3_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || 'password',
      bucketDefault: process.env.S3_BUCKET_DEFAULT || process.env.S3_BUCKET_AVARIAS || 'avarias',
      forcePathStyle: true,
      tlsInsecure: ['1', 'true', 'yes'].includes(String(process.env.S3_TLS_INSECURE || '').toLowerCase()),
    };

    const isHttps = opts.endpoint.startsWith('https://');
    const handler = isHttps && opts.tlsInsecure
      ? new NodeHttpHandler({
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        })
      : undefined;

    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      ...(handler ? { requestHandler: handler } : {}),
    });

    this.bucketDefault = opts.bucketDefault;
    this.endpoint = opts.endpoint;
    this.tlsInsecure = !!opts.tlsInsecure;
    this.clockOffsetReady = this.syncClockOffset();
  }

  /** Mede o desvio (servidor - local) lendo o header `Date` do MinIO. Nunca lança. */
  private syncClockOffset(): Promise<void> {
    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(this.endpoint);
      } catch {
        return resolve();
      }

      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: '/',
          method: 'HEAD',
          timeout: 3000,
          ...(url.protocol === 'https:' ? { rejectUnauthorized: !this.tlsInsecure } : {}),
        },
        (res) => {
          const serverDate = res.headers['date'];
          if (typeof serverDate === 'string') {
            const offsetMs = new Date(serverDate).getTime() - Date.now();
            if (Number.isFinite(offsetMs)) {
              this.clockOffsetMs = offsetMs;
            }
          }
          res.resume();
          resolve();
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.on('error', () => resolve());
      req.end();
    });
  }

  getDefaultBucket() {
    return this.bucketDefault;
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Blob | string,
    contentType = 'application/octet-stream',
    bucket = 'venda-casada',
  ): Promise<void> { 
    const v = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body as any,
        ContentType: contentType
      });

    await this.client.send( v );
  }

  /**
   * Verifica existência (lança erro se não existir).
   */
  async headObject(key: string, bucket = this.bucketDefault): Promise<void> {
    await this.client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  }

  /**
   * URL pré-assinada para GET
   */
  async getPresignedGetUrl(
    key: string,
    expiresSeconds = 3600,
    bucket = this.bucketDefault,
  ): Promise<string> {
    await this.clockOffsetReady;

    // valida se o objeto existe — se não existir, HeadObject lança
    await this.headObject(key, bucket);

    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    // se o relógio local estiver atrasado em relação ao MinIO, a URL é assinada com uma
    // data "no passado" do ponto de vista do servidor — compensa alongando o expiresIn.
    const atrasoSegundos = Math.max(0, Math.ceil(this.clockOffsetMs / 1000));
    const url = await getSignedUrl(this.client, cmd, {
      expiresIn: expiresSeconds + atrasoSegundos,
    });
    return url;
  }

  async getObjectBuffer(key: string, bucket = this.bucketDefault): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    if (!out.Body) {
      throw new Error('Objeto sem conteúdo');
    }

    const body: any = out.Body;
    if (typeof body.transformToByteArray === 'function') {
      const bytes = await body.transformToByteArray();
      return Buffer.from(bytes);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Métodos adicionais para compatibilidade com os testes
  async uploadFile(file: UploadedFileData, prefix: string = ''): Promise<any> {
    const key = `${prefix}${file.originalname}`;
    await this.putObject(key, file.buffer, file.mimetype);
    return {
      Key: key,
      Location: `${this.bucketDefault}/${key}`,
      Bucket: this.bucketDefault,
    };
  }

  async deleteFile(key: string, bucket = this.bucketDefault): Promise<any> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const result = await this.client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return result;
  }

  async getSignedUrl(key: string, expiresIn?: number): Promise<string> {
    return this.getPresignedGetUrl(key, expiresIn);
  }

  async listFiles(prefix: string = '', bucket = this.bucketDefault): Promise<any[]> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      }),
    );
    return result.Contents || [];
  }
}
